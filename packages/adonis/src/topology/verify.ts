import { timingSafeEqual } from 'node:crypto';
import type { Subject } from '../subject.js';
import { TENANT_SCOPES } from './token.js';

/**
 * What a control-plane trusts about a request: derived from the token, never from the body. Same
 * shape as `@adonis-agora/durable`'s `VerifiedTenant`, so one verifier can serve both.
 */
export interface VerifiedTenant {
  /** The tenant's partition (its app name). */
  tenant: string;
  /** Scopes granted (see `TENANT_SCOPES`). */
  capabilities?: string[] | undefined;
  /** The environment whose ruleset this tenant reads. Default: the control-plane's. */
  environment?: string;
  /** Epoch ms after which streams opened with this token must close. */
  expiresAt?: number;
}

export type TenantVerifier = (input: {
  token?: string | undefined;
  tenant?: string | undefined;
}) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

export interface SharedSecretTenant {
  secret: string;
  environment?: string;
  /** Default: every tenant scope. */
  capabilities?: string[];
}

export interface AuthkitVerifierOptions {
  /** The authkit-server issuer (the `iss` claim). */
  issuer: string;
  /** Its JWKS URI. Default `<issuer>/.well-known/jwks.json`. */
  jwksUri?: string;
  /** Expected `aud`. Default `flags`. */
  audience?: string | string[];
  /** Claim holding the partition. Default `client_id`. */
  partitionClaim?: string;
  /** Partition → environment, when tenants read different environments. */
  environments?: Record<string, string>;
  /** Accept tokens without RFC 9068's `typ: at+jwt`. Default false. */
  allowAnyTyp?: boolean;
  /** @internal Also return the verified claims (used by the browser verifier). */
  claims?: boolean;
}

const ALL_SCOPES = Object.values(TENANT_SCOPES);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const verifiers = {
  /**
   * One secret per tenant, compared in constant time. The request names its partition with the
   * `x-flags-tenant` header; the secret proves it.
   */
  sharedSecret(tenants: Record<string, string | SharedSecretTenant>): TenantVerifier {
    return ({ token, tenant }) => {
      if (!token || !tenant) return null;
      const entry = tenants[tenant];
      if (entry === undefined) return null;
      const config = typeof entry === 'string' ? { secret: entry } : entry;
      if (!sameSecret(token, config.secret)) return null;
      return {
        tenant,
        capabilities: config.capabilities ?? [...ALL_SCOPES],
        ...(config.environment ? { environment: config.environment } : {}),
      };
    };
  },

  /**
   * JWT access tokens issued by authkit-server (`client_credentials`), verified locally against its
   * JWKS through `@adonis-agora/authkit-client` (optional peer). The partition comes from the
   * token's `client_id` claim and the capabilities from its `scope`.
   */
  authkit(options: AuthkitVerifierOptions): TenantVerifier {
    const issuer = options.issuer.replace(/\/$/, '');
    let verify:
      | ((token: string, opts: Record<string, unknown>) => Promise<Record<string, unknown>>)
      | undefined;
    return async ({ token }) => {
      if (!token) return null;
      if (!verify) {
        try {
          const mod = (await import('@adonis-agora/authkit-client')) as unknown as {
            verifyJwtAccessToken: typeof verify;
          };
          verify = mod.verifyJwtAccessToken;
        } catch {
          throw new Error(
            '@adonis-agora/flags: verifiers.authkit() needs "@adonis-agora/authkit-client". Install it, or use verifiers.sharedSecret().',
          );
        }
      }
      let claims: Record<string, unknown>;
      try {
        claims = await verify!(token, {
          issuer: options.issuer,
          jwksUri: options.jwksUri ?? `${issuer}/.well-known/jwks.json`,
          audience: options.audience ?? 'flags',
          ...(options.allowAnyTyp ? { allowAnyTyp: true } : {}),
        });
      } catch {
        return null;
      }
      const partition = claims[options.partitionClaim ?? 'client_id'];
      if (typeof partition !== 'string' || partition.length === 0) return null;
      const scope =
        typeof claims.scope === 'string' ? claims.scope.split(/\s+/).filter(Boolean) : [];
      const environment = options.environments?.[partition];
      return {
        tenant: partition,
        ...(options.claims ? { claims } : {}),
        capabilities: scope,
        ...(environment ? { environment } : {}),
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp * 1000 } : {}),
      };
    };
  },
};

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
  issuer: string;
  jwksUri?: string;
  /** Expected `aud` of the user's access token (your API / the flags server). */
  audience: string | string[];
  /** Partition → environment, keyed by the token's `client_id` (the app the user signed into). */
  environments?: Record<string, string>;
  allowAnyTyp?: boolean;
}

export const userVerifiers = {
  /**
   * An authkit access token held by the client itself — a mobile app or SPA that signs in with
   * PKCE — verified against the issuer's JWKS. Browsers of an Adonis app with a session use the
   * app's token endpoint instead (`browser` in `config/flags.ts`). The
   * subject is the `sub` claim — the same person in every app — and `email`, `roles`/`global_roles`
   * and the `org_*` claims become trusted targeting attributes.
   */
  authkit(options: AuthkitUserVerifierOptions): UserVerifier {
    const tenant = verifiers.authkit({
      issuer: options.issuer,
      audience: options.audience,
      partitionClaim: 'sub',
      ...(options.jwksUri ? { jwksUri: options.jwksUri } : {}),
      ...(options.allowAnyTyp ? { allowAnyTyp: true } : {}),
      claims: true,
    } as AuthkitVerifierOptions);
    return async ({ token }) => {
      const verified = (await tenant({ token })) as
        | (VerifiedTenant & { claims?: Record<string, unknown> })
        | null;
      if (!verified?.claims) return null;
      const claims = verified.claims;
      const attributes: Record<string, unknown> = {};
      const email = typeof claims.email === 'string' ? claims.email : undefined;
      if (email) {
        attributes.email = email;
        attributes.emailDomain = email.split('@')[1]?.toLowerCase();
      }
      const roles = claims.global_roles ?? claims.roles;
      if (Array.isArray(roles)) attributes.globalRoles = roles.map(String);
      for (const [claim, attribute] of [
        ['org_id', 'orgId'],
        ['org_slug', 'orgSlug'],
        ['org_role', 'orgRole'],
      ] as const) {
        if (typeof claims[claim] === 'string') attributes[attribute] = claims[claim];
      }
      const clientId = typeof claims.client_id === 'string' ? claims.client_id : undefined;
      const environment = clientId ? options.environments?.[clientId] : undefined;
      return {
        subject: { id: verified.tenant, type: 'user', attributes },
        ...(environment ? { environment } : {}),
        ...(clientId ? { app: clientId } : {}),
        ...(verified.expiresAt ? { expiresAt: verified.expiresAt } : {}),
      };
    };
  },
};
