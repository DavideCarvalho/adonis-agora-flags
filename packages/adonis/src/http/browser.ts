import type { HttpContext } from '@adonisjs/core/http';
import type { FlagsRuntime } from '../runtime.js';
import {
  type BrowserKeySource,
  localKeySource,
  remoteKeySource,
} from '../topology/browser_token.js';
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

function releaseSecret(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (value && typeof (value as { release?: unknown }).release === 'function') {
    return String((value as { release(): unknown }).release()) || undefined;
  }
  return undefined;
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
  let url: string;
  if (config.topology === 'tenant') {
    keys = remoteKeySource({
      url: config.tenant.url,
      token: runtime.token!,
      partition: config.tenant.partition,
    });
    url = browser.publicUrl ?? config.tenant.url;
  } else {
    const secret = options.secret!;
    const prefix = (
      browser.prefix ??
      (config.topology === 'control-plane' ? config.controlPlane.prefix : undefined) ??
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
