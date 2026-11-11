import { createHmac, timingSafeEqual } from 'node:crypto';
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
  subject: Subject;
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

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * A short-lived, HMAC-signed evaluation context, minted by your app's backend for its frontend when
 * there is no authkit token to hand over:
 *
 * ```ts
 * // a controller of the app
 * const flagsToken = signFlagsContext({ id: user.id, attributes: { plan: user.plan } }, { secret: env.get('FLAGS_BROWSER_SECRET') })
 * ```
 *
 * The control-plane verifies it with `verifiers.signedContext({ secret })`. The browser can read
 * it but cannot change it.
 */
export function signFlagsContext(
  subject: Subject,
  options: { secret: string; ttlSeconds?: number; environment?: string; app?: string },
): string {
  const payload = {
    sub: String(subject.id),
    ...(subject.type ? { typ: subject.type } : {}),
    ...(subject.attributes ? { attrs: subject.attributes } : {}),
    ...(options.environment ? { env: options.environment } : {}),
    ...(options.app ? { app: options.app } : {}),
    exp: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 3600),
  };
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', options.secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export const userVerifiers = {
  /**
   * The signed-in user's authkit access token (a JWT verified against the issuer's JWKS). The
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

  /** Contexts minted by your app's backend with {@link signFlagsContext}. */
  signedContext(options: { secret: string }): UserVerifier {
    return ({ token }) => {
      if (!token) return null;
      const [body, signature] = token.split('.');
      if (!body || !signature) return null;
      const expected = createHmac('sha256', options.secret).update(body).digest('base64url');
      if (!sameSecret(signature, expected)) return null;
      let payload: {
        sub?: unknown;
        typ?: unknown;
        attrs?: unknown;
        env?: unknown;
        app?: unknown;
        exp?: unknown;
      };
      try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      } catch {
        return null;
      }
      if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
      if (payload.exp * 1000 < Date.now()) return null;
      const attributes =
        payload.attrs && typeof payload.attrs === 'object' && !Array.isArray(payload.attrs)
          ? (payload.attrs as Record<string, unknown>)
          : undefined;
      return {
        subject: {
          id: payload.sub,
          ...(typeof payload.typ === 'string' ? { type: payload.typ } : {}),
          ...(attributes ? { attributes } : {}),
        },
        ...(typeof payload.env === 'string' ? { environment: payload.env } : {}),
        ...(typeof payload.app === 'string' ? { app: payload.app } : {}),
        expiresAt: payload.exp * 1000,
      };
    };
  },
};
