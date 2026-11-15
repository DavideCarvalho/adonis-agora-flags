import { timingSafeEqual } from 'node:crypto';
import type { Subject } from '../subject.js';
import { TENANT_SCOPES } from './token.js';

/** What a control-plane hands to `verifyTenant`. Only `token` is trusted, once verified. */
export interface TenantVerifierRequest {
  /** The bearer token the tenant presented. */
  token?: string | undefined;
  /** The partition the request claims to be (`x-flags-tenant`). Advisory only: the token decides. */
  partition?: string | undefined;
  /** Same as `partition`. Advisory only. */
  tenant?: string | undefined;
}

/**
 * What a control-plane trusts about a request: derived from the token, never from the request.
 * The shape every Agora control plane uses (`authkitTenantVerifier` from
 * `@adonis-agora/authkit-client` returns it).
 */
export interface VerifiedTenant {
  /** The tenant's partition (its app name). */
  partition: string;
  /** The environment whose ruleset this tenant reads. Default: the control-plane's. */
  environment?: string | undefined;
  /** What the token may do (see `TENANT_SCOPES`); checked on every endpoint. */
  capabilities: string[];
  /** Epoch ms after which streams opened with this token close. */
  expiresAt?: number | undefined;
}

/** The function form of `verifyTenant`. */
export type TenantVerifier = (
  request: TenantVerifierRequest,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/** The class form of `verifyTenant`. */
export interface TenantVerifierContract {
  verify(request: TenantVerifierRequest): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

type VerifierClass = new (...args: never[]) => TenantVerifierContract;

/**
 * `verifyTenant` in `config/flags.ts`: a function, an object with `verify` (a class instance), or a
 * lazy import of a module whose default export is such a class or object
 * (`() => import('#tenants/verifier')`).
 */
export type TenantVerifierOption =
  | TenantVerifier
  | TenantVerifierContract
  | VerifierClass
  | (() => Promise<{ default: TenantVerifierContract | VerifierClass }>);

/** Builds a class-form verifier (the provider passes the container's `make`). */
export type VerifierMaker = (
  cls: VerifierClass,
) => TenantVerifierContract | Promise<TenantVerifierContract>;

const hasVerify = (value: unknown): value is TenantVerifierContract =>
  !!value &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof (value as { verify?: unknown }).verify === 'function';

const isVerifierClass = (value: unknown): value is VerifierClass =>
  typeof value === 'function' &&
  typeof (value as { prototype?: { verify?: unknown } }).prototype?.verify === 'function';

/**
 * A verifier's answer, checked: `null` refuses, `{ partition, capabilities }` accepts, anything
 * else throws, so a malformed result is never taken for an accepted tenant.
 */
function checkVerified(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const r = result as Partial<VerifiedTenant> & { tenant?: unknown };
  if (
    typeof result === 'object' &&
    typeof r.partition === 'string' &&
    r.partition.length > 0 &&
    Array.isArray(r.capabilities) &&
    r.capabilities.every((c) => typeof c === 'string') &&
    (r.environment === undefined || typeof r.environment === 'string')
  ) {
    return r as VerifiedTenant;
  }
  throw new TypeError(
    `[flags] verifyTenant must return { partition: string, environment?: string, capabilities: string[] } or null${
      r && typeof result === 'object' && 'tenant' in r
        ? ' (it returned `tenant`; rename it to `partition`)'
        : ''
    }`,
  );
}

function construct(cls: VerifierClass): TenantVerifierContract {
  return new (cls as new () => TenantVerifierContract)();
}

/** @internal Turns any `verifyTenant` form into the function the control-plane calls. */
export function resolveTenantVerifier(
  option: TenantVerifierOption,
  make: VerifierMaker = construct,
): (request: TenantVerifierRequest) => Promise<VerifiedTenant | null> {
  // A class first: a class is also a function.
  if (isVerifierClass(option)) {
    let instance: Promise<TenantVerifierContract> | undefined;
    return async (request) => {
      instance ??= Promise.resolve(make(option));
      return checkVerified(await (await instance).verify(request));
    };
  }
  if (hasVerify(option)) {
    return async (request) => checkVerified(await option.verify(request));
  }
  if (typeof option !== 'function') {
    throw new TypeError(
      '[flags] verifyTenant must be a function, an object with verify() (a class instance), or a lazy import of one',
    );
  }
  const fn = option as (request: TenantVerifierRequest) => unknown;
  let lazy: Promise<TenantVerifierContract> | undefined;
  return async (request) => {
    if (lazy) return checkVerified(await (await lazy).verify(request));
    const result = await fn(request);
    const exported =
      result && typeof result === 'object' && 'default' in result
        ? (result as { default: unknown }).default
        : undefined;
    if (isVerifierClass(exported)) {
      lazy ??= Promise.resolve(make(exported));
      return checkVerified(await (await lazy).verify(request));
    }
    if (hasVerify(exported)) {
      lazy ??= Promise.resolve(exported);
      return checkVerified(await (await lazy).verify(request));
    }
    if (exported !== undefined) {
      throw new TypeError(
        '[flags] the module imported by verifyTenant must default-export a class or object with verify()',
      );
    }
    return checkVerified(result);
  };
}

export interface SharedSecretPartition {
  secret: string;
  environment?: string;
  /** Default: every tenant capability (`TENANT_SCOPES`). */
  capabilities?: string[];
}

export interface SharedSecretVerifierOptions {
  /** Partition → its secret (or `{ secret, environment?, capabilities? }`). */
  partitions: Record<string, string | SharedSecretPartition>;
}

const ALL_SCOPES = Object.values(TENANT_SCOPES);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Tenant auth without an identity provider: one secret per partition, compared in constant time.
 * The tenant names its partition (`x-flags-tenant`, sent from `tenant.partition`); the secret
 * proves it.
 */
export function sharedSecretVerifier(options: SharedSecretVerifierOptions): TenantVerifier {
  if (!options || typeof options.partitions !== 'object' || options.partitions === null) {
    throw new TypeError('[flags] sharedSecretVerifier({ partitions }) needs a partitions map');
  }
  const partitions = new Map(Object.entries(options.partitions));
  return ({ token, partition, tenant }) => {
    const name = partition ?? tenant;
    if (!token || !name) return null;
    const entry = partitions.get(name);
    if (entry === undefined) return null;
    const config = typeof entry === 'string' ? { secret: entry } : entry;
    if (!config.secret || !sameSecret(token, config.secret)) return null;
    return {
      partition: name,
      capabilities: [...(config.capabilities ?? ALL_SCOPES)],
      ...(config.environment ? { environment: config.environment } : {}),
    };
  };
}

/** A browser's verified identity: who is evaluating, from a token the browser cannot forge. */
export interface VerifiedUser {
  /** Absent for anonymous visitors: they get static values only (no targeting key). */
  subject?: Subject;
  /** The environment whose ruleset applies. Default: the control-plane's. */
  environment?: string;
  /** The app the browser belongs to (stamped on its events). Default `browser`. */
  app?: string;
  /** Epoch ms after which streams opened with this token close. */
  expiresAt?: number;
}

export type UserVerifier = (input: {
  token?: string | undefined;
}) => VerifiedUser | null | Promise<VerifiedUser | null>;

export interface AuthkitUserVerifierOptions {
  /** The authkit issuer. Its keys come from `{issuer}/.well-known/openid-configuration`. */
  issuer: string;
  /** Expected `aud` of the user's access token (the resource URL of the flags server). */
  audience: string | string[];
  /** Partition → environment, keyed by the token's `client_id` (the app the user signed into). */
  environments?: Record<string, string>;
  /** Claim holding the global roles. Default `roles`. */
  globalRolesClaim?: string;
  allowAnyTyp?: boolean;
  /** Passed to authkit-client's discovery (custom `fetchImpl`, cache TTL). */
  discovery?: Record<string, unknown>;
}

interface AuthkitIdentity {
  userId: string;
  email: string;
  globalRoles: string[];
  orgId?: string | undefined;
  orgSlug?: string | undefined;
  orgRole?: string | undefined;
  expiresAt: number;
  raw?: Record<string, unknown>;
}

type IdentityFromAccessToken = (
  token: string,
  options: Record<string, unknown>,
) => Promise<AuthkitIdentity | null>;

let identityFromAccessToken: Promise<IdentityFromAccessToken> | undefined;

function loadIdentityFromAccessToken(): Promise<IdentityFromAccessToken> {
  identityFromAccessToken ??= import('@adonis-agora/authkit-client')
    .catch(() => {
      throw new Error(
        '@adonis-agora/flags: userVerifiers.authkit() needs "@adonis-agora/authkit-client". Install it.',
      );
    })
    .then((mod) => {
      const fn = (mod as { identityFromAccessToken?: unknown }).identityFromAccessToken;
      if (typeof fn !== 'function') {
        throw new Error(
          '@adonis-agora/flags: userVerifiers.authkit() needs @adonis-agora/authkit-client >= 1.0.0-rc.7 (identityFromAccessToken).',
        );
      }
      return fn as IdentityFromAccessToken;
    });
  identityFromAccessToken.catch(() => {
    identityFromAccessToken = undefined;
  });
  return identityFromAccessToken;
}

export const userVerifiers = {
  /**
   * An authkit access token held by the client itself — a mobile app or SPA that signs in with
   * PKCE — verified with `identityFromAccessToken` from `@adonis-agora/authkit-client` (keys found
   * by discovery). Browsers of an Adonis app with a session use the app's token endpoint instead
   * (`browser` in `config/flags.ts`). The subject is the `sub` claim — the same person in every
   * app — and email, global roles and the active organization become trusted targeting attributes.
   */
  authkit(options: AuthkitUserVerifierOptions): UserVerifier {
    return async ({ token }) => {
      if (!token) return null;
      const verify = await loadIdentityFromAccessToken();
      const identity = await verify(token, {
        issuer: options.issuer,
        audience: options.audience,
        ...(options.globalRolesClaim ? { globalRolesClaim: options.globalRolesClaim } : {}),
        ...(options.allowAnyTyp ? { allowAnyTyp: true } : {}),
        ...(options.discovery ? { discovery: options.discovery } : {}),
      });
      if (!identity?.userId) return null;
      const attributes: Record<string, unknown> = {};
      if (identity.email) {
        attributes.email = identity.email;
        attributes.emailDomain = identity.email.split('@')[1]?.toLowerCase();
      }
      if (identity.globalRoles.length) attributes.globalRoles = identity.globalRoles.map(String);
      if (identity.orgId) attributes.orgId = identity.orgId;
      if (identity.orgSlug) attributes.orgSlug = identity.orgSlug;
      if (identity.orgRole) attributes.orgRole = identity.orgRole;
      const clientId =
        typeof identity.raw?.client_id === 'string' ? identity.raw.client_id : undefined;
      const environment = clientId ? options.environments?.[clientId] : undefined;
      return {
        subject: { id: identity.userId, type: 'user', attributes },
        ...(environment ? { environment } : {}),
        ...(clientId ? { app: clientId } : {}),
        ...(identity.expiresAt ? { expiresAt: identity.expiresAt } : {}),
      };
    };
  },
};
