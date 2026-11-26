/** The resource (RFC 8707) flags control planes answer for: the `aud` of tenant tokens. */
export const FLAGS_RESOURCE = 'urn:agora:flags';

/** What each control-plane endpoint requires in the token's `capabilities`. */
export const TENANT_SCOPES = {
  rulesetRead: 'flags:ruleset:read',
  eventsWrite: 'flags:events:write',
  declarationsWrite: 'flags:declarations:write',
  ofrepEvaluate: 'flags:ofrep:evaluate',
} as const;

/**
 * What a federated console's token (token mode of `consoleCommands`) must hold for each kind of
 * command it sends an app: `read` for the app's profile, experiment results and ops; `write` for
 * every change; `approve` to approve or reject a change request. `flags:console:*` grants all three.
 */
export const CONSOLE_SCOPES = {
  read: 'flags:console:read',
  write: 'flags:console:write',
  approve: 'flags:console:approve',
} as const;

/**
 * The bearer token a tenant presents to the control-plane (`tenant.token`): a fixed secret, a
 * function returning a token (`authkitTenantToken(...)` from `@adonis-agora/authkit-client`), or an
 * object with `get()`.
 */
export type TenantTokenSource =
  | string
  | (() => Promise<string>)
  | { get(): Promise<string>; invalidate?(): void };

/** @internal What the wire layer uses: a getter, plus a way to drop a cached token after a 401. */
export interface TokenSource {
  get(): Promise<string>;
  /** Drops a cached token (after a 401), so the next `get` fetches a fresh one. */
  invalidate?(): void;
}

/** @internal Normalizes every `tenant.token` form. */
export function resolveTenantToken(option: TenantTokenSource): TokenSource {
  if (typeof option === 'string') {
    if (!option) throw new TypeError('[flags] tenant.token must not be empty');
    return { get: async () => option };
  }
  if (typeof option === 'function') {
    // `authkitTenantToken` caches its token and exposes `reset()` to drop it.
    const reset = (option as { reset?: unknown }).reset;
    return {
      get: () => option(),
      ...(typeof reset === 'function' ? { invalidate: () => reset.call(option) } : {}),
    };
  }
  if (option && typeof option === 'object' && typeof option.get === 'function') {
    return {
      get: () => option.get(),
      ...(typeof option.invalidate === 'function'
        ? { invalidate: () => option.invalidate!() }
        : {}),
    };
  }
  throw new TypeError(
    '[flags] tenant.token must be a string, a function returning a token, or an object with get()',
  );
}
