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
import { resolveSignOut, resolveViewer } from '../src/dashboard/console_shell.js';
import {
  flagsConsoleSearch,
  listVisibleConsoles,
  otherConsoles,
  readAgoraConsoles,
  registerAgoraConsole,
  searchConsoles,
} from '../src/dashboard/console_switcher.js';
import {
  type FlagsDashboardConfig,
  type ResolvedFlagsDashboardConfig,
  resolveConfig,
} from '../src/dashboard/define_config.js';
import {
  type DevToolsCaller,
  type DevToolsDecision,
  registerFlagsDevTools,
} from '../src/dashboard/dev_tools.js';
import {
  type ApiRequest,
  type ApiResponse,
  approveChangeRequest,
  audit,
  cancelChangeRequest,
  cancelSchedule,
  createFlag,
  createSchedule,
  type Deps,
  deleteDeclaration,
  deleteFlag,
  deleteLayer,
  deleteMetric,
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
  listMetrics,
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
  saveMetric,
  saveSegment,
  setEnabled,
  setOverride,
  setRollout,
  setVariant,
  stale,
  updateDeclaration,
} from '../src/dashboard/handlers.js';
import { contentTypeFor, renderIndexHtml, type ShellFields } from '../src/dashboard/spa.js';
import type { FlagsConfig } from '../src/define_config.js';
import { authkitIdentity } from '../src/http/subject_resolver.js';
import type { FlagsIdentityProvider } from '../src/identity.js';
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

/** This console's id in the app's `'agora.consoles'` registry. */
export const CONSOLE_ID = 'flags';

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
 * - `PUT|DELETE /api/flags/:key/declaration`              → edit a console declaration / drop one the code overrides
 * - `POST   /api/preview`, `/api/evaluate`             → validate a draft / test a context
 * - `GET    /api/segments`  `PUT|DELETE /api/segments/:key`
 * - `GET    /api/layers`    `PUT|DELETE /api/layers/:key`  `PUT /api/holdout`
 * - `GET    /api/metrics`   `PUT|DELETE /api/metrics/:key`
 * - `GET    /api/experiments`, `/api/experiments/:key`  `POST /api/experiments/:key/recompute`
 * - `GET    /api/change-requests`  `POST /api/change-requests/:id/{approve,reject,cancel}`
 * - `GET    /api/audit`, `/api/schedules`  `DELETE /api/schedules/:id`
 * - `GET    /api/export`  `POST /api/import`, `/api/promote`
 * - `GET    /api/stale`, `/api/ops`
 * - `GET    /api/consoles`, `/api/consoles/search`     → the console switcher and ⌘K search
 *
 * The console joins the app's `'agora.consoles'` registry (id `flags`), so the other Agora
 * consoles list it in their switcher and search its flags and segments.
 *
 * With `@adonis-agora/agent/mcp_provider` in the app, the same handlers are also registered as
 * `flags_*` tools on its developer MCP endpoint, behind the same `authorize`.
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

  private identity: FlagsIdentityProvider | undefined;

  async boot() {
    const config = resolveConfig(this.app.config.get<FlagsDashboardConfig>('flags_dashboard', {}));
    if (!config.enabled) return;
    const flagsConfig = this.app.config.get<FlagsConfig | undefined>('flags', undefined);
    if (flagsConfig?.topology === 'tenant') {
      await this.warn(TENANT_WARNING);
      return;
    }
    this.identity = flagsConfig?.identity;
    this.authorizeGuard = await this.resolveGuard(config);
    await this.registerDevTools(config);
    // The console switcher: this console joins the app's `'agora.consoles'` registry so the other
    // Agora consoles can link to it (and search it), and it can link to them.
    await this.registerConsole(config);

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
    router.post(`${api}/flags`, json(createFlag)).as(name('flags.create'));
    router.put(`${api}/flags/:key`, json(saveFlag)).as(name('flags.save'));
    router
      .put(`${api}/flags/:key/declaration`, json(updateDeclaration))
      .as(name('flags.declaration'));
    router
      .delete(`${api}/flags/:key/declaration`, json(deleteDeclaration))
      .as(name('flags.declaration.delete'));
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
    router.get(`${api}/metrics`, json(listMetrics)).as(name('metrics'));
    router.put(`${api}/metrics/:key`, json(saveMetric)).as(name('metrics.save'));
    router.delete(`${api}/metrics/:key`, json(deleteMetric)).as(name('metrics.delete'));
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

    // The console switcher: the other Agora consoles this viewer may open, and a search across them.
    router
      .get(`${api}/consoles`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api')).allowed) return;
        const registry = await readAgoraConsoles(this.app.container);
        ctx.response.header('cache-control', 'private, no-store');
        return ctx.response.status(200).json(await listVisibleConsoles(registry, CONSOLE_ID, ctx));
      })
      .as(name('consoles'));
    router
      .get(`${api}/consoles/search`, async (ctx: HttpContext) => {
        if (!(await this.enforce(config, ctx, 'api')).allowed) return;
        const registry = await readAgoraConsoles(this.app.container);
        const q = ctx.request.qs().q;
        ctx.response.header('cache-control', 'private, no-store');
        return ctx.response
          .status(200)
          .json(await searchConsoles(registry, CONSOLE_ID, ctx, typeof q === 'string' ? q : ''));
      })
      .as(name('consoles.search'));
  }

  /**
   * Join the app's `'agora.consoles'` registry: the entry carries this console's own gate (the one
   * its routes run) and a search over the flags and segments of the app's environment.
   */
  private async registerConsole(config: ResolvedFlagsDashboardConfig): Promise<void> {
    let logger: { warn(message: string): void } | undefined;
    try {
      logger = await this.app.container.make('logger');
    } catch {
      logger = undefined;
    }
    const guard = (ctx: HttpContext) => this.authorizeGuard(ctx);
    const read = async (handler: Handler): Promise<unknown[]> => {
      if (!hasRuntime()) return [];
      const result = await handler(
        { runtime: getRuntime(), actor: FALLBACK_ACTOR },
        { params: {}, query: {} },
      );
      const body = result.body as { data?: unknown } | undefined;
      return result.status === 200 && Array.isArray(body?.data) ? body.data : [];
    };
    await registerAgoraConsole(
      this.app.container,
      {
        id: CONSOLE_ID,
        title: 'Flags',
        package: '@adonis-agora/flags',
        icon: 'flags',
        path: config.path === '' ? '/' : config.path,
        order: 60,
        authorize: async (ctx) => {
          const decision = await guard(ctx);
          if (decision.allowed) return { allowed: true };
          return decision.status === 302
            ? { allowed: false, reason: 'unauthenticated', redirectTo: decision.redirectTo }
            : {
                allowed: false,
                reason: decision.status === 401 ? 'unauthenticated' : 'forbidden',
              };
        },
        search: flagsConsoleSearch(
          async () => ({
            flags: async () =>
              (
                (await read(listFlags)) as Array<{
                  key: string;
                  declaration: { description?: string } | null;
                  enabled: boolean | null;
                  experiment: boolean;
                }>
              ).map((flag) => ({
                key: flag.key,
                description: flag.declaration?.description ?? null,
                enabled: flag.enabled,
                experiment: flag.experiment,
              })),
            segments: async () =>
              (await read(listSegments)) as Array<{ key: string; usedBy: string[] }>,
          }),
          config.path,
        ),
      },
      logger,
    );
  }

  /**
   * The console-shell fields of the page's data block: the switcher, ⌘K search (whenever a console
   * registry exists — this console registers its own search), the signed-in viewer and the
   * sign-out (the host's option, else the one an account console announced on the registry).
   */
  private async shellFields(
    config: ResolvedFlagsDashboardConfig,
    ctx: HttpContext,
    api: string,
  ): Promise<ShellFields> {
    const registry = await readAgoraConsoles(this.app.container);
    const viewer = await resolveViewer(ctx, config.viewer);
    const signOut = resolveSignOut(ctx, config.signOut, registry);
    return {
      switcher: { endpoint: `${api}/consoles`, others: otherConsoles(registry, CONSOLE_ID) },
      ...(registry ? { search: { endpoint: `${api}/consoles/search` } } : {}),
      ...(viewer ? { viewer } : {}),
      ...(signOut ? { signOut } : {}),
    };
  }

  /**
   * Register the console's tools into the app's dev-tools hub (`/mcp/agora`), when it has one. Same
   * gate, actor and handlers as the JSON API.
   */
  private async registerDevTools(config: ResolvedFlagsDashboardConfig): Promise<void> {
    const decisions = new WeakMap<HttpContext, Promise<ConsoleAuthorizeDecision>>();
    const decide = (ctx: HttpContext) => {
      let decision = decisions.get(ctx);
      if (!decision) {
        decision = this.authorizeGuard(ctx);
        decisions.set(ctx, decision);
      }
      return decision;
    };
    try {
      await registerFlagsDevTools(this.app.container as never, {
        authorize: async (ctx) => devToolsDecisionOf(await decide(ctx)),
        serve: async (ctx, handler, req, caller) => {
          // The hub ran `authorize` for this request already; a call without it still gets it.
          const decision = await decide(ctx);
          if (!decision.allowed) {
            const status = decision.status === 403 ? 403 : 401;
            return { status, body: { error: status === 403 ? 'forbidden' : 'unauthenticated' } };
          }
          if (!hasRuntime()) {
            return { status: 503, body: { error: '@adonis-agora/flags is not booted' } };
          }
          const actor = mcpActor(await this.actorOf(config, ctx), caller);
          return (handler as Handler)({ runtime: getRuntime(), actor }, {
            params: {},
            query: {},
            ...req,
          } as ApiRequest);
        },
      });
    } catch (error) {
      await this.warn(
        `[@adonis-agora/flags] could not register the console's MCP dev tools: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Who is acting: the configured `actor`, else the authkit identity (its `sub` and name), else
   * `ctx.auth.user`, else the anonymous `'dashboard'` (refused where approvals are on).
   */
  private async actorOf(config: ResolvedFlagsDashboardConfig, ctx: HttpContext): Promise<Actor> {
    if (!config.actor && this.identity?.actor) {
      try {
        return (await this.identity.actor(ctx)) ?? FALLBACK_ACTOR;
      } catch {
        return FALLBACK_ACTOR;
      }
    }
    if (!config.actor) {
      const identity = await authkitIdentity(ctx);
      if (identity) {
        const name = identity.profile?.name ?? identity.email;
        return name ? { id: identity.userId, name } : { id: identity.userId };
      }
      return defaultActor(ctx);
    }
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
          .send(
            renderIndexHtml(
              html,
              config.path,
              api,
              environment,
              await this.shellFields(config, ctx, api),
            ),
          );
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
    const identity = this.identity;
    if (identity?.authorizeConsole) {
      return resolveConsoleAuthorize((ctx: HttpContext) => identity.authorizeConsole!(ctx));
    }
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

/** The console decision as the dev-tools hub reads it. */
function devToolsDecisionOf(decision: ConsoleAuthorizeDecision): DevToolsDecision {
  if (decision.allowed) return { allowed: true };
  if (decision.status === 302) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: decision.redirectTo };
  }
  if (decision.status === 401) return { allowed: false, reason: 'unauthenticated' };
  return {
    allowed: false,
    reason: 'forbidden',
    ...(decision.error !== undefined ? { error: decision.error } : {}),
  };
}

/**
 * The actor of an MCP call: the person the console identifies, else `mcp:<caller>` (a token's
 * fingerprint). A dev-open caller stays anonymous, so approvals refuse it.
 */
export function mcpActor(actor: Actor, caller: DevToolsCaller): Actor {
  if (!actor.anonymous) return actor;
  return caller.via === 'open'
    ? { id: `mcp:${caller.id}`, name: 'MCP', anonymous: true }
    : { id: `mcp:${caller.id}`, name: 'MCP' };
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
    query: ctx.request.qs() as Record<string, unknown>,
    body: ctx.request.body(),
  };
}
