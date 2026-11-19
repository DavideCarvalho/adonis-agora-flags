import { randomUUID } from 'node:crypto';
import type { MetricDefinition } from '@adonis-agora/flags-core';
import { FlagsAdmin } from '../admin.js';
import type { AnalyticsBackend } from '../analytics/backend.js';
import { FALLBACK_ACTOR } from '../dashboard/actor.js';
import type { ApiRequest, ApiResponse, Deps } from '../dashboard/handlers.js';
import * as handlers from '../dashboard/handlers.js';
import { type FlagDeclaration, serializeDeclarations } from '../declare.js';
import type { ExperimentConfig, FlagsConfig } from '../define_config.js';
import type { FlagsManager } from '../manager.js';
import type { RulesetSource } from '../ruleset_source.js';
import type { FlagsRuntime } from '../runtime.js';
import { assertSchemaName, inSchema, type SqlDatabase } from '../sql.js';
import { LucidStore } from '../stores/lucid_store.js';
import type { Actor, FlagsStore } from '../stores/store.js';
import {
  APP_UNREACHABLE,
  FLAGS_CONSOLE_TIMEOUT_MS,
  FlagsConsoleChannelError,
  type FlagsConsoleCommand,
  RedisConsoleChannel,
  type RedisLike,
} from './redis_channel.js';

/**
 * The federated flags console: one app's flags console also shows and edits the flags of other
 * apps, each of which keeps its own store and evaluates locally (no runtime dependency on the
 * console app).
 *
 * - The ruleset, audit log, change requests, schedules and usage are read straight from the
 *   owning app's tables (read-only).
 * - What only the owning app knows (its code declarations, config metrics and experiments,
 *   approvals) comes from a `profile` command, cached for a short while.
 * - Experiment results and ops are asked of the owning app (its analytics backend and worker).
 * - Every write is a console command the owning app runs through its own `FlagsAdmin`, so its
 *   change feed, approvals and audit log see it as if made in its own console.
 */

/** One other app shown in this console (`config/flags_dashboard.ts` → `apps`). */
export interface FederatedFlagsApp {
  /** The name shown in the App picker. Defaults to the key. */
  label?: string | undefined;
  /**
   * Where that app keeps its flags tables: a Lucid `connection` of THIS app and the `schema` the
   * other app gives `schema` in its config/flags.ts. Only read (never created or altered): give
   * the connection's role `SELECT` on them. A {@link FlagsStore} instance also works.
   */
  store: { connection?: string | undefined; schema?: string | undefined } | FlagsStore;
  /**
   * Where that app answers commands (`consoleCommands` in its config/flags.ts): the
   * `@adonisjs/redis` connection to publish on and that app's `prefix`.
   */
  controlPlane: { connection?: string | undefined; prefix: string } | RedisConsoleChannel;
  /** Whether this console may change that app's flags. Default `true`; `false` browses only. */
  actions?: boolean | undefined;
  /** How long a command waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** What a federated app's key may look like (it travels in the URL as `?app=`). */
export const FEDERATED_APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

function isStore(value: unknown): value is FlagsStore {
  return typeof (value as FlagsStore | undefined)?.readRuleset === 'function';
}

function positive(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Checks one `apps` entry at boot, so a misconfigured app fails the boot, not its first request. */
export function validateFederatedApp(key: string, entry: FederatedFlagsApp): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/flags] flags_dashboard.apps["${key}"]: ${message}`);
  };
  if (!FEDERATED_APP_KEY.test(key)) fail('the key must be 1–64 letters, digits, "_", "-" or "."');
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label === '')) {
    fail('`label` must be a non-empty string');
  }
  const store = entry.store;
  if (!store || typeof store !== 'object') fail('`store` is required ({ connection, schema })');
  if (!isStore(store)) {
    const { connection, schema } = store as { connection?: unknown; schema?: unknown };
    if (connection !== undefined && (typeof connection !== 'string' || connection === '')) {
      fail('`store.connection` must be a connection name of config/database.ts');
    }
    if (schema !== undefined) {
      if (typeof schema !== 'string') fail('`store.schema` must be a string');
      try {
        assertSchemaName(schema as string);
      } catch (error) {
        fail(`\`store.schema\`: ${(error as Error).message}`);
      }
    }
  }
  const plane = entry.controlPlane;
  if (!(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` is required ({ connection, prefix })');
    }
    if (typeof plane.prefix !== 'string' || plane.prefix.trim() === '') {
      fail("`controlPlane.prefix` must be the other app's `consoleCommands.prefix` (not empty)");
    }
    if (
      plane.connection !== undefined &&
      (typeof plane.connection !== 'string' || plane.connection === '')
    ) {
      fail('`controlPlane.connection` must be a connection name of config/redis.ts');
    }
  }
  if (entry.actions !== undefined && typeof entry.actions !== 'boolean') {
    fail('`actions` must be a boolean');
  }
  if (entry.timeoutMs !== undefined && !positive(entry.timeoutMs)) {
    fail('`timeoutMs` must be a positive number of milliseconds');
  }
}

/** Console reads answered from the owning app's tables, by this console. */
export const STORE_READS = [
  'meta',
  'listFlags',
  'flagDetail',
  'preview',
  'evaluateContext',
  'listSegments',
  'listLayers',
  'listMetrics',
  'listChangeRequests',
  'audit',
  'listSchedules',
  'exportRuleset',
  'stale',
] as const;

/** Console reads only the owning app can answer (its analytics backend, worker and process). */
export const APP_READS = ['listExperiments', 'experimentDetail', 'ops'] as const;

/** Console writes: run by the owning app, and only when it takes actions. */
export const ACTIONS = [
  'createFlag',
  'saveFlag',
  'updateDeclaration',
  'deleteDeclaration',
  'deleteFlag',
  'setEnabled',
  'setRollout',
  'setVariant',
  'setOverride',
  'createSchedule',
  'cancelSchedule',
  'saveSegment',
  'deleteSegment',
  'saveLayer',
  'deleteLayer',
  'saveHoldout',
  'saveMetric',
  'deleteMetric',
  'recomputeExperiment',
  'approveChangeRequest',
  'rejectChangeRequest',
  'cancelChangeRequest',
  'importRuleset',
  'promote',
] as const;

export type ConsoleHandlerName =
  | (typeof STORE_READS)[number]
  | (typeof APP_READS)[number]
  | (typeof ACTIONS)[number];

const STORE_READ_SET: ReadonlySet<string> = new Set(STORE_READS);
const APP_READ_SET: ReadonlySet<string> = new Set(APP_READS);
const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);

type Handler = (deps: Deps, req: ApiRequest) => Promise<ApiResponse>;

function handlerOf(name: string): Handler | undefined {
  if (!STORE_READ_SET.has(name) && !APP_READ_SET.has(name) && !ACTION_SET.has(name)) {
    return undefined;
  }
  const fn = (handlers as unknown as Record<string, unknown>)[name];
  return typeof fn === 'function' ? (fn as Handler) : undefined;
}

const NAMES = new Map<unknown, ConsoleHandlerName>(
  [...STORE_READS, ...APP_READS, ...ACTIONS].map((name) => [
    (handlers as unknown as Record<string, unknown>)[name],
    name,
  ]),
);

/** The name a console handler travels under, or `undefined` for one federation does not route. */
export function consoleHandlerName(handler: unknown): ConsoleHandlerName | undefined {
  return NAMES.get(handler);
}

/** A command this app does not answer (unknown verb). Answered `501` by the console. */
export const UNSUPPORTED = 'unsupported-request';

// ── The owning app's side ───────────────────────────────────────────────────

/** What the console app needs to know about an app besides its tables. Plain JSON. */
export interface FlagsConsoleProfile {
  /** The app's name (`app` in its config/flags.ts). */
  app: string;
  /** The environment the app evaluates. */
  environment: string;
  /** The flags declared in its code. */
  declarations: Record<string, FlagDeclaration>;
  /** Metrics and experiments of its config/flags.ts. */
  metrics: Record<string, MetricDefinition>;
  experiments: Record<string, ExperimentConfig>;
  /** Environments whose changes need a second person (`true`: all). */
  approvals: string[] | true;
  /** Whether it has an analytics backend (experiment results). */
  analytics: boolean;
  /** Whether it takes actions from another console. */
  actions: boolean;
}

/** The {@link FlagsConsoleProfile} of a booted runtime. */
export function consoleProfile(runtime: FlagsRuntime, actions: boolean): FlagsConsoleProfile {
  const config = runtime.config as {
    metrics?: Record<string, MetricDefinition>;
    experiments?: Record<string, ExperimentConfig>;
    approvals?: { environments?: string[] | true };
  };
  return JSON.parse(
    JSON.stringify({
      app: runtime.manager.app,
      environment: runtime.manager.environment,
      declarations: serializeDeclarations(runtime.admin?.declarations ?? {}),
      metrics: config.metrics ?? {},
      experiments: config.experiments ?? {},
      approvals: config.approvals?.environments ?? [],
      analytics: runtime.analytics !== undefined,
      actions,
    }),
  ) as FlagsConsoleProfile;
}

/** The acting person a command carries, checked; anonymous when it carries none. */
export function commandActor(raw: unknown): Actor {
  if (!raw || typeof raw !== 'object') return FALLBACK_ACTOR;
  const { id, name, anonymous } = raw as { id?: unknown; name?: unknown; anonymous?: unknown };
  if (typeof id !== 'string' || id === '' || id.length > 200) return FALLBACK_ACTOR;
  return {
    id,
    ...(typeof name === 'string' && name !== '' ? { name: name.slice(0, 200) } : {}),
    ...(anonymous === true ? { anonymous: true } : {}),
  };
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The console request a command carries, as an {@link ApiRequest}. */
export function commandRequest(raw: unknown): ApiRequest {
  const value = plainObject(raw);
  const params: Record<string, string | undefined> = {};
  for (const [key, param] of Object.entries(plainObject(value.params))) {
    if (typeof param === 'string') params[key] = param;
  }
  return { params, query: plainObject(value.query), body: value.body };
}

/** One line for the app's log naming an action, its target and who took it (no control chars). */
function logLine(verb: string, req: ApiRequest, actor: Actor): string {
  const clean = (value: string) =>
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    value.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 200);
  const target = req.params.key ?? req.params.id;
  const who = actor.name ? `${actor.id} (${actor.name})` : actor.id;
  return `[flags] federated console: ${verb}${target ? ` ${clean(target)}` : ''} by ${clean(who)}`;
}

/**
 * Answers the commands another app's flags console sends this app: `profile`, the reads only this
 * app can answer, and (with `actions`) every write, run by this app's own console handlers, so
 * validation, `authorize`, approvals and the audit log apply as in its own console.
 */
export function flagsConsoleCommandHandler(options: {
  runtime: () => FlagsRuntime;
  actions: boolean;
  log?: ((line: string) => void) | undefined;
}): (command: FlagsConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const { verb, args } = command;
    const runtime = options.runtime();
    if (verb === 'profile') return consoleProfile(runtime, options.actions);
    const handler = APP_READ_SET.has(verb) || ACTION_SET.has(verb) ? handlerOf(verb) : undefined;
    if (!handler) {
      throw Object.assign(new Error(`this app does not answer the flags console command ${verb}`), {
        code: UNSUPPORTED,
      });
    }
    const actor = commandActor(command.actor);
    const req = commandRequest(args[0]);
    if (ACTION_SET.has(verb)) {
      if (!options.actions) {
        throw Object.assign(
          new Error(
            'this app does not take changes from another console (consoleCommands.actions is off)',
          ),
          { status: 403 },
        );
      }
      options.log?.(logLine(verb, req, actor));
    }
    return handler({ runtime, actor }, req);
  };
}

/** `consoleCommands` in config/flags.ts. */
export type ConsoleCommandsOption =
  | boolean
  | {
      /**
       * The channel prefix the console app names in `controlPlane.prefix`. Default: this app's
       * name (`app` in config/flags.ts, else its package.json name).
       */
      prefix?: string | undefined;
      /** The `@adonisjs/redis` connection to listen on. Default: the default connection. */
      connection?: string | undefined;
      /** Take changes (not only reads) from another console. Default `true`. */
      actions?: boolean | undefined;
    };

/** `consoleCommands` with its defaults, or `undefined` when off. */
export function resolveConsoleCommands(
  option: ConsoleCommandsOption | undefined,
  app: string,
): { prefix: string; connection: string | undefined; actions: boolean } | undefined {
  if (!option) return undefined;
  const value = option === true ? {} : option;
  const prefix = value.prefix ?? app;
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new Error('[flags] consoleCommands.prefix must not be empty');
  }
  return { prefix, connection: value.connection, actions: value.actions !== false };
}

// ── The console app's side ──────────────────────────────────────────────────

/** What a federated console needs from the app it runs in. */
export interface FederationContext {
  /** A Lucid query client for `connection` (default connection when omitted). */
  db(connection?: string): Promise<SqlDatabase>;
  /** The Redis client for `connection` (an ioredis client or an `@adonisjs/redis` connection). */
  redis(connection?: string): Promise<RedisLike>;
  /** The environment shown while an app's profile is unknown (it has never answered). */
  environment?: (() => string) | undefined;
}

/** One federated app as the App picker lists it. */
export interface FederatedAppInfo {
  id: string;
  label: string;
  mode: 'federated';
  /** `app`: changes are sent to the app, which runs them. `none`: this console only browses it. */
  actions: 'app' | 'none';
}

/** How long a profile is reused before it is asked for again. */
const PROFILE_TTL_MS = 30_000;

const STORE_READ_METHODS: ReadonlySet<string> = new Set([
  'readRuleset',
  'version',
  'environments',
  'audit',
  'getChangeRequest',
  'listChangeRequests',
  'getSchedule',
  'listSchedules',
  'usage',
  'declarations',
]);

/** `store` with every write method refused: this console never writes another app's tables. */
export function readOnlyStore(store: FlagsStore): FlagsStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      if (typeof property === 'string' && STORE_READ_METHODS.has(property)) {
        return value.bind(target);
      }
      return () => {
        throw new Error(
          `[flags] a federated app's store is read-only in this console (${String(property)})`,
        );
      };
    },
  });
}

/**
 * The runtime the console handlers read a federated app through: its tables (read-only) and its
 * profile. Nothing runs: no source, no worker, no transport.
 */
function federatedRuntime(store: FlagsStore, profile: FlagsConsoleProfile): FlagsRuntime {
  const admin = new FlagsAdmin(store, {
    environment: profile.environment,
    declarations: profile.declarations,
    metrics: Object.keys(profile.metrics),
    approvals: { environments: profile.approvals },
  });
  const config = {
    topology: 'standalone',
    app: profile.app,
    flags: {},
    metrics: profile.metrics,
    experiments: profile.experiments,
  } as unknown as FlagsConfig;
  return {
    config,
    topology: 'standalone',
    role: 'api',
    // The handlers routed here read only the app's name and environment off the manager.
    manager: { app: profile.app, environment: profile.environment } as unknown as FlagsManager,
    source: undefined as unknown as RulesetSource,
    admin,
    store,
    sinks: new Map(),
    // `meta` only says whether the app has one; its results are asked of the app itself.
    ...(profile.analytics ? { analytics: {} as AnalyticsBackend } : {}),
    enrichers: [],
    async close() {},
  };
}

class FederatedApp {
  readonly label: string;
  readonly actions: boolean;
  readonly #entry: FederatedFlagsApp;
  readonly #context: FederationContext;
  #store: Promise<FlagsStore> | undefined;
  #channel: Promise<RedisConsoleChannel> | undefined;
  #profile: { at: number; profile: FlagsConsoleProfile; runtime: FlagsRuntime } | undefined;
  #asking: Promise<FlagsConsoleProfile> | undefined;

  constructor(
    readonly key: string,
    entry: FederatedFlagsApp,
    context: FederationContext,
  ) {
    this.#entry = entry;
    this.#context = context;
    this.label = entry.label ?? key;
    this.actions = entry.actions !== false;
  }

  info(): FederatedAppInfo {
    return {
      id: this.key,
      label: this.label,
      mode: 'federated',
      actions: this.actions ? 'app' : 'none',
    };
  }

  store(): Promise<FlagsStore> {
    this.#store ??= (async () => {
      const store = this.#entry.store;
      if (isStore(store)) return readOnlyStore(store);
      const db = await this.#context.db(store.connection);
      return readOnlyStore(new LucidStore(inSchema(db, store.schema), { autoCreateSchema: false }));
    })();
    // A connection that could not be made (a typo, Lucid not installed) is retried next time.
    this.#store.catch(() => {
      this.#store = undefined;
    });
    return this.#store;
  }

  channel(): Promise<RedisConsoleChannel> {
    this.#channel ??= (async () => {
      const plane = this.#entry.controlPlane;
      if (plane instanceof RedisConsoleChannel) return plane;
      return new RedisConsoleChannel({
        client: await this.#context.redis(plane.connection),
        prefix: plane.prefix,
      });
    })();
    this.#channel.catch(() => {
      this.#channel = undefined;
    });
    return this.#channel;
  }

  /** Send a command and wait for the app's answer (throws a channel error when nobody answers). */
  async send(verb: string, args: unknown[], actor?: Actor): Promise<unknown> {
    const channel = await this.channel();
    const reply = await channel.send(
      {
        id: randomUUID(),
        verb,
        args,
        ...(actor
          ? {
              actor: {
                id: actor.id,
                ...(actor.name ? { name: actor.name } : {}),
                // Kept: the app refuses anonymous people where its approvals are on.
                ...(actor.anonymous ? { anonymous: true } : {}),
              },
            }
          : {}),
      },
      { timeoutMs: this.#entry.timeoutMs ?? FLAGS_CONSOLE_TIMEOUT_MS },
    );
    if (reply.ok) return reply.data;
    throw Object.assign(new Error(reply.error.message), {
      ...(reply.error.code !== undefined ? { code: reply.error.code } : {}),
      ...(reply.error.status !== undefined ? { status: reply.error.status } : {}),
      fromApp: true,
    });
  }

  /**
   * The runtime reads go through, with whether the app answered its profile. A profile is reused
   * for 30 s; when the app does not answer, the last one is kept, and an app that never answered
   * is read with an empty profile (its tables, without its code declarations).
   */
  async runtime(): Promise<{ runtime: FlagsRuntime; reachable: boolean }> {
    const store = await this.store();
    const cached = this.#profile;
    if (cached && Date.now() - cached.at < PROFILE_TTL_MS) {
      return { runtime: cached.runtime, reachable: true };
    }
    try {
      this.#asking ??= (this.send('profile', []) as Promise<FlagsConsoleProfile>).finally(() => {
        this.#asking = undefined;
      });
      const profile = profileOf(await this.#asking);
      const runtime = federatedRuntime(store, profile);
      this.#profile = { at: Date.now(), profile, runtime };
      return { runtime, reachable: true };
    } catch {
      if (cached) return { runtime: cached.runtime, reachable: false };
      const environment = this.#context.environment?.() ?? 'production';
      return {
        runtime: federatedRuntime(store, emptyProfile(this.key, environment)),
        reachable: false,
      };
    }
  }

  async close(): Promise<void> {
    const channel = await this.#channel?.catch(() => undefined);
    // A channel handed over in the config belongs to whoever made it.
    if (channel && !(this.#entry.controlPlane instanceof RedisConsoleChannel)) {
      await channel.close();
    }
  }
}

function emptyProfile(app: string, environment: string): FlagsConsoleProfile {
  return {
    app,
    environment,
    declarations: {},
    metrics: {},
    experiments: {},
    approvals: [],
    analytics: false,
    actions: false,
  };
}

/** A profile as received, with every field defaulted (an app on an older version may omit some). */
function profileOf(raw: unknown): FlagsConsoleProfile {
  const value = plainObject(raw);
  if (typeof value.app !== 'string' || typeof value.environment !== 'string') {
    throw new Error('malformed profile');
  }
  return {
    app: value.app,
    environment: value.environment,
    declarations: plainObject(value.declarations) as Record<string, FlagDeclaration>,
    metrics: plainObject(value.metrics) as Record<string, MetricDefinition>,
    experiments: plainObject(value.experiments) as Record<string, ExperimentConfig>,
    approvals:
      value.approvals === true
        ? true
        : Array.isArray(value.approvals)
          ? value.approvals.filter((e): e is string => typeof e === 'string')
          : [],
    analytics: value.analytics === true,
    actions: value.actions !== false,
  };
}

/** The request without `app`: it picked the federated app, it is no filter on that app's data. */
function withoutApp(req: ApiRequest): ApiRequest {
  const { app: _app, ...query } = req.query;
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body) && 'app' in body) {
    const { app: _bodyApp, ...rest } = body as Record<string, unknown>;
    return { ...req, query, body: rest };
  }
  return { ...req, query };
}

/** A command's failure as the console's answer. */
function failure(error: unknown, label: string): ApiResponse {
  if (error instanceof FlagsConsoleChannelError) {
    return {
      status: 503,
      body: { error: `${label} did not answer: ${error.message}`, code: APP_UNREACHABLE },
    };
  }
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  const message = error instanceof Error ? error.message : String(error);
  if (code === UNSUPPORTED) {
    return { status: 501, body: { error: `${label} does not answer this yet: ${message}` } };
  }
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return { status, body: { error: message } };
  }
  return { status: 502, body: { error: `${label} failed: ${message}` } };
}

/** An answer the app sent back, checked: `{ status, body }`. */
function responseOf(data: unknown): ApiResponse {
  const value = plainObject(data);
  if (typeof value.status !== 'number' || !('body' in value)) {
    throw new Error('malformed answer');
  }
  return { status: value.status, body: value.body };
}

/**
 * The other apps of `apps` in config/flags_dashboard.ts: which ones exist, and every console call
 * for one of them, answered from its tables or sent to the app.
 */
export class FederatedFlagsConsole {
  readonly #apps = new Map<string, FederatedApp>();

  constructor(apps: Record<string, FederatedFlagsApp>, context: FederationContext) {
    for (const [key, entry] of Object.entries(apps)) {
      validateFederatedApp(key, entry);
      this.#apps.set(key, new FederatedApp(key, entry, context));
    }
  }

  get size(): number {
    return this.#apps.size;
  }

  has(key: string): boolean {
    return this.#apps.has(key);
  }

  /** The apps a viewer limited to `visible` (`undefined`: every app) is offered. */
  list(visible?: (key: string) => boolean): FederatedAppInfo[] {
    return [...this.#apps.values()]
      .filter((app) => visible?.(app.key) ?? true)
      .map((app) => app.info());
  }

  /** Answer one console call for the app `key`, the way its handler `name` would there. */
  async dispatch(
    key: string,
    name: ConsoleHandlerName,
    deps: Pick<Deps, 'actor' | 'now'>,
    request: ApiRequest,
  ): Promise<ApiResponse> {
    const app = this.#apps.get(key);
    if (!app) return { status: 404, body: { error: `unknown app "${key}"` } };
    const req = withoutApp(request);
    try {
      if (STORE_READ_SET.has(name)) {
        const handler = handlerOf(name)!;
        const { runtime, reachable } = await app.runtime();
        const result = await handler(
          { runtime, actor: deps.actor, ...(deps.now ? { now: deps.now } : {}) },
          req,
        );
        if (name === 'meta' && result.status === 200) {
          return {
            status: 200,
            body: {
              ...(result.body as Record<string, unknown>),
              federated: { ...app.info(), reachable },
            },
          };
        }
        return result;
      }
      if (ACTION_SET.has(name) && !app.actions) {
        return {
          status: 403,
          body: { error: `${app.label} is read-only in this console: change it in ${app.label}.` },
        };
      }
      if (APP_READ_SET.has(name) || ACTION_SET.has(name)) {
        return responseOf(await app.send(name, [req], deps.actor));
      }
      return { status: 501, body: { error: `${name} is not available for a federated app` } };
    } catch (error) {
      return failure(error, app.label);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.#apps.values()].map((app) => app.close()));
  }
}

/**
 * Start answering other consoles' commands on `client` (`consoleCommands` in config/flags.ts).
 * Returns the channel, to close at shutdown.
 */
export async function answerConsoleCommands(options: {
  client: RedisLike;
  prefix: string;
  actions: boolean;
  runtime: () => FlagsRuntime;
  log?: ((line: string) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): Promise<RedisConsoleChannel> {
  const channel = new RedisConsoleChannel({ client: options.client, prefix: options.prefix });
  await channel.answer(
    flagsConsoleCommandHandler({
      runtime: options.runtime,
      actions: options.actions,
      log: options.log,
    }),
    options.onError ? { onError: options.onError } : {},
  );
  return channel;
}
