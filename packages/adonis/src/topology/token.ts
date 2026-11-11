/** Where a tenant gets the bearer token it presents to the control-plane. */
export interface TokenSource {
  get(): Promise<string>;
  /** Drops a cached token (after a 401), so the next `get` fetches a fresh one. */
  invalidate?(): void;
}

export interface ClientCredentialsOptions {
  /** OAuth token endpoint (authkit-server: `<issuer>/oauth/token`). */
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Resource the token is for. Default `flags`. */
  audience?: string;
  /** Default: read rules, write events and declarations. */
  scope?: string;
  /** Refresh this long before expiry (ms). Default 30000. */
  leewayMs?: number;
  fetch?: typeof fetch;
}

export const TENANT_SCOPES = {
  rulesetRead: 'flags:ruleset:read',
  eventsWrite: 'flags:events:write',
  declarationsWrite: 'flags:declarations:write',
  ofrepEvaluate: 'flags:ofrep:evaluate',
} as const;

export const tokens = {
  /** A fixed token (a shared secret). */
  static(token: string): TokenSource {
    return { get: async () => token };
  },

  /**
   * OAuth 2.0 client credentials (RFC 6749 §4.4) — with authkit-server, register the app as a
   * confidential client with the `client_credentials` grant. Tokens are cached until shortly before
   * they expire; concurrent callers share one in-flight request.
   */
  clientCredentials(options: ClientCredentialsOptions): TokenSource {
    const fetcher = options.fetch ?? fetch;
    let cached: { token: string; expiresAt: number } | undefined;
    let inflight: Promise<string> | undefined;
    const leeway = options.leewayMs ?? 30_000;
    const fetchToken = async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        audience: options.audience ?? 'flags',
        resource: options.audience ?? 'flags',
        scope:
          options.scope ??
          [
            TENANT_SCOPES.rulesetRead,
            TENANT_SCOPES.eventsWrite,
            TENANT_SCOPES.declarationsWrite,
          ].join(' '),
      });
      const response = await fetcher(options.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString('base64')}`,
        },
        body,
      });
      if (!response.ok)
        throw new Error(`token endpoint answered ${response.status}: ${await response.text()}`);
      const json = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!json.access_token) throw new Error('token endpoint returned no access_token');
      cached = {
        token: json.access_token,
        expiresAt: Date.now() + (json.expires_in ?? 300) * 1000,
      };
      return json.access_token;
    };
    return {
      async get() {
        if (cached && cached.expiresAt - leeway > Date.now()) return cached.token;
        inflight ??= fetchToken().finally(() => {
          inflight = undefined;
        });
        return inflight;
      },
      invalidate() {
        cached = undefined;
      },
    };
  },
};
