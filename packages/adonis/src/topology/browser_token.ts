import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Subject } from '../subject.js';
import type { TokenSource } from './token.js';
import type { VerifiedUser } from './verify.js';

/**
 * Browser tokens: short-lived, HMAC-signed evaluation contexts that an app's backend mints for
 * its own frontend (`GET /_flags/token`) and the flags API verifies.
 *
 * Each app signs with its own key, derived from the flags server's secret and the app's name and
 * environment. The flags server re-derives the key from the token's `app` and `env`, so a token
 * cannot be moved to another app or environment, and an app can only ever mint tokens for itself.
 * A tenant gets its key from the control-plane over its authenticated tenant connection, so there
 * is no extra secret to distribute.
 */

const VERSION = 'v1';

export interface BrowserTokenPayload {
  sub?: string;
  typ?: string;
  attrs?: Record<string, unknown>;
  app: string;
  env: string;
  exp: number;
}

export interface IssuedBrowserToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The signing key of one app in one environment. */
export function browserKey(secret: string, app: string, environment: string): string {
  return createHmac('sha256', secret)
    .update(`flags-browser-key:${VERSION}:${app}:${environment}`)
    .digest('base64url');
}

export function signBrowserToken(
  subject: Subject | undefined,
  options: { key: string; app: string; environment: string; ttlSeconds?: number },
): IssuedBrowserToken {
  const exp = Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 300);
  const payload: BrowserTokenPayload = {
    ...(subject ? { sub: String(subject.id) } : {}),
    ...(subject?.type ? { typ: subject.type } : {}),
    ...(subject?.attributes && Object.keys(subject.attributes).length > 0
      ? { attrs: subject.attributes }
      : {}),
    app: options.app,
    env: options.environment,
    exp,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', options.key)
    .update(`${VERSION}.${body}`)
    .digest('base64url');
  return { token: `${VERSION}.${body}.${signature}`, expiresAt: exp * 1000 };
}

/** Verifies a browser token against the flags server's secret. `null` when invalid or expired. */
export function verifyBrowserToken(token: string | undefined, secret: string): VerifiedUser | null {
  if (!token) return null;
  const [version, body, signature] = token.split('.');
  if (version !== VERSION || !body || !signature) return null;
  let payload: Partial<BrowserTokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload.app !== 'string' || typeof payload.env !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  const key = browserKey(secret, payload.app, payload.env);
  const expected = createHmac('sha256', key).update(`${VERSION}.${body}`).digest('base64url');
  if (!sameString(signature, expected)) return null;
  const attributes =
    payload.attrs && typeof payload.attrs === 'object' && !Array.isArray(payload.attrs)
      ? payload.attrs
      : undefined;
  return {
    ...(typeof payload.sub === 'string'
      ? {
          subject: {
            id: payload.sub,
            ...(typeof payload.typ === 'string' ? { type: payload.typ } : {}),
            ...(attributes ? { attributes } : {}),
          },
        }
      : {}),
    environment: payload.env,
    app: payload.app,
    expiresAt: payload.exp * 1000,
  };
}

/** Where an app gets the key it signs its browser tokens with. */
export interface BrowserKeySource {
  get(): Promise<{ key: string; app: string; environment: string }>;
}

/** Standalone and control-plane: the key is derived locally. */
export function localKeySource(secret: string, app: string, environment: string): BrowserKeySource {
  const key = { key: browserKey(secret, app, environment), app, environment };
  return { get: async () => key };
}

/**
 * Tenant: asks the control-plane for this app's key (`POST <url>/v1/browser-key`), authenticated
 * like every other tenant call. Cached for an hour; concurrent callers share one request.
 */
export function remoteKeySource(options: {
  url: string;
  token: TokenSource;
  partition: string;
  fetch?: typeof fetch;
  cacheMs?: number;
}): BrowserKeySource {
  const doFetch = options.fetch ?? fetch;
  let cached: { value: { key: string; app: string; environment: string }; until: number } | null =
    null;
  let inflight: Promise<{ key: string; app: string; environment: string }> | undefined;
  const load = async () => {
    const request = async () =>
      doFetch(`${options.url.replace(/\/$/, '')}/v1/browser-key`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await options.token.get()}`,
          'x-flags-tenant': options.partition,
        },
      });
    let response = await request();
    if (response.status === 401 && options.token.invalidate) {
      options.token.invalidate();
      response = await request();
    }
    if (response.status === 404) {
      throw new Error(
        'the control-plane does not serve browsers: set `browser` in its config/flags.ts',
      );
    }
    if (!response.ok)
      throw new Error(`control-plane answered ${response.status} on /v1/browser-key`);
    const value = (await response.json()) as { key: string; app: string; environment: string };
    cached = { value, until: Date.now() + (options.cacheMs ?? 3_600_000) };
    return value;
  };
  return {
    async get() {
      if (cached && cached.until > Date.now()) return cached.value;
      inflight ??= load().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}
