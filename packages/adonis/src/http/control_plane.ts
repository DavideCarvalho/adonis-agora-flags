import { PassThrough } from 'node:stream';
import {
  type EvaluationDetails,
  evaluate,
  type JsonValue,
  type Ruleset,
} from '@adonis-agora/flags-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { FlagDeclaration } from '../declare.js';
import type { ControlPlaneConfig } from '../define_config.js';
import { parseEvents } from '../events/event.js';
import type { FlagsRuntime } from '../runtime.js';
import { browserKey } from '../topology/browser_token.js';
import { TENANT_SCOPES } from '../topology/token.js';
import type { VerifiedTenant } from '../topology/verify.js';

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  post(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  any?(pattern: string, handler: (ctx: HttpContext) => unknown): unknown;
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
}

/** What the control-plane knows about each tenant that called it (shown in the console). */
export interface TenantInfo {
  partition: string;
  environment: string;
  capabilities: string[];
  lastSeenAt: string;
  lastRulesetVersion?: string;
}

const tenants = new Map<string, TenantInfo>();

export function knownTenants(): TenantInfo[] {
  return [...tenants.values()].sort((a, b) => a.partition.localeCompare(b.partition));
}

function bearer(ctx: HttpContext): string | undefined {
  const header = ctx.request.header('authorization');
  if (header && /^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim();
  return ctx.request.header('x-api-key') ?? undefined;
}

/**
 * Serves tenants: the ruleset (ETag + SSE), event ingestion, declarations and usage, plus OFREP.
 * Every request is authenticated by `verifyTenant`; the tenant identity and environment come from
 * the verified token, never from the request body.
 */
export class ControlPlane {
  readonly prefix: string;
  #cache = new Map<string, Ruleset>();

  constructor(
    private readonly runtime: FlagsRuntime,
    private readonly options: ControlPlaneConfig<Record<string, FlagDeclaration>>['controlPlane'],
    /** Set when `browser` is configured: tenants fetch their browser signing keys. */
    private readonly browserSecret?: string,
  ) {
    this.prefix = (options.prefix ?? '/_flags').replace(/\/$/, '');
  }

  async #auth(ctx: HttpContext, scope: string): Promise<VerifiedTenant | null> {
    const verified = await this.options.verifyTenant({
      token: bearer(ctx),
      tenant: ctx.request.header('x-flags-tenant') ?? undefined,
    });
    if (!verified) {
      ctx.response.status(401).send({ error: 'unauthorized' });
      return null;
    }
    if (verified.capabilities && !verified.capabilities.includes(scope)) {
      ctx.response.status(403).send({ error: `token lacks the ${scope} scope` });
      return null;
    }
    const environment = verified.environment ?? this.runtime.manager.environment;
    const capabilities = (ctx.request.header('x-flags-capabilities') ?? '')
      .split(',')
      .filter(Boolean);
    tenants.set(verified.tenant, {
      ...tenants.get(verified.tenant),
      partition: verified.tenant,
      environment,
      capabilities,
      lastSeenAt: new Date().toISOString(),
    });
    return verified;
  }

  #environment(verified: VerifiedTenant): string {
    return verified.environment ?? this.runtime.manager.environment;
  }

  /** The ruleset of an environment: the live one for ours, a version-checked cache for others. */
  async ruleset(environment: string): Promise<Ruleset> {
    if (environment === this.runtime.manager.environment) return this.runtime.source.current();
    const store = this.runtime.store!;
    const version = await store.version(environment);
    const cached = this.#cache.get(environment);
    if (cached && cached.version === version) return cached;
    const ruleset = await store.readRuleset(environment);
    this.#cache.set(environment, ruleset);
    return ruleset;
  }

  register(router: RouterLike) {
    const p = this.prefix;
    router.get(`${p}/v1/ruleset`, (ctx) => this.getRuleset(ctx)).as('flags.cp.ruleset');
    router.get(`${p}/v1/ruleset/stream`, (ctx) => this.stream(ctx)).as('flags.cp.stream');
    router.post(`${p}/v1/events`, (ctx) => this.events(ctx)).as('flags.cp.events');
    router
      .post(`${p}/v1/declarations`, (ctx) => this.declarations(ctx))
      .as('flags.cp.declarations');
    router.post(`${p}/v1/usage`, (ctx) => this.usage(ctx)).as('flags.cp.usage');
    if (this.browserSecret) {
      router.post(`${p}/v1/browser-key`, (ctx) => this.browserKey(ctx)).as('flags.cp.browserKey');
    }
    if (this.options.ofrep !== false) {
      router.post('/ofrep/v1/evaluate/flags', (ctx) => this.ofrepBulk(ctx)).as('flags.ofrep.bulk');
      router
        .post('/ofrep/v1/evaluate/flags/:key', (ctx) => this.ofrepOne(ctx))
        .as('flags.ofrep.one');
      if (this.options.corsOrigins?.length && router.route) {
        router.route('/ofrep/v1/evaluate/flags', ['OPTIONS'], (ctx) => this.#preflight(ctx));
        router.route('/ofrep/v1/evaluate/flags/:key', ['OPTIONS'], (ctx) => this.#preflight(ctx));
      }
    }
  }

  /**
   * A tenant's browser signing key, for its own partition and environment only. Requires the
   * events scope: a browser token lets the browser send events in the tenant's name.
   */
  async browserKey(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.eventsWrite);
    if (!verified) return;
    const environment = this.#environment(verified);
    ctx.response.header('cache-control', 'no-store');
    return ctx.response.json({
      key: browserKey(this.browserSecret!, verified.tenant, environment),
      app: verified.tenant,
      environment,
    });
  }

  async getRuleset(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.rulesetRead);
    if (!verified) return;
    const ruleset = await this.ruleset(this.#environment(verified));
    const info = tenants.get(verified.tenant);
    if (info) info.lastRulesetVersion = ruleset.version;
    const etag = `"${ruleset.version}"`;
    ctx.response.header('etag', etag);
    ctx.response.header('cache-control', 'no-cache');
    if (ctx.request.header('if-none-match') === etag) return ctx.response.status(304).send('');
    return ctx.response.json(ruleset);
  }

  /** SSE: an `event: ruleset` message on every change; closes when the token expires. */
  async stream(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.rulesetRead);
    if (!verified) return;
    const environment = this.#environment(verified);
    const body = new PassThrough();
    const send = (chunk: string) => {
      if (!body.writableEnded) body.write(chunk);
    };
    let lastVersion = (await this.ruleset(environment)).version;
    send(`event: ruleset\ndata: ${JSON.stringify({ version: lastVersion })}\n\n`);

    const cleanups: Array<() => void> = [];
    const close = () => {
      for (const fn of cleanups.splice(0)) fn();
      if (!body.writableEnded) body.end();
    };
    if (environment === this.runtime.manager.environment) {
      cleanups.push(
        this.runtime.source.onChange((ruleset) => {
          lastVersion = ruleset.version;
          send(`event: ruleset\ndata: ${JSON.stringify({ version: ruleset.version })}\n\n`);
        }),
      );
    } else {
      const poll = setInterval(async () => {
        try {
          const version = await this.runtime.store!.version(environment);
          if (version !== lastVersion) {
            lastVersion = version;
            send(`event: ruleset\ndata: ${JSON.stringify({ version })}\n\n`);
          }
        } catch {
          // keep the stream; the tenant polls too
        }
      }, 5000);
      cleanups.push(() => clearInterval(poll));
    }
    const heartbeat = setInterval(() => send(': ping\n\n'), 25_000);
    cleanups.push(() => clearInterval(heartbeat));
    if (verified.expiresAt) {
      const expiry = setTimeout(close, Math.max(0, verified.expiresAt - Date.now()));
      cleanups.push(() => clearTimeout(expiry));
    }
    ctx.request.request.once('close', close);

    ctx.response.header('content-type', 'text/event-stream');
    ctx.response.header('cache-control', 'no-cache, no-transform');
    ctx.response.header('x-accel-buffering', 'no');
    ctx.response.stream(body);
  }

  async events(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.eventsWrite);
    if (!verified) return;
    let events: ReturnType<typeof parseEvents>;
    try {
      events = parseEvents(
        (ctx.request.body() as { events?: unknown }).events,
        verified.tenant,
        this.#environment(verified),
      );
    } catch (error) {
      return ctx.response.status(400).send({ error: (error as Error).message });
    }
    if (events.length > 5000)
      return ctx.response.status(413).send({ error: 'at most 5000 events per request' });
    await this.runtime.transport!.publish(events);
    return ctx.response.status(202).send({ accepted: events.length });
  }

  async declarations(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.declarationsWrite);
    if (!verified) return;
    const body = ctx.request.body() as { declarations?: Record<string, FlagDeclaration> };
    if (!body.declarations || typeof body.declarations !== 'object') {
      return ctx.response.status(400).send({ error: 'declarations must be an object' });
    }
    await this.runtime.store!.saveDeclarations(verified.tenant, body.declarations);
    return ctx.response.status(204).send('');
  }

  async usage(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.eventsWrite);
    if (!verified) return;
    const rows = (
      ctx.request.body() as { rows?: Array<{ flag: string; day: string; evaluations: number }> }
    ).rows;
    if (!Array.isArray(rows))
      return ctx.response.status(400).send({ error: 'rows must be an array' });
    const environment = this.#environment(verified);
    await this.runtime.store!.recordUsage(
      rows
        .filter(
          (r) =>
            typeof r.flag === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(r.day) &&
            Number.isFinite(r.evaluations),
        )
        .map((r) => ({
          environment,
          flag: r.flag,
          day: r.day,
          evaluations: Math.max(0, Math.trunc(r.evaluations)),
        })),
    );
    return ctx.response.status(204).send('');
  }

  // ── OFREP (OpenFeature Remote Evaluation Protocol) ─────────────────────────

  #cors(ctx: HttpContext) {
    const origin = ctx.request.header('origin');
    if (origin && this.options.corsOrigins?.includes(origin)) {
      ctx.response.header('access-control-allow-origin', origin);
      ctx.response.header('vary', 'Origin');
      ctx.response.header('access-control-expose-headers', 'ETag');
    }
  }

  #preflight(ctx: HttpContext) {
    this.#cors(ctx);
    ctx.response.header('access-control-allow-methods', 'POST, OPTIONS');
    ctx.response.header(
      'access-control-allow-headers',
      'authorization, content-type, if-none-match, x-api-key, x-flags-tenant',
    );
    return ctx.response.status(204).send('');
  }

  #ofrepContext(ctx: HttpContext): Record<string, unknown> | null {
    const body = ctx.request.body() as { context?: unknown };
    if (body.context === undefined) return {};
    if (typeof body.context !== 'object' || body.context === null || Array.isArray(body.context))
      return null;
    return body.context as Record<string, unknown>;
  }

  #ofrepResult(details: EvaluationDetails) {
    return {
      key: details.flagKey,
      value: details.value,
      reason: details.reason,
      ...(details.variant !== undefined ? { variant: details.variant } : {}),
      metadata: details.flagMetadata,
    };
  }

  async ofrepOne(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#auth(ctx, TENANT_SCOPES.ofrepEvaluate);
    if (!verified) return;
    const key = ctx.params.key as string;
    const context = this.#ofrepContext(ctx);
    if (!context) {
      return ctx.response
        .status(400)
        .send({ key, errorCode: 'INVALID_CONTEXT', errorDetails: 'context must be an object' });
    }
    const ruleset = await this.ruleset(this.#environment(verified));
    const details = evaluate(ruleset, key, null as JsonValue, context);
    if (details.errorCode === 'FLAG_NOT_FOUND') {
      return ctx.response
        .status(404)
        .send({ key, errorCode: 'FLAG_NOT_FOUND', errorDetails: details.errorMessage });
    }
    if (details.errorCode) {
      return ctx.response
        .status(400)
        .send({ key, errorCode: details.errorCode, errorDetails: details.errorMessage });
    }
    return ctx.response.json(this.#ofrepResult(details));
  }

  async ofrepBulk(ctx: HttpContext) {
    this.#cors(ctx);
    const verified = await this.#auth(ctx, TENANT_SCOPES.ofrepEvaluate);
    if (!verified) return;
    const context = this.#ofrepContext(ctx);
    if (!context) {
      return ctx.response
        .status(400)
        .send({ errorCode: 'INVALID_CONTEXT', errorDetails: 'context must be an object' });
    }
    const ruleset = await this.ruleset(this.#environment(verified));
    // The ETag covers the ruleset AND the context: same rules + same context = same answers.
    const { createHash } = await import('node:crypto');
    const etag = `"${ruleset.version}-${createHash('sha1').update(JSON.stringify(context)).digest('hex').slice(0, 16)}"`;
    ctx.response.header('etag', etag);
    if (ctx.request.header('if-none-match') === etag) return ctx.response.status(304).send('');
    const flags = Object.keys(ruleset.flags)
      .sort()
      .map((key) => {
        const details = evaluate(ruleset, key, null as JsonValue, context);
        return details.errorCode
          ? { key, errorCode: details.errorCode, errorDetails: details.errorMessage }
          : this.#ofrepResult(details);
      });
    return ctx.response.json({ flags });
  }
}
