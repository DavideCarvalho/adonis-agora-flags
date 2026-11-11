import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { evaluate, type JsonValue, type Ruleset } from '@adonis-agora/flags-core';
import type { HttpContext } from '@adonisjs/core/http';
import { HOLDOUT_VARIANT } from '../analytics/results.js';
import { EVENT_SCHEMA_VERSION, exposureId, type FlagEvent, uuidv7 } from '../events/event.js';
import type { FlagsRuntime } from '../runtime.js';
import { toContext } from '../subject.js';
import type { UserVerifier, VerifiedUser } from '../topology/verify.js';

export interface BrowserApiOptions {
  /** Verifies the browser's token (an authkit access token, or a signed context). */
  verifyUser: UserVerifier;
  /** Origins allowed to call from browsers (CORS). */
  corsOrigins?: string[];
}

interface RouterLike {
  get(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  post(pattern: string, handler: (ctx: HttpContext) => unknown): { as(name: string): unknown };
  route?(pattern: string, methods: string[], handler: (ctx: HttpContext) => unknown): unknown;
}

/** Untrusted attributes a browser may add (screen, locale): small, primitive, never identity. */
function browserAttributes(input: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input).slice(0, 20)) {
    if (key === 'targetingKey' || key === 'subjectType') continue;
    if (typeof value === 'string' && value.length <= 200) out[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * Flags for frontends that talk to the flags server directly (SPAs, mobile, static sites):
 *
 * - `POST <prefix>/v1/client/evaluate` — values of the flags declared `client: true`, for the
 *   verified user. ETag over ruleset + context.
 * - `GET  <prefix>/v1/client/stream?token=…` — server-sent `ruleset` events.
 * - `POST <prefix>/v1/client/events` — exposures (`{ type: 'exposure', flag }`, re-evaluated here)
 *   and tracks (`{ type: 'track', name, value?, props? }`).
 *
 * The identity always comes from the verified token. Attributes the browser sends are merged
 * underneath the token's, so they can never change who the user is or what the token says.
 */
export class BrowserApi {
  #clientFlags: { at: number; keys: Set<string> } | undefined;

  constructor(
    private readonly runtime: FlagsRuntime,
    private readonly rulesetOf: (environment: string) => Promise<Ruleset>,
    private readonly options: BrowserApiOptions,
  ) {}

  register(router: RouterLike, prefix: string) {
    const base = `${prefix}/v1/client`;
    router.post(`${base}/evaluate`, (ctx) => this.evaluate(ctx)).as('flags.client.evaluate');
    router.get(`${base}/stream`, (ctx) => this.stream(ctx)).as('flags.client.stream');
    router.post(`${base}/events`, (ctx) => this.events(ctx)).as('flags.client.events');
    if (this.options.corsOrigins?.length && router.route) {
      for (const path of ['evaluate', 'events', 'stream']) {
        router.route(`${base}/${path}`, ['OPTIONS'], (ctx) => this.#preflight(ctx));
      }
    }
  }

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
    ctx.response.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    ctx.response.header(
      'access-control-allow-headers',
      'authorization, content-type, if-none-match',
    );
    ctx.response.header('access-control-max-age', '600');
    return ctx.response.status(204).send('');
  }

  async #auth(ctx: HttpContext, token?: string): Promise<VerifiedUser | null> {
    const header = ctx.request.header('authorization');
    const bearer =
      token ??
      (header && /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, '').trim() : undefined);
    const verified = await this.options.verifyUser({ token: bearer });
    if (!verified) {
      ctx.response.status(401).send({ error: 'unauthorized' });
      return null;
    }
    return verified;
  }

  #environment(user: VerifiedUser) {
    return user.environment ?? this.runtime.manager.environment;
  }

  /** Keys the browser may see: declared `client: true` in the console, in code, or by a tenant. */
  async #clientKeys(ruleset: Ruleset): Promise<Set<string>> {
    const now = Date.now();
    if (!this.#clientFlags || now - this.#clientFlags.at > 30_000) {
      const keys = new Set<string>();
      for (const [key, declaration] of Object.entries(this.runtime.manager.declarations)) {
        if (declaration.client) keys.add(key);
      }
      for (const row of (await this.runtime.store?.declarations()) ?? []) {
        if (row.declaration.client) keys.add(row.key);
      }
      this.#clientFlags = { at: now, keys };
    }
    const keys = new Set(this.#clientFlags.keys);
    for (const [key, definition] of Object.entries(ruleset.flags)) {
      if (definition.declaration?.client) keys.add(key);
      else if (definition.declaration && definition.declaration.client !== true) keys.delete(key);
    }
    return keys;
  }

  #defaultOf(ruleset: Ruleset, key: string): JsonValue {
    return (this.runtime.manager.declarations[key]?.default ??
      ruleset.flags[key]?.declaration?.default ??
      null) as JsonValue;
  }

  async evaluate(ctx: HttpContext) {
    this.#cors(ctx);
    const user = await this.#auth(ctx);
    if (!user) return;
    const environment = this.#environment(user);
    const ruleset = await this.rulesetOf(environment);
    const attributes = browserAttributes(
      (ctx.request.body() as { attributes?: unknown }).attributes,
    );
    const context = toContext(user.subject, attributes);
    const etag = `"${ruleset.version}-${createHash('sha1').update(JSON.stringify(context)).digest('hex').slice(0, 16)}"`;
    ctx.response.header('etag', etag);
    ctx.response.header('cache-control', 'no-store');
    if (ctx.request.header('if-none-match') === etag) return ctx.response.status(304).send('');
    const values: Record<string, JsonValue> = {};
    const variants: Record<string, string> = {};
    const experiments: string[] = [];
    for (const key of [...(await this.#clientKeys(ruleset))].sort()) {
      const details = evaluate(ruleset, key, this.#defaultOf(ruleset, key), context);
      values[key] = details.value;
      if (details.variant !== undefined) variants[key] = details.variant;
      if (typeof details.flagMetadata.experiment === 'string') experiments.push(key);
    }
    return ctx.response.json({ version: ruleset.version, values, variants, experiments });
  }

  /** `EventSource` cannot send headers, so the token comes in the query string. Keep it short-lived. */
  async stream(ctx: HttpContext) {
    this.#cors(ctx);
    const user = await this.#auth(ctx, String(ctx.request.qs().token ?? '') || undefined);
    if (!user) return;
    const environment = this.#environment(user);
    const body = new PassThrough();
    const send = (chunk: string) => {
      if (!body.writableEnded) body.write(chunk);
    };
    let last = (await this.rulesetOf(environment)).version;
    send(`event: ruleset\ndata: ${JSON.stringify({ version: last })}\n\n`);
    const cleanups: Array<() => void> = [];
    const close = () => {
      for (const fn of cleanups.splice(0)) fn();
      if (!body.writableEnded) body.end();
    };
    if (environment === this.runtime.manager.environment) {
      cleanups.push(
        this.runtime.source.onChange((ruleset) => {
          last = ruleset.version;
          send(`event: ruleset\ndata: ${JSON.stringify({ version: ruleset.version })}\n\n`);
        }),
      );
    } else {
      const poll = setInterval(async () => {
        try {
          const version = (await this.rulesetOf(environment)).version;
          if (version !== last) {
            last = version;
            send(`event: ruleset\ndata: ${JSON.stringify({ version })}\n\n`);
          }
        } catch {
          // keep the stream; the client polls too
        }
      }, 5000);
      cleanups.push(() => clearInterval(poll));
    }
    const heartbeat = setInterval(() => send(': ping\n\n'), 25_000);
    cleanups.push(() => clearInterval(heartbeat));
    if (user.expiresAt) {
      const expiry = setTimeout(close, Math.max(0, user.expiresAt - Date.now()));
      cleanups.push(() => clearTimeout(expiry));
    }
    ctx.request.request.once('close', close);
    ctx.response.header('content-type', 'text/event-stream');
    ctx.response.header('cache-control', 'no-cache, no-transform');
    ctx.response.header('x-accel-buffering', 'no');
    ctx.response.stream(body);
  }

  async events(ctx: HttpContext) {
    this.#cors(ctx);
    const user = await this.#auth(ctx);
    if (!user) return;
    const raw = (ctx.request.body() as { events?: unknown }).events;
    if (!Array.isArray(raw) || raw.length > 200) {
      return ctx.response.status(400).send({ error: 'events must be an array of at most 200' });
    }
    const environment = this.#environment(user);
    const ruleset = await this.rulesetOf(environment);
    const clientKeys = await this.#clientKeys(ruleset);
    const app = user.app ?? 'browser';
    const subject = String(user.subject.id);
    const subjectType = user.subject.type ?? 'user';
    const context = toContext(user.subject);
    const out: FlagEvent[] = [];
    for (const entry of raw as Array<Record<string, unknown>>) {
      if (
        entry?.type === 'exposure' &&
        typeof entry.flag === 'string' &&
        clientKeys.has(entry.flag)
      ) {
        // Re-evaluated here: the browser says which flag it showed, never which variant.
        const details = evaluate(
          ruleset,
          entry.flag,
          this.#defaultOf(ruleset, entry.flag),
          context,
        );
        const experiment = details.flagMetadata.experiment;
        const holdout = details.flagMetadata.holdout === true;
        if (typeof experiment !== 'string' || details.variant === undefined) continue;
        if (details.reason !== 'SPLIT' && !holdout) continue;
        out.push({
          id: exposureId(app, environment, experiment, subject),
          schemaVersion: EVENT_SCHEMA_VERSION,
          app,
          environment,
          type: 'exposure',
          flag: entry.flag,
          experiment,
          variant: holdout ? HOLDOUT_VARIANT : details.variant,
          subject,
          subjectType,
          ...(holdout ? { props: { holdout: true } } : {}),
          ts: Date.now(),
        });
      } else if (
        entry?.type === 'track' &&
        typeof entry.name === 'string' &&
        entry.name.length <= 191
      ) {
        const value =
          typeof entry.value === 'number' && Number.isFinite(entry.value) ? entry.value : undefined;
        const props =
          entry.props && typeof entry.props === 'object' && !Array.isArray(entry.props)
            ? (entry.props as Record<string, unknown>)
            : undefined;
        out.push({
          id: uuidv7(),
          schemaVersion: EVENT_SCHEMA_VERSION,
          app,
          environment,
          type: 'track',
          name: entry.name,
          subject,
          subjectType,
          ...(value !== undefined ? { value } : {}),
          ...(props ? { props } : {}),
          ts: Date.now(),
        });
      }
    }
    if (out.length > 0) await this.runtime.transport!.publish(out);
    return ctx.response.status(202).send({ accepted: out.length });
  }
}
