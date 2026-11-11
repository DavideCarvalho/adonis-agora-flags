import type { HttpContext } from '@adonisjs/core/http';
import type { Actor } from '../stores/store.js';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import type { ConsoleAuthorize, ConsoleAuthorizeResult } from './console_authorize.js';

export type { AuthorizeDecision, AuthorizeResult } from './authorize_decision.js';
export type {
  AuthorizeByTokenOptions,
  ConsoleAuthorize,
  ConsoleAuthorizeResult,
  ConsoleAuthorizer,
  ConsoleAuthorizerClass,
} from './console_authorize.js';

/** The function form of {@link FlagsDashboardConfig.accessDenied}. */
export type AccessDeniedRenderer = GenericAccessDeniedRenderer<HttpContext>;

/** `accessDenied` in either form — an options object for the built-in page, or a renderer. */
export type AccessDeniedOption = GenericAccessDeniedOption<HttpContext>;

/**
 * The inline-function form of the dashboard's `authorize` option. Runs before every dashboard
 * route (API + HTML) and may be async. Answer with:
 *
 * - `true` / `{ allowed: true }` — let the request through;
 * - `{ allowed: false, reason: 'unauthenticated' }` — nobody is signed in: `401`;
 * - `{ allowed: false, reason: 'forbidden' }`, `{ allowed: false }` or `false` — `403`;
 * - `{ redirectTo: '/login' }` — a page navigation is redirected (`302`), an API call gets `401`.
 *
 * A hook that throws is a `403`. `@adonis-agora/authkit-client`'s `authkitDashboardAuthorize` and
 * `@adonis-agora/authz`'s `authorizeByRoles` fit here as-is.
 */
export type AuthorizeHook = (
  ctx: HttpContext,
) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;

/**
 * Who a console change is attributed to (audit log, change requests). Return an {@link Actor}, a
 * bare id, or nothing to fall back to `'dashboard'`.
 */
export type ActorResolver = (
  ctx: HttpContext,
) => Actor | string | null | undefined | Promise<Actor | string | null | undefined>;

/** Shape of `config/flags_dashboard.ts`. */
export interface FlagsDashboardConfig {
  /** Master switch. `false` registers no routes at all. Default `true`. */
  enabled?: boolean;
  /**
   * URL prefix the console and its API mount under. Default `/flags`. The HTML is served at the
   * prefix root; the JSON API lives under `<path>/api`. Every route is an EXACT path (no SPA
   * catch-all), so the prefix can sit next to other routes safely.
   */
  path?: string;
  /**
   * Who may open the console: an inline function, an authorizer class (built through the
   * container, so `@inject()` works), or a lazy import of one. For machine access use
   * `authorizeByToken({ token })`.
   *
   * Omitted: the console is open outside production and answers every request with `403` in
   * production; the provider logs a one-time warning at boot saying so.
   */
  authorize?: ConsoleAuthorize;
  /**
   * Who the acting person is, for the audit log and two-person approvals. Default: the signed-in
   * user's id (`ctx.auth.user.id`, with `email`/`name` as the display name), else `'dashboard'`.
   *
   * With approvals on, two people only count as two when this tells them apart: everyone falling
   * back to `'dashboard'` means nobody can approve anybody's request.
   */
  actor?: ActorResolver;
  /** What a BROWSER sees when the guard refuses a page navigation. API calls always get JSON. */
  accessDenied?: AccessDeniedOption;
}

/** A fully-resolved config — every field present (defaults applied). */
export interface ResolvedFlagsDashboardConfig {
  enabled: boolean;
  path: string;
  authorize: ConsoleAuthorize | null;
  actor: ActorResolver | null;
  accessDenied: AccessDeniedOption | null;
}

/** Apply defaults to a partial config, producing a fully-resolved one. */
export function resolveConfig(config: FlagsDashboardConfig = {}): ResolvedFlagsDashboardConfig {
  const rawPath = config.path ?? '/flags';
  // Normalize: ensure a single leading slash and no trailing slash (root stays '').
  const trimmed = `/${rawPath.replace(/^\/+/, '').replace(/\/+$/, '')}`;
  return {
    enabled: config.enabled ?? true,
    path: trimmed === '/' ? '' : trimmed,
    authorize: config.authorize ?? null,
    actor: config.actor ?? null,
    accessDenied: config.accessDenied ?? null,
  };
}

/** Identity helper giving `config/flags_dashboard.ts` full type-checking. */
export function defineConfig(config: FlagsDashboardConfig = {}): FlagsDashboardConfig {
  return config;
}
