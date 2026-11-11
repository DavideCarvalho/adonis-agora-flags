import { readFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import {
  type AccessDeniedInfo,
  resolveAccessDeniedPage,
} from '../src/dashboard/access_denied_page.js';
import { defaultActor, FALLBACK_ACTOR, toActor } from '../src/dashboard/actor.js';
import {
  type ConsoleAuthorizeDecision,
  resolveConsoleAuthorize,
} from '../src/dashboard/console_authorize.js';
import {
  type FlagsDashboardConfig,
  type ResolvedFlagsDashboardConfig,
  resolveConfig,
} from '../src/dashboard/define_config.js';
import {
  type ApiRequest,
  type ApiResponse,
  approveChangeRequest,
  audit,
  cancelChangeRequest,
  cancelSchedule,
  createSchedule,
  type Deps,
  deleteFlag,
  deleteLayer,
  deleteSegment,
  evaluateContext,
  experimentDetail,
  exportRuleset,
  flagDetail,
  importRuleset,
  listChangeRequests,
  listExperiments,
  listFlags,
  listLayers,
  listSchedules,
  listSegments,
  meta,
  ops,
  preview,
  promote,
  recomputeExperiment,
  rejectChangeRequest,
  saveFlag,
  saveHoldout,
  saveLayer,
  saveSegment,
  setEnabled,
  setOverride,
  setRollout,
  setVariant,
  stale,
} from '../src/dashboard/handlers.js';
import { contentTypeFor, renderIndexHtml } from '../src/dashboard/spa.js';
import type { FlagsConfig } from '../src/define_config.js';
import { getRuntime, hasRuntime } from '../src/services/accessor.js';
import type { Actor } from '../src/stores/store.js';

/**
 * Directory of the built SPA (`dist/assets/spa`, copied in by `copy:spa`), relative to this
 * compiled provider (`dist/providers`). Resolved lazily: `fileURLToPath` throws on a non-`file:`
 * `import.meta.url`, which would make the provider unimportable under some test runners.
 *
 * This reads BUILT ASSETS FROM DISK. The provider never imports `@adonis-agora/flags-dashboard` —
 * that package is a devDependency purely so the workspace build orders them.
 */
let spaDir: string | undefined;
function spaDirectory(): string {
  spaDir ??= fileURLToPath(new URL('../assets/spa/', import.meta.url));
  return spaDir;
}

/** Logged once at boot when `authorize` is omitted. Same wording in every Agora console. */
export const NO_AUTHORIZE_WARNING =
  '[@adonis-agora/flags] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/flags_dashboard.ts.';

/** Logged at boot on a tenant, which has nothing to edit locally. */
export const TENANT_WARNING =
  '[@adonis-agora/flags] this app is a flags tenant: its flags are edited on the control-plane, so the console is not mounted here. Remove the dashboard provider or open the control-plane console.';

type Handler = (deps: Deps, req: ApiRequest) => Promise<ApiResponse>;

/**
 * Mounts the flags console into an AdonisJS app: the `@adonis-agora/flags-dashboard` React SPA plus
 * a JSON API over the booted flags runtime (`getRuntime()`), under a configurable path (default
 * `/flags`).
 *
 * Every write goes through `FlagsAdmin`, so the console gets the validation, `authorize` hook,
 * two-person approvals and audit trail the commands get. Writes are `POST`/`PUT`/`DELETE` only —
 * never a `GET` a prefetcher could follow — and sit behind the same {@link enforce} guard as every
 * read. CSRF is the host app's: `@adonisjs/shield` guards these routes like any other
 * state-changing route of the app, and the SPA echoes its `XSRF-TOKEN` cookie in `x-xsrf-token`.
 *
 * Routes (relative to the configured `path`):
 * - `GET    /`, `/assets/:file`                        → the SPA
 * - `GET    /api/meta`                                 → environments, approvals, the acting user
 * - `GET    /api/flags`, `/api/flags/:key`             → list / one flag (definition, audit, schedules)
 * - `PUT    /api/flags/:key`  `DELETE /api/flags/:key` → save / remove a definition
 * - `POST   /api/flags/:key/{enabled,rollout,variant,overrides,schedules}`
 * - `POST   /api/preview`, `/api/evaluate`             → validate a draft / test a context
 * - `GET    /api/segments`  `PUT|DELETE /api/segments/:key`
 * - `GET    /api/layers`    `PUT|DELETE /api/layers/:key`  `PUT /api/holdout`
 * - `GET    /api/experiments`, `/api/experiments/:key`  `POST /api/experiments/:key/recompute`
 * - `GET    /api/change-requests`  `POST /api/change-requests/:id/{approve,reject,cancel}`
 * - `GET    /api/audit`, `/api/schedules`  `DELETE /api/schedules/:id`
 * - `GET    /api/export`  `POST /api/import`, `/api/promote`
 * - `GET    /api/stale`, `/api/ops`
 *
 * On a `tenant` (no store, no admin) nothing is registered and a warning is logged.
 */
export default class FlagsDashboardProvider {
  constructor(protected app: ApplicationService) {}

  private warnedOnAuthorizeThrow = false;
  private authorizeGuard: (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision> = async () => ({
    allowed: false,
    status: 403,
    reason: 'forbidden',
  });

  async boot() {
    const config = resolveConfig(this.app.config.get<FlagsDashboardConfig>('flags_dashboard', {}));
    if (!config.enabled) return;
    const flagsConfig = this.app.config.get<FlagsConfig | undefined>('flags', undefined);
    if (flagsConfig?.topology === 'tenant') {
      await this.warn(TENANT_WARNING);
      return;
    }
    this.authorizeGuard = await this.resolveGuard(config);

    // The router is committed only after every provider's `boot()`: register in `booted`.
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.registerRoutes(router, config);
    });
  }

  private registerRoutes(router: HttpRouterService, config: ResolvedFlagsDashboardConfig): void {
    const api = `${config.path}/api`;
    this.registerSpaRoutes(router, config, api);

    const json = (handler: Handler) => async (ctx: HttpContext) => {
      const guard = await this.enforce(config, ctx, 'api');
      if (!guard.allowed) return;
      if (!hasRuntime()) {
        return ctx.response.status(503).json({
          error:
            '@adonis-agora/flags is not booted: register "@adonis-agora/flags/flags_provider" in adonisrc.ts',
        });
      }
      try {
        const actor = await this.actorOf(config, ctx);
        const result = await handler({ runtime: getRuntime(), actor }, toApiRequest(ctx));
        return ctx.response.status(result.status).json(result.body);
      } catch (error) {
        return ctx.response
          .status(500)
          .json({ error: error instanceof Error ? error.message : 'internal error' });
      }
    };
    const name = (suffix: string) => `flags_dashboard.${suffix}`;

    router.get(`${api}/meta`, json(meta)).as(name('meta'));

    router.get(`${api}/flags`, json(listFlags)).as(name('flags'));
    router.get(`${api}/flags/:key`, json(flagDetail)).as(name('flags.show'));
    router.put(`${api}/flags/:key`, json(saveFlag)).as(name('flags.save'));
    router.delete(`${api}/flags/:key`, json(deleteFlag)).as(name('flags.delete'));
    router.post(`${api}/flags/:key/enabled`, json(setEnabled)).as(name('flags.enabled'));
    router.post(`${api}/flags/:key/rollout`, json(setRollout)).as(name('flags.rollout'));
    router.post(`${api}/flags/:key/variant`, json(setVariant)).as(name('flags.variant'));
    router.post(`${api}/flags/:key/overrides`, json(setOverride)).as(name('flags.overrides'));
    router.post(`${api}/flags/:key/schedules`, json(createSchedule)).as(name('flags.schedule'));

    // Not writes, but they take a body (a draft definition, an evaluation context) — `POST`.
    router.post(`${api}/preview`, json(preview)).as(name('preview'));
    router.post(`${api}/evaluate`, json(evaluateContext)).as(name('evaluate'));

    router.get(`${api}/segments`, json(listSegments)).as(name('segments'));
    router.put(`${api}/segments/:key`, json(saveSegment)).as(name('segments.save'));
    router.delete(`${api}/segments/:key`, json(deleteSegment)).as(name('segments.delete'));

    router.get(`${api}/layers`, json(listLayers)).as(name('layers'));
    router.put(`${api}/layers/:key`, json(saveLayer)).as(name('layers.save'));
    router.delete(`${api}/layers/:key`, json(deleteLayer)).as(name('layers.delete'));
    router.put(`${api}/holdout`, json(saveHoldout)).as(name('holdout.save'));

    router.get(`${api}/experiments`, json(listExperiments)).as(name('experiments'));
    router.get(`${api}/experiments/:key`, json(experimentDetail)).as(name('experiments.show'));
    router
      .post(`${api}/experiments/:key/recompute`, json(recomputeExperiment))
      .as(name('experiments.recompute'));

    router.get(`${api}/change-requests`, json(listChangeRequests)).as(name('requests'));
    router
      .post(`${api}/change-requests/:id/approve`, json(approveChangeRequest))
      .as(name('requests.approve'));
    router
      .post(`${api}/change-requests/:id/reject`, json(rejectChangeRequest))
      .as(name('requests.reject'));
    router
      .post(`${api}/change-requests/:id/cancel`, json(cancelChangeRequest))
      .as(name('requests.cancel'));

    router.get(`${api}/audit`, json(audit)).as(name('audit'));
    router.get(`${api}/schedules`, json(listSchedules)).as(name('schedules'));
    router.delete(`${api}/schedules/:id`, json(cancelSchedule)).as(name('schedules.cancel'));

    router.get(`${api}/export`, json(exportRuleset)).as(name('export'));
    router.post(`${api}/import`, json(importRuleset)).as(name('import'));
    router.post(`${api}/promote`, json(promote)).as(name('promote'));

    router.get(`${api}/stale`, json(stale)).as(name('stale'));
    router.get(`${api}/ops`, json(ops)).as(name('ops'));
  }

  /** Who is acting: the configured `actor`, else the signed-in user, else `'dashboard'`. */
  private async actorOf(config: ResolvedFlagsDashboardConfig, ctx: HttpContext): Promise<Actor> {
    if (!config.actor) return defaultActor(ctx);
    try {
      return toActor(await config.actor(ctx));
    } catch {
      return FALLBACK_ACTOR;
    }
  }

  /** Mount the React SPA at `config.path` plus its hashed asset bundle. */
  private registerSpaRoutes(
    router: HttpRouterService,
    config: ResolvedFlagsDashboardConfig,
    api: string,
  ): void {
    const indexPath = config.path === '' ? '/' : config.path;

    router
      .get(indexPath, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'page')).allowed) return;
        let html: string;
        try {
          html = await readFile(resolvePath(spaDirectory(), 'index.html'), 'utf8');
        } catch {
          return ctx.response
            .status(404)
            .send(
              'The flags console SPA is not built. Run `pnpm --filter @adonis-agora/flags-dashboard build` (or the package build) to emit dist/spa.',
            );
        }
        const environment = hasRuntime() ? getRuntime().manager.environment : 'production';
        return ctx.response
          .header('content-type', 'text/html; charset=utf-8')
          .header('cache-control', 'no-store, must-revalidate')
          .send(renderIndexHtml(html, config.path, api, environment));
      })
      .as('flags_dashboard.index');

    router
      .get(`${config.path}/assets/:file`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'page')).allowed) return;
        const file = basename(String(ctx.params.file));
        const root = resolvePath(spaDirectory(), 'assets');
        const assetPath = resolvePath(root, file);
        if (!assetPath.startsWith(root)) return ctx.response.status(404).send('');
        let bytes: Buffer;
        try {
          bytes = await readFile(assetPath);
        } catch {
          return ctx.response.status(404).send('');
        }
        return ctx.response
          .header('content-type', contentTypeFor(file))
          .header('cache-control', 'public, max-age=31536000, immutable')
          .send(bytes);
      })
      .as('flags_dashboard.assets');
  }

  private async warn(message: string): Promise<void> {
    try {
      const logger = await this.app.container.make('logger');
      logger.warn(message);
    } catch {
      // Logging is best-effort: a missing logger must not stop the app from booting.
    }
  }

  /**
   * The `authorize` option turned into one guard. Omitted: open outside production, every request
   * refused (`403`) in production; either way it says so once at boot.
   */
  private async resolveGuard(
    config: ResolvedFlagsDashboardConfig,
  ): Promise<(ctx: HttpContext) => Promise<ConsoleAuthorizeDecision>> {
    if (config.authorize) return resolveConsoleAuthorize(config.authorize);
    await this.warn(NO_AUTHORIZE_WARNING);
    if (this.app.inProduction !== true) return async () => ({ allowed: true });
    return async () => ({ allowed: false, status: 403, reason: 'forbidden' });
  }

  private async warnAuthorizeThrow(hookError: unknown): Promise<void> {
    if (this.warnedOnAuthorizeThrow) return;
    this.warnedOnAuthorizeThrow = true;
    const message = hookError instanceof Error ? hookError.message : String(hookError);
    await this.warn(`flags dashboard authorize hook threw; treating as denial (403). ${message}`);
  }

  /**
   * Run the `authorize` gate. A denial answers `401`/`403` — the access-denied PAGE for a page
   * navigation, `{ error }` JSON for an API call; `{ redirectTo }` is a `302` for a page and
   * `401 { error, redirectTo }` for the API. A hook that already answered keeps its answer.
   */
  private async enforce(
    config: ResolvedFlagsDashboardConfig,
    ctx: HttpContext,
    mode: 'page' | 'api',
  ): Promise<{ allowed: boolean }> {
    // Never `if (!(await authorize(ctx)))`: a `{ allowed: false }` decision is truthy.
    const decision = await this.authorizeGuard(ctx);
    if (decision.allowed) return { allowed: true };
    if (decision.status === 403 && decision.error !== undefined) {
      await this.warnAuthorizeThrow(decision.error);
    }
    if (decision.status === 302) {
      if (responseAnswered(ctx)) return { allowed: false };
      if (mode === 'page') ctx.response.redirect(decision.redirectTo);
      else {
        ctx.response
          .status(401)
          .json({ error: 'unauthenticated', redirectTo: decision.redirectTo });
      }
      return { allowed: false };
    }
    if (mode === 'page') {
      await this.denyPage(ctx, config, { status: decision.status, reason: decision.reason });
    } else if (!responseAnswered(ctx)) {
      ctx.response
        .status(decision.status)
        .json({ error: decision.status === 401 ? 'unauthenticated' : 'forbidden' });
    }
    return { allowed: false };
  }

  /** Answer a refused PAGE navigation with HTML: the built-in page or the host's own. */
  private async denyPage(
    ctx: HttpContext,
    config: ResolvedFlagsDashboardConfig,
    denial: Pick<AccessDeniedInfo, 'status' | 'reason'>,
  ): Promise<void> {
    const answered = () => responseAnswered(ctx);
    if (answered()) return;
    const nonce = cspNonce(ctx);
    const info: AccessDeniedInfo = {
      ...denial,
      basePath: config.path,
      ...(nonce !== undefined ? { nonce } : {}),
    };
    const html = await resolveAccessDeniedPage(info, config.accessDenied, ctx, answered);
    if (html === null) return;
    ctx.response
      .status(info.status)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store, must-revalidate')
      .send(html);
  }
}

/** Whether something already answered this request (a redirect or a queued body). */
function responseAnswered(ctx: HttpContext): boolean {
  if (ctx.response.getHeader('location')) return true;
  const response = ctx.response as unknown as { hasLazyBody?: unknown; headersSent?: unknown };
  return response.hasLazyBody === true || response.headersSent === true;
}

/** The request's CSP nonce when the host runs `@adonisjs/shield` with `@nonce`. */
function cspNonce(ctx: HttpContext): string | undefined {
  const nonce = (ctx.response as unknown as { nonce?: unknown }).nonce;
  return typeof nonce === 'string' && nonce !== '' ? nonce : undefined;
}

/** Adapt an AdonisJS `HttpContext` to the framework-light {@link ApiRequest}. */
function toApiRequest(ctx: HttpContext): ApiRequest {
  return {
    params: ctx.params as Record<string, string | undefined>,
    query: ctx.request.qs() as Record<string, string | string[] | undefined>,
    body: ctx.request.body(),
  };
}
