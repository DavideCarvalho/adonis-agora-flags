import type { HttpContext } from '@adonisjs/core/http';
import type { FlagsRuntime } from '../runtime.js';
import {
  type BrowserKeySource,
  localKeySource,
  remoteKeySource,
} from '../topology/browser_token.js';
import type { ControlPlaneAddress } from '../topology/url.js';
import { BrowserApi } from './browser_api.js';
import { BrowserTokens } from './browser_tokens.js';
import type { ControlPlane } from './control_plane.js';

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  post(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
}

/** The secret browser keys derive from: `browser.secret`, else the app key. */
export function browserSecret(runtime: FlagsRuntime, appKey: unknown): string | undefined {
  if (!runtime.config.browser || runtime.config.topology === 'tenant') return undefined;
  const secret = runtime.config.browser.secret ?? releaseSecret(appKey);
  if (!secret) {
    throw new Error(
      '[flags] `browser` needs a secret: set `browser.secret`, or APP_KEY in the app config',
    );
  }
  return secret;
}

export function releaseSecret(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof (value as { release?: unknown }).release === 'function') {
    return String((value as { release(): unknown }).release()) || undefined;
  }
  return undefined;
}

interface AppLike {
  config?: { get?(key: string, fallback?: unknown): unknown };
}

/** A non-empty string, or a `Secret` releasing one. */
const present = (value: unknown): boolean => {
  try {
    return releaseSecret(value) !== undefined;
  } catch {
    return false;
  }
};

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolved(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first key of an encryption config entry, whatever its shape (`keys[0]`, `key`). */
function keyOfEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) return keys.find((k) => present(k));
  return key;
}

/**
 * The key of `config/encryption.ts` (AdonisJS 7): the first key of its default entry
 * (`list[default]`, else the first entry), resolving the lazy config providers `defineConfig` and
 * `drivers.*` return. A flat `{ keys }` / `{ key }` config is read as is.
 */
async function encryptionKeyOf(app: unknown): Promise<unknown> {
  let raw: unknown;
  try {
    raw = (app as AppLike)?.config?.get?.('encryption');
  } catch {
    return undefined;
  }
  const config = await resolved(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined ? undefined : keyOfEntry(await resolved(entries[chosen], app));
  }
  return keyOfEntry(config);
}

/**
 * The app's `APP_KEY` (SECURITY-UNIFORM-SPEC §13c, identical in every lib): `config/app.ts`'s
 * `appKey`, else the default entry of `config/encryption.ts` (AdonisJS 7), else the `APP_KEY`
 * environment variable. A `Secret` (`.release()`) or a string; never logged. A source that throws
 * counts as "no key here". Pass the result through {@link releaseSecret}.
 */
export async function appKeyOf(app: unknown): Promise<unknown> {
  let fromApp: unknown;
  try {
    fromApp = (app as AppLike)?.config?.get?.('app.appKey');
  } catch {
    fromApp = undefined;
  }
  if (present(fromApp)) return fromApp;
  const fromEncryption = await encryptionKeyOf(app);
  if (present(fromEncryption)) return fromEncryption;
  const fromEnv = process.env.APP_KEY;
  return present(fromEnv) ? fromEnv : undefined;
}

/**
 * Mounts what `browser` in `config/flags.ts` asks for: the token endpoint on every topology, and the
 * flags API on standalone and control-plane apps.
 */
export function registerBrowser(
  router: RouterLike,
  runtime: FlagsRuntime,
  options: {
    secret?: string | undefined;
    controlPlane?: ControlPlane | undefined;
    logger?: { warn(message: string): void } | undefined;
  },
): BrowserTokens | undefined {
  const config = runtime.config;
  const browser = config.browser;
  if (!browser) return undefined;
  const manager = runtime.manager;
  let keys: BrowserKeySource;
  let url: string | ControlPlaneAddress;
  if (config.topology === 'tenant') {
    const address = runtime.controlPlaneUrl!;
    keys = remoteKeySource({
      url: address,
      token: runtime.token!,
      partition: config.tenant.partition,
    });
    url = browser.publicUrl ?? address;
  } else {
    const secret = options.secret!;
    const prefix = (
      browser.prefix ??
      (config.topology === 'control-plane' ? config.controlPlane?.prefix : undefined) ??
      '/_flags'
    ).replace(/\/$/, '');
    keys = localKeySource(secret, manager.app, manager.environment);
    url = browser.publicUrl ?? prefix;
    const rulesetOf = async (environment: string) => {
      if (options.controlPlane) return options.controlPlane.ruleset(environment);
      if (environment === manager.environment) return runtime.source.current();
      return runtime.store!.readRuleset(environment);
    };
    new BrowserApi(runtime, rulesetOf, {
      secret,
      verifyUser: browser.verifyUser,
      corsOrigins: browser.corsOrigins,
    }).register(router, prefix);
  }
  const tokens = new BrowserTokens(runtime, keys, url, browser, options.logger);
  if (browser.tokenRoute !== false) {
    router
      .get(browser.tokenRoute ?? '/_flags/token', (ctx) => tokens.handle(ctx))
      .as('flags.browser.token');
  }
  return tokens;
}

/**
 * A browser token for the request's subject, e.g. to hand the first one to the frontend in a page
 * response instead of a round-trip to the token endpoint. Needs `browser` in `config/flags.ts`.
 */
export async function browserToken(ctx: HttpContext) {
  const { getRuntime } = await import('../services/accessor.js');
  const tokens = getRuntime().browser;
  if (!tokens) throw new Error('[flags] browserToken() needs `browser` in config/flags.ts');
  return tokens.issue(ctx);
}
