import { PassThrough } from 'node:stream';
import {
  type EvaluationDetails,
  evaluate,
  type JsonValue,
  type Ruleset,
} from '@adonis-agora/flags-core';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import type { FlagDeclaration } from '../declare.js';
import type { ControlPlaneConfig } from '../define_config.js';
import { parseEvents } from '../events/event.js';
import type { FlagsRuntime } from '../runtime.js';
import {
  DEFAULT_MAX_MESSAGE_BYTES,
  type DeadLetter,
  decodeMessage,
  MemoryDedupe,
  type MessageDedupe,
  PoisonMessageError,
  type TenantMessage,
} from '../tenant_transports/message.js';
import type {
  ControlPlaneLink,
  HandledMessage,
  LinkLogger,
  TenantMessageHandler,
} from '../tenant_transports/types.js';
import { browserKey } from '../topology/browser_token.js';
import { TENANT_SCOPES } from '../topology/token.js';
import {
  resolveTenantVerifier,
  type TenantVerifierOption,
  type TenantVerifierRequest,
  type VerifiedTenant,
  type VerifierMaker,
} from '../topology/verify.js';

/** The control-plane's options: `controlPlane` from `config/flags.ts` plus the top-level `verifyTenant`. */
export type ControlPlaneOptions = Omit<
  NonNullable<ControlPlaneConfig<Record<string, FlagDeclaration>>['controlPlane']>,
  'verifyTenant'
> & {
  verifyTenant: TenantVerifierOption;
  /** Builds class-form verifiers (the provider passes the container). Default `new`. */
  make?: VerifierMaker;
  logger?: LinkLogger;
};

/** What a request or message failed on, mapped to an HTTP status or a dead letter. */
class IngestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const KIND_CAPABILITY: Record<TenantMessage['kind'], string> = {
  events: TENANT_SCOPES.eventsWrite,
  usage: TENANT_SCOPES.eventsWrite,
  declarations: TENANT_SCOPES.declarationsWrite,
  ruleset: TENANT_SCOPES.rulesetRead,
};

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
export class ControlPlane implements TenantMessageHandler {
  readonly prefix: string;
  readonly maxMessageBytes: number;
  #cache = new Map<string, Ruleset>();
  #verify: (request: TenantVerifierRequest) => Promise<VerifiedTenant | null>;
  #dedupe: MessageDedupe = new MemoryDedupe();
  #links: ControlPlaneLink[] = [];
  /** Shared pollers for environments other than this process's. */
  #envWatchers = new Map<string, { listeners: Set<(r: Ruleset) => void>; stop: () => void }>();

  constructor(
    private readonly runtime: FlagsRuntime,
    private readonly options: ControlPlaneOptions,
    /** Set when `browser` is configured: tenants fetch their browser signing keys. */
    private readonly browserSecret?: string,
  ) {
    this.prefix = (options.prefix ?? '/_flags').replace(/\/$/, '');
    this.#verify = resolveTenantVerifier(options.verifyTenant, options.make);
    this.maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  /**
   * Verifies a token and checks it carries `capability`. Every channel (HTTP and every broker)
   * goes through here: the partition, environment and capabilities come from the verified token.
   */
  async #verifyToken(
    token: string | undefined,
    claimed: string | undefined,
    capability: string,
    advertised: string[],
  ): Promise<VerifiedTenant | 'unauthorized' | 'forbidden'> {
    const verified = await this.#verify({ token, partition: claimed, tenant: claimed });
    if (!verified) return 'unauthorized';
    if (!verified.capabilities.includes(capability)) return 'forbidden';
    tenants.set(verified.partition, {
      ...tenants.get(verified.partition),
      partition: verified.partition,
      environment: verified.environment ?? this.runtime.manager.environment,
      capabilities: advertised,
      lastSeenAt: new Date().toISOString(),
    });
    return verified;
  }

  /** Verifies the request's token and checks it carries `capability`; answers 401/403 otherwise. */
  async #auth(ctx: HttpContext, capability: string): Promise<VerifiedTenant | null> {
    const claimed = ctx.request.header('x-flags-tenant') ?? undefined;
    const result = await this.#verifyToken(
      bearer(ctx),
      claimed,
      capability,
      (ctx.request.header('x-flags-capabilities') ?? '').split(',').filter(Boolean),
    );
    if (result === 'unauthorized') {
      ctx.response.status(401).send({ error: 'unauthorized' });
      return null;
    }
    if (result === 'forbidden') {
      ctx.response.status(403).send({ error: `token lacks the ${capability} capability` });
      return null;
    }
    return result;
  }

  // ── Tenant messages over brokers (tenantTransports.*) ─────────────────────

  /**
   * Starts the broker drivers in `controlPlane.transports`. The HTTP routes are separate and stay
   * mounted: browsers, OFREP and HTTP tenants keep using them.
   */
  async serveTransports(context: {
    app?: ApplicationService | undefined;
    redis(connection?: string): Promise<unknown>;
    /** Ace commands: only drivers without a loop of their own (`queue`, for `queue:work`). */
    passiveOnly?: boolean;
  }): Promise<void> {
    for (const transport of this.options.transports ?? []) {
      if (transport.driver === 'http') continue;
      if (context.passiveOnly && !transport.passive) continue;
      this.#links.push(
        await transport.serve({
          app: context.app,
          logger: this.options.logger,
          redis: (connection) => context.redis(connection),
          handler: this,
        }),
      );
    }
  }

  /** The broker links this control-plane serves (doctor). */
  get links(): readonly ControlPlaneLink[] {
    return this.#links;
  }

  async close(): Promise<void> {
    for (const link of this.#links.splice(0)) await link.close?.();
    for (const watcher of this.#envWatchers.values()) watcher.stop();
    this.#envWatchers.clear();
  }

  async deadLetter(letter: Omit<DeadLetter, 'at'>): Promise<void> {
    const full: DeadLetter = { ...letter, at: new Date().toISOString() };
    if (this.options.onDeadLetter) {
      try {
        await this.options.onDeadLetter(full);
      } catch {
        // a broken hook must not block the broker
      }
      return;
    }
    this.options.logger?.error(
      `[flags] dead-lettered a tenant message (${full.driver}, ${full.kind ?? '?'} ${full.id ?? '?'} from "${full.partition ?? '?'}"): ${full.reason}: ${full.error}`,
    );
  }

  async handle(
    raw: unknown,
    _driver: string,
    options: { dedupe?: MessageDedupe | undefined } = {},
  ): Promise<HandledMessage> {
    const message = decodeMessage(raw, this.maxMessageBytes);
    const body = (message.body ?? {}) as Record<string, unknown>;
    const capability = KIND_CAPABILITY[message.kind];
    const result = await this.#verifyToken(
      message.token,
      message.partition,
      capability,
      Array.isArray(body.capabilities) ? (body.capabilities as unknown[]).map(String) : [],
    );
    if (result === 'unauthorized')
      throw new PoisonMessageError('the tenant token was refused', 'unauthorized');
    if (result === 'forbidden')
      throw new PoisonMessageError(`token lacks the ${capability} capability`, 'forbidden');
    const verified = result;
    const environment = this.#environment(verified);
    if (message.kind === 'ruleset') {
      const ruleset = await this.ruleset(environment);
      const info = tenants.get(verified.partition);
      if (info) info.lastRulesetVersion = ruleset.version;
      const known = typeof body.version === 'string' ? body.version : undefined;
      return {
        status: 'ok',
        message,
        verified,
        environment,
        ruleset: known === ruleset.version ? null : ruleset,
      };
    }
    // Dedupe on the VERIFIED partition: a tenant cannot shadow another's message ids.
    const dedupe = options.dedupe ?? this.#dedupe;
    const key = `${verified.partition}:${message.id}`;
    if (await dedupe.seen(key)) return { status: 'duplicate', message, verified, environment };
    try {
      if (message.kind === 'events') await this.#ingestEvents(verified, body.events);
      else if (message.kind === 'usage') await this.#ingestUsage(verified, body.rows);
      else await this.#ingestDeclarations(verified, body.declarations);
    } catch (error) {
      if (error instanceof IngestError && error.status < 500)
        throw new PoisonMessageError(error.message, error.status === 413 ? 'too_large' : 'invalid');
      throw error;
    }
    await dedupe.mark(key);
    return { status: 'ok', message, verified, environment };
  }

  watchEnvironment(environment: string, listener: (ruleset: Ruleset) => void): () => void {
    if (environment === this.runtime.manager.environment)
      return this.runtime.source.onChange(listener);
    let watcher = this.#envWatchers.get(environment);
    if (!watcher) {
      const listeners = new Set<(r: Ruleset) => void>();
      let last: string | undefined;
      const poll = setInterval(async () => {
        try {
          const version = await this.runtime.store!.version(environment);
          if (last === undefined) {
            last = version;
            return;
          }
          if (version === last) return;
          last = version;
          const ruleset = await this.ruleset(environment);
          for (const fn of listeners) fn(ruleset);
        } catch {
          // next tick
        }
      }, 5000);
      poll.unref();
      watcher = { listeners, stop: () => clearInterval(poll) };
      this.#envWatchers.set(environment, watcher);
    }
    const w = watcher;
    w.listeners.add(listener);
    return () => {
      w.listeners.delete(listener);
      if (w.listeners.size === 0) {
        w.stop();
        this.#envWatchers.delete(environment);
      }
    };
  }

  async #ingestEvents(verified: VerifiedTenant, raw: unknown) {
    let events: ReturnType<typeof parseEvents>;
    try {
      events = parseEvents(raw, verified.partition, this.#environment(verified));
    } catch (error) {
      throw new IngestError(400, (error as Error).message);
    }
    if (events.length > 5000) throw new IngestError(413, 'at most 5000 events per request');
    await this.runtime.transport!.publish(events);
    return events.length;
  }

  async #ingestDeclarations(verified: VerifiedTenant, declarations: unknown) {
    if (!declarations || typeof declarations !== 'object' || Array.isArray(declarations))
      throw new IngestError(400, 'declarations must be an object');
    await this.runtime.store!.saveDeclarations(
      verified.partition,
      declarations as Record<string, FlagDeclaration>,
    );
  }

  async #ingestUsage(verified: VerifiedTenant, rows: unknown) {
    if (!Array.isArray(rows)) throw new IngestError(400, 'rows must be an array');
    if (rows.length > 50_000) throw new IngestError(413, 'at most 50000 usage rows per request');
    const environment = this.#environment(verified);
    await this.runtime.store!.recordUsage(
      (rows as Array<{ flag: string; day: string; evaluations: number }>)
        .filter(
          (r) =>
            r &&
            typeof r.flag === 'string' &&
            typeof r.day === 'string' &&
            /^\d{4}-\d{2}-\d{2}$/.test(r.day) &&
            Number.isFinite(r.evaluations),
        )
        .map((r) => ({
          environment,
          // The app comes from the verified token, like the environment: never from the rows.
          app: verified.partition,
          flag: r.flag,
          day: r.day,
          evaluations: Math.max(0, Math.trunc(r.evaluations)),
        })),
    );
  }

  #ingestFailed(ctx: HttpContext, error: unknown) {
    if (error instanceof IngestError)
      return ctx.response.status(error.status).send({ error: error.message });
    throw error;
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
      key: browserKey(this.browserSecret!, verified.partition, environment),
      app: verified.partition,
      environment,
    });
  }

  async getRuleset(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.rulesetRead);
    if (!verified) return;
    const ruleset = await this.ruleset(this.#environment(verified));
    const info = tenants.get(verified.partition);
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
    try {
      const accepted = await this.#ingestEvents(
        verified,
        (ctx.request.body() as { events?: unknown }).events,
      );
      return ctx.response.status(202).send({ accepted });
    } catch (error) {
      return this.#ingestFailed(ctx, error);
    }
  }

  async declarations(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.declarationsWrite);
    if (!verified) return;
    try {
      await this.#ingestDeclarations(
        verified,
        (ctx.request.body() as { declarations?: unknown }).declarations,
      );
      return ctx.response.status(204).send('');
    } catch (error) {
      return this.#ingestFailed(ctx, error);
    }
  }

  async usage(ctx: HttpContext) {
    const verified = await this.#auth(ctx, TENANT_SCOPES.eventsWrite);
    if (!verified) return;
    try {
      await this.#ingestUsage(verified, (ctx.request.body() as { rows?: unknown }).rows);
      return ctx.response.status(204).send('');
    } catch (error) {
      return this.#ingestFailed(ctx, error);
    }
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
