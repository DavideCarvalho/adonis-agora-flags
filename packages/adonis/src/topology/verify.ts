import { timingSafeEqual } from 'node:crypto';
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
        capabilities: scope,
        ...(environment ? { environment } : {}),
        ...(typeof claims.exp === 'number' ? { expiresAt: claims.exp * 1000 } : {}),
      };
    };
  },
};
