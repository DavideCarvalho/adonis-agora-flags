import { randomUUID } from 'node:crypto';
import type { MetricDefinition } from '@adonis-agora/flags-core';
import { FlagsAdmin } from '../admin.js';
import type { AnalyticsBackend } from '../analytics/backend.js';
import { deriveKeyPair, type OkpJwk } from '../crypto-kit/index.js';
import { FALLBACK_ACTOR } from '../dashboard/actor.js';
import {
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from '../dashboard/console_capabilities.js';
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
import { CONSOLE_SCOPES, type TenantTokenSource } from '../topology/token.js';
import type { TenantVerifierOption } from '../topology/verify.js';
import {
  type AuthkitClientLike,
  ConsoleAuthConfigError,
  type ConsoleSideAuth,
  type CryptoRuntimeLike,
  consoleAuthError,
  embeddedKeyGuard,
  optionalAppCallToken,
  RETRY_AFTER_MS,
  requiredAppCallToken,
  resolveConsoleSideAuth,
} from './console_auth.js';
import {
  APP_UNREACHABLE,
  type ChannelSecret,
  type ConsoleCipher,
  type ConsoleCryptoOption,
  FLAGS_CONSOLE_TIMEOUT_MS,
  FlagsConsoleChannelError,
  type FlagsConsoleCommand,
  RedisConsoleChannel,
  type RedisLike,
  TOKEN_UNAVAILABLE,
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
   * That app's name (`app` in its config/flags.ts), which is also its `@adonis-agora/crypto`
   * partition: in the automatic crypto mode, commands are sealed with the key `console-flags` of
   * this partition. Defaults to the key.
   */
  partition?: string | undefined;
  /**
   * Where that app keeps its flags tables: a Lucid `connection` of THIS app and the `schema` the
   * other app gives `schema` in its config/flags.ts. Only read (never created or altered): give
   * the connection's role `SELECT` on them. A {@link FlagsStore} instance also works.
   */
  store: { connection?: string | undefined; schema?: string | undefined } | FlagsStore;
  /**
   * Where that app answers commands (`consoleCommands` in its config/flags.ts): the
   * `@adonisjs/redis` connection to publish on, that app's `prefix`, and how this console proves
   * itself to the app: nothing to set when `@adonis-agora/crypto` is embedded in this app
   * (automatic), else one of `crypto`, `token` + `publicKey`, or `secret` (see
   * {@link FederatedControlPlane}). Without one, the boot fails unless `actions: false`.
   */
  controlPlane: FederatedControlPlane | RedisConsoleChannel;
  /** Whether this console may change that app's flags. Default `true`; `false` browses only. */
  actions?: boolean | undefined;
  /** How long a command waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** How a federated console reaches one app, and how it authenticates to it. */
export interface FederatedControlPlane {
  connection?: string | undefined;
  prefix: string;
  /**
   * Shared-secret mode (no authkit, no crypto): the secret shared with that app (its
   * `consoleCommands.secret`), 16 characters at least. Every command and answer carries an HMAC.
   */
  secret?: ChannelSecret | undefined;
  /**
   * Token mode: this console's token for that app, e.g. `authkitTenantToken({ issuer, clientId,
   * clientSecret, resource: 'urn:agora:flags' })` of a service-tenant client whose `partition` is
   * that app's name and whose capabilities say what this console may do there
   * (`flags:console:read`, `:write`, `:approve`). The app checks it with its
   * `consoleCommands.verifyTenant`. Commands travel sealed to the app's command key: give it in
   * `publicKey` (or use `crypto`). Not needed with authkit's calls between apps set up in this app
   * (its app-call token is sent automatically); `false` turns that off.
   */
  token?: TenantTokenSource | false | undefined;
  /**
   * Token mode without `crypto`: the app's console-command public key, as `node ace
   * flags:console-key` prints it in that app (a JWK, or its JSON). Never read from Redis: copy it
   * from the app (an env var works). It changes when the app's `APP_KEY` or prefix changes.
   */
  publicKey?: OkpJwk | string | undefined;
  /**
   * Sealed with `@adonis-agora/crypto`, explicitly: the cipher this console encrypts with, for a
   * key of that app (`console-flags` by default) it may `encrypt` with and the app may `decrypt`.
   * Not needed where crypto is embedded in this app (the Hub): that is automatic. On a tenant of a
   * crypto server: a client for that partition. Combine with `token` when the app also checks one.
   * `false` turns the automatic crypto mode off.
   */
  crypto?: ConsoleCryptoOption | false | undefined;
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
  if (
    entry.partition !== undefined &&
    (typeof entry.partition !== 'string' || entry.partition === '')
  ) {
    fail("`partition` must be the app's name (`app` in its config/flags.ts)");
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
    // A token without crypto or publicKey may still be sealed to the key the app published in
    // authkit's directory: decided at boot, with the siblings (resolveConsoleSideAuth).
    if (plane.publicKey !== undefined) {
      try {
        parsePublicKey(plane.publicKey);
      } catch (error) {
        fail(`\`controlPlane.publicKey\`: ${(error as Error).message}`);
      }
    }
    if (
      plane.crypto !== undefined &&
      plane.crypto !== false &&
      (!plane.crypto ||
        typeof plane.crypto !== 'object' ||
        (typeof plane.crypto.cipher !== 'function' && typeof plane.crypto.cipher !== 'object'))
    ) {
      fail('`controlPlane.crypto` must be { cipher, key? } (or false)');
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

/** Console writes that decide a change request: they need {@link CONSOLE_SCOPES}.approve. */
const APPROVALS: ReadonlySet<string> = new Set(['approveChangeRequest', 'rejectChangeRequest']);

/** The capability a verb needs from a console's token (token mode). */
export function consoleCapabilityOf(verb: string): string {
  if (APPROVALS.has(verb)) return CONSOLE_SCOPES.approve;
  if (ACTION_SET.has(verb)) return CONSOLE_SCOPES.write;
  return CONSOLE_SCOPES.read;
}

const forbidden = (message: string, code?: string) =>
  Object.assign(new Error(`[@adonis-agora/flags] ${message}`), {
    status: 403,
    ...(code ? { code } : {}),
  });

/** The refusal code of a command without capabilities (the same in every Agora lib). */
export const CAPABILITIES_REQUIRED = 'capabilities-required';

/**
 * Answers the commands another app's flags console sends this app: `profile`, the reads only this
 * app can answer, and (with `actions`) every write, run by this app's own console handlers, so
 * validation, `authorize`, approvals and the audit log apply as in its own console.
 *
 * Commands reach it only through an authenticated channel. Every command carries the capabilities
 * the console grants its viewer, and one without them is refused. In token mode (the channel
 * verified the console's token and set `verified`), the token's partition must be this app and the
 * effective capabilities are the token's ∩ the message's.
 */
export function flagsConsoleCommandHandler(options: {
  runtime: () => FlagsRuntime;
  actions: boolean;
  log?: ((line: string) => void) | undefined;
}): (command: FlagsConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const { verb, args } = command;
    const runtime = options.runtime();
    const verified = command.verified;
    // The order is the same in every Agora lib: verb known → capabilities present → token →
    // viewer → partition / actions.
    const handler =
      verb === 'profile'
        ? undefined
        : APP_READ_SET.has(verb) || ACTION_SET.has(verb)
          ? handlerOf(verb)
          : undefined;
    if (verb !== 'profile' && !handler) {
      throw Object.assign(
        new Error(`[@adonis-agora/flags] this app does not answer the console command ${verb}`),
        { code: UNSUPPORTED },
      );
    }
    // The console always says what its viewer may do: missing is never "everything".
    if (!Array.isArray(command.capabilities)) {
      throw forbidden(
        'refused a console command without capabilities: update @adonis-agora/flags on the console app',
        CAPABILITIES_REQUIRED,
      );
    }
    const required = consoleCapabilityOf(verb);
    // Token mode: the token caps it, and the message narrows it.
    if (verified && !flagsConsoleCapabilityAllows(verified.capabilities, required)) {
      throw forbidden(`the console's token lacks ${required}`);
    }
    if (!flagsConsoleCapabilityAllows(command.capabilities, required)) {
      throw forbidden(`the viewer lacks ${required}`);
    }
    // An authkit app-call token is bound to this app by its audience: its partition is the caller.
    if (verified && !verified.appCall && verified.partition !== runtime.manager.app) {
      throw forbidden(
        `the console's token is for "${verified.partition}", not "${runtime.manager.app}"`,
      );
    }
    if (ACTION_SET.has(verb) && !options.actions) {
      throw forbidden(
        'this app does not take changes from another console (consoleCommands.actions is off)',
      );
    }
    if (!handler) return consoleProfile(runtime, options.actions);
    const actor = commandActor(command.actor);
    const req = commandRequest(args[0]);
    if (ACTION_SET.has(verb)) {
      options.log?.(
        logLine(verb, req, actor) +
          (verified?.appCall ? ` via ${verified.clientId ?? verified.partition}` : ''),
      );
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
      /**
       * Take changes (not only reads) from another console. Default `false`: set `actions: true`
       * to let it change flags.
       */
      actions?: boolean | undefined;
      /**
       * Token mode (with authkit): checks the token each command carries, e.g.
       * `authkitTenantVerifier({ issuer, resource: 'urn:agora:flags' })`. The token's `partition`
       * must be this app (`app` in config/flags.ts), and its capabilities cap what the console may
       * do (`flags:console:read` / `:write` / `:approve`). Commands arrive sealed to a key derived
       * from `APP_KEY`; `node ace flags:console-key` prints its public half for the console's
       * `controlPlane.publicKey`. When this is not set, the verifiers this app already has are
       * used: a control plane's own `verifyTenant`, and authkit's app-call tokens (calls between
       * apps); `false` turns those off.
       */
      verifyTenant?: TenantVerifierOption | false | undefined;
      /**
       * Sealed with `@adonis-agora/crypto`, explicitly. Not needed when `@adonis-agora/crypto` is
       * booted in this app: commands are then sealed with its key `console-flags` automatically.
       * Explicitly: `{ cipher, key? }`, a cipher that may `decrypt` with the key (`() =>
       * crypto.client!` on a tenant of a crypto server). With `verifyTenant` too, each command must
       * also carry a valid token. `false` turns the automatic crypto mode off.
       */
      crypto?: ConsoleCryptoOption | false | undefined;
      /**
       * Shared-secret mode (no authkit, no crypto): the secret this app and the console share (the
       * console's `apps.<key>.controlPlane.secret`), 16 characters at least.
       */
      secret?: ChannelSecret | undefined;
    };

/** `consoleCommands` with its defaults. */
export interface ResolvedConsoleCommands {
  prefix: string;
  connection: string | undefined;
  actions: boolean;
  verifyTenant?: TenantVerifierOption | false | undefined;
  crypto?: ConsoleCryptoOption | false | undefined;
  secret?: ChannelSecret | undefined;
}

/** `consoleCommands` with its defaults, or `undefined` when off. */
export function resolveConsoleCommands(
  option: ConsoleCommandsOption | undefined,
  app: string,
): ResolvedConsoleCommands | undefined {
  if (!option) return undefined;
  const value = option === true ? {} : option;
  const prefix = value.prefix ?? app;
  if (typeof prefix !== 'string' || prefix.trim() === '') {
    throw new Error('[@adonis-agora/flags] consoleCommands.prefix must not be empty');
  }
  return {
    prefix,
    connection: value.connection,
    // Opt-in: another console only changes this app's flags when it says so.
    actions: value.actions === true,
    ...(value.verifyTenant !== undefined ? { verifyTenant: value.verifyTenant } : {}),
    ...(value.crypto !== undefined ? { crypto: value.crypto } : {}),
    ...(value.secret !== undefined ? { secret: value.secret } : {}),
  };
}

/**
 * This app's console-command key pair (token mode), derived from its `APP_KEY` and the prefix: the
 * same on every instance, nothing to store. The console seals each command (and its token) to the
 * public half, which it is given out of band (`controlPlane.publicKey`).
 */
export function consoleCommandKeys(
  appKey: string | { release(): string },
  prefix: string,
): { publicKey: OkpJwk; privateKey: OkpJwk } {
  return deriveKeyPair('x25519', appKey, `flags:console-commands:${prefix}`);
}

/** A console-command public key as configured (a JWK or its JSON), checked. */
export function parsePublicKey(value: OkpJwk | string): OkpJwk {
  let jwk: unknown = value;
  if (typeof value === 'string') {
    try {
      jwk = JSON.parse(value);
    } catch {
      throw new Error('must be the JSON `node ace flags:console-key` prints, or that object');
    }
  }
  const key = jwk as Partial<OkpJwk> | null;
  if (
    !key ||
    typeof key !== 'object' ||
    key.kty !== 'OKP' ||
    key.crv !== 'X25519' ||
    typeof key.x !== 'string' ||
    typeof key.kid !== 'string'
  ) {
    throw new Error('must be an X25519 public JWK ({ kty: "OKP", crv: "X25519", x, kid })');
  }
  if ('d' in key) throw new Error('is a private key: give the console the public half only');
  return { kty: 'OKP', crv: 'X25519', x: key.x, kid: key.kid, use: 'enc', alg: 'ECDH-ES' };
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

/**
 * flags' console capabilities, for the shared matcher: `flags:console:read` reads,
 * `flags:console:write` writes. `flags:console:approve` is in neither list on purpose (separation of
 * duty): `flags:console:write` does not imply it; only an exact grant or a literal alias
 * (`flags:console:*`, `flags:*`, `*`) does.
 */
export const FLAGS_CONSOLE_CAPABILITIES: ConsoleCapabilityTable = {
  [CONSOLE_SCOPES.read]: 'read',
  [CONSOLE_SCOPES.write]: 'write',
};

/** Whether `granted` allows the console capability `required` (the shared matcher, §10.16b). */
export function flagsConsoleCapabilityAllows(
  granted: readonly unknown[] | undefined,
  required: string,
): boolean {
  return consoleCapabilityAllows(granted, required, FLAGS_CONSOLE_CAPABILITIES);
}

/** Every console capability: what is sent when the console's `authorize` does not narrow. */
export const ALL_CONSOLE_CAPABILITIES: readonly string[] = Object.values(CONSOLE_SCOPES);

/**
 * The capabilities the console sends for a viewer: flags' console capabilities that what
 * `authorize` answered reaches (`flags:console:*`, `flags:*`, `*` and the exact names), the full set
 * when it answered none, and no write capability with `access: 'read'`. Anything else is dropped.
 */
export function viewerConsoleCapabilities(
  capabilities: readonly string[] | undefined,
  access?: 'read' | 'write' | undefined,
): string[] {
  const reached =
    capabilities === undefined
      ? [...ALL_CONSOLE_CAPABILITIES]
      : ALL_CONSOLE_CAPABILITIES.filter((c) => flagsConsoleCapabilityAllows(capabilities, c));
  return access === 'read' ? reached.filter((c) => c === CONSOLE_SCOPES.read) : reached;
}

class FederatedApp {
  readonly label: string;
  readonly actions: boolean;
  readonly partition: string;
  /** How commands are sent, once {@link FederatedFlagsConsole.authenticate} decided it. */
  #auth:
    | {
        crypto?: ConsoleCryptoOption | undefined;
        token?: TenantTokenSource | undefined;
        recipient?: (() => Promise<OkpJwk>) | undefined;
        auto?: ConsoleSideAuth['auto'];
        tokenOptional?: boolean | undefined;
      }
    | undefined;
  #warn: (line: string) => void = () => {};
  #info: (line: string) => void = () => {};
  /** §13a: the per-app choice (token when the app publishes a key, else crypto), and its channels. */
  #decision: { mode: 'token' | 'crypto'; at: number; key?: OkpJwk } | undefined;
  #autoChannels: { token?: Promise<RedisConsoleChannel>; crypto?: Promise<RedisConsoleChannel> } =
    {};
  #optionalToken: ReturnType<typeof optionalAppCallToken> | undefined;
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
    this.partition = entry.partition ?? key;
  }

  /**
   * Decide how this console authenticates to the app (explicit options, else the sibling libs:
   * crypto's key, authkit's app-call token), making sure of the key where crypto is embedded (a
   * failure is logged and retried on the first command, never fatal). Returns the mode, or throws
   * when none resolves and the app takes actions.
   */
  async authenticate(siblings: {
    crypto?: CryptoRuntimeLike | undefined;
    authkit?: AuthkitClientLike | undefined;
    warn?: ((line: string) => void) | undefined;
    info?: ((line: string) => void) | undefined;
  }): Promise<string | undefined> {
    const plane = this.#entry.controlPlane;
    if (plane instanceof RedisConsoleChannel) {
      if (!plane.signed && this.actions) {
        throw new ConsoleAuthConfigError(
          consoleAuthError(this.key, [
            'the RedisConsoleChannel given as controlPlane has no crypto, token or secret',
          ]),
        );
      }
      return plane.signed ? 'the RedisConsoleChannel given' : undefined;
    }
    const auth = resolveConsoleSideAuth({
      key: this.key,
      partition: this.partition,
      plane,
      actions: this.actions,
      crypto: siblings.crypto,
      authkit: siblings.authkit,
    });
    if (auth.error) throw new ConsoleAuthConfigError(auth.error);
    let crypto = auth.crypto;
    if (auth.ensureKey && crypto) {
      const { service, partition, key } = auth.ensureKey;
      const guard = embeddedKeyGuard(service, partition, key);
      await guard.boot({
        warn: (line) => siblings.warn?.(line),
        info: (line) => siblings.info?.(line),
      });
      crypto = { ...crypto, cipher: guard.wrap(crypto.cipher as ConsoleCipher) };
    }
    this.#warn = (line) => siblings.warn?.(line);
    this.#info = (line) => (siblings.info ?? siblings.warn)?.(line);
    this.#auth = {
      crypto,
      token: auth.token,
      recipient: auth.recipient,
      auto: auth.auto,
      tokenOptional: auth.tokenOptional,
    };
    return auth.mode;
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
      // Decided at boot (explicit options, or the sibling libs); else the explicit options only.
      const crypto = this.#auth ? this.#auth.crypto : plane.crypto || undefined;
      const token = this.#tokenFor(crypto !== undefined);
      const publicKey =
        plane.publicKey !== undefined && !crypto ? parsePublicKey(plane.publicKey) : undefined;
      return new RedisConsoleChannel({
        client: await this.#context.redis(plane.connection),
        prefix: plane.prefix,
        ...(plane.secret !== undefined ? { secret: plane.secret } : {}),
        ...(crypto !== undefined ? { crypto } : {}),
        ...(token !== undefined ? { token } : {}),
        // The app's APP_KEY-derived key, given in the config (never taken from Redis).
        // The configured key wins; else the one the app published in authkit's directory.
        ...(publicKey
          ? { recipient: async () => publicKey }
          : this.#auth?.recipient
            ? {
                recipient: async () => parsePublicKey((await this.#auth!.recipient!()) as OkpJwk),
              }
            : {}),
      });
    })();
    this.#channel.catch(() => {
      this.#channel = undefined;
    });
    return this.#channel;
  }

  /** The token to send with: optional next to crypto (§13b), required (with the grant hint) alone. */
  #tokenFor(withCrypto: boolean): TenantTokenSource | undefined {
    const plane = this.#entry.controlPlane as FederatedControlPlane;
    const token = this.#auth ? this.#auth.token : plane.token || undefined;
    if (token === undefined || !this.#auth) return token;
    // Only the automatic app-call token is wrapped: an explicit token is used as given.
    if (plane.token) return token;
    return withCrypto && this.#auth.tokenOptional !== false
      ? optionalAppCallToken(token, this.partition, this.#warn, Date.now, this.#info)
      : requiredAppCallToken(token, this.partition);
  }

  /**
   * §13a: the channel for this command. With an automatic choice, the app's key in authkit's
   * directory means token mode (the app runs it and publishes the key), else crypto; the choice
   * is kept for 5 minutes, or until the app does not take it.
   */
  async #channelForSend(): Promise<RedisConsoleChannel> {
    const auto = this.#auth?.auto;
    if (!auto) return this.channel();
    const now = Date.now();
    if (!this.#decision || now - this.#decision.at > RETRY_AFTER_MS) {
      const key = await auto.directory();
      this.#decision = key ? { mode: 'token', at: now, key } : { mode: 'crypto', at: now };
    }
    const decision = this.#decision;
    const plane = this.#entry.controlPlane as FederatedControlPlane;
    // One optional token for the whole entry: a failure is said once per reason and retried after
    // 5 minutes.
    this.#optionalToken ??= optionalAppCallToken(
      auto.token,
      this.partition,
      this.#warn,
      Date.now,
      this.#info,
    );
    const make = (options: Partial<ConstructorParameters<typeof RedisConsoleChannel>[0]>) =>
      (async () =>
        new RedisConsoleChannel({
          client: await this.#context.redis(plane.connection),
          prefix: plane.prefix,
          ...options,
        }))();
    if (decision.mode === 'token') {
      // The token is minted once, by the channel, when it seals the command. A failure comes back
      // as TOKEN_UNAVAILABLE, and `send` takes crypto instead (§13a).
      const required = requiredAppCallToken(auto.token, this.partition);
      this.#autoChannels.token ??= make({
        token: {
          get: async () => {
            try {
              return await required.get();
            } catch (error) {
              const text = error instanceof Error ? error.message : String(error);
              const reason = (error as { reason?: unknown }).reason;
              throw Object.assign(new FlagsConsoleChannelError(text, TOKEN_UNAVAILABLE), {
                tokenReason: typeof reason === 'string' ? reason : text,
                tokenCode: (error as { reasonCode?: unknown }).reasonCode,
              });
            }
          },
          invalidate: () => required.invalidate(),
        },
        // The key the app published, as last looked up (re-read when the decision is renewed).
        recipient: async () => parsePublicKey((this.#decision?.key ?? decision.key) as OkpJwk),
      });
      return this.#autoChannels.token;
    }
    return this.#cryptoChannel(make);
  }

  #cryptoChannel(
    make: (
      options: Partial<ConstructorParameters<typeof RedisConsoleChannel>[0]>,
    ) => Promise<RedisConsoleChannel>,
  ): Promise<RedisConsoleChannel> {
    this.#autoChannels.crypto ??= make({
      crypto: this.#auth!.crypto!,
      token: this.#optionalToken!,
    });
    return this.#autoChannels.crypto;
  }

  /**
   * Send a command and wait for the app's answer (throws a channel error when nobody answers).
   * `capabilities`: what the viewer may do there, always sent (the app refuses a command without).
   */
  async send(
    verb: string,
    args: unknown[],
    actor?: Actor,
    capabilities: readonly string[] = ALL_CONSOLE_CAPABILITIES,
  ): Promise<unknown> {
    let channel = await this.#channelForSend();
    let reply: Awaited<ReturnType<RedisConsoleChannel['send']>>;
    try {
      try {
        reply = await this.#sendOn(channel, verb, args, actor, capabilities);
      } catch (error) {
        // §13a: token mode, but the token cannot be minted (no grant, authkit down): crypto reaches
        // the app too, so this command, and the next ones for 5 minutes, go that way (§13b warning,
        // once per reason; no new mint inside the window).
        if (
          !this.#auth?.auto ||
          channel !== (await this.#autoChannels.token) ||
          (error as { code?: unknown }).code !== TOKEN_UNAVAILABLE
        ) {
          throw error;
        }
        const reason = (error as { tokenReason?: unknown }).tokenReason;
        this.#optionalToken!.failed(
          typeof reason === 'string'
            ? reason
            : error instanceof Error
              ? error.message
              : String(error),
          (error as { tokenCode?: unknown }).tokenCode,
        );
        this.#decision = { mode: 'crypto', at: Date.now() };
        channel = await this.#channelForSend();
        reply = await this.#sendOn(channel, verb, args, actor, capabilities);
      }
    } catch (error) {
      // The app did not take the mode it was sent in (or did not answer): decide again next time.
      if (this.#auth?.auto) this.#decision = undefined;
      throw error;
    }
    if (!reply.ok && /mode not accepted here/.test(reply.error.message)) {
      this.#decision = undefined;
    }
    if (reply.ok) return reply.data;
    throw Object.assign(new Error(reply.error.message), {
      ...(reply.error.code !== undefined ? { code: reply.error.code } : {}),
      ...(reply.error.status !== undefined ? { status: reply.error.status } : {}),
      fromApp: true,
    });
  }

  #sendOn(
    channel: RedisConsoleChannel,
    verb: string,
    args: unknown[],
    actor: Actor | undefined,
    capabilities: readonly string[],
  ) {
    return channel.send(
      {
        id: randomUUID(),
        verb,
        args,
        capabilities: [...capabilities],
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
      // Shared by every viewer: asked with the read capability only.
      this.#asking ??= (
        this.send('profile', [], undefined, [CONSOLE_SCOPES.read]) as Promise<FlagsConsoleProfile>
      ).finally(() => {
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
    for (const auto of [this.#autoChannels.token, this.#autoChannels.crypto]) {
      await (await auto?.catch(() => undefined))?.close();
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

  /**
   * Decide, at boot, how this console authenticates to each app: explicit options, else the
   * sibling libs booted in this app (`@adonis-agora/crypto`: the key `console-flags` of each app's
   * partition, created where crypto is embedded; authkit: its app-call token). An app that takes
   * actions and has no way throws with `strict` (a web server), else is reported through `warn`.
   * Returns one log line per app.
   */
  async authenticate(siblings: {
    crypto?: CryptoRuntimeLike | undefined;
    authkit?: AuthkitClientLike | undefined;
    warn?: ((line: string) => void) | undefined;
    info?: ((line: string) => void) | undefined;
    strict?: boolean | undefined;
  }): Promise<string[]> {
    const lines: string[] = [];
    for (const app of this.#apps.values()) {
      let mode: string | undefined;
      try {
        mode = await app.authenticate(siblings);
      } catch (error) {
        if (siblings.strict !== false) throw error;
        siblings.warn?.((error as Error).message);
        continue;
      }
      lines.push(
        `[@adonis-agora/flags] console commands to "${app.key}": ${mode ?? 'none (browse-only: actions: false)'}`,
      );
    }
    return lines;
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
    deps: Pick<Deps, 'actor' | 'now'> & { capabilities?: readonly string[] | undefined },
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
        return responseOf(await app.send(name, [req], deps.actor, deps.capabilities));
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
  /** Shared-secret mode: the console's `controlPlane.secret`. */
  secret?: ChannelSecret | undefined;
  /** Sealed with `@adonis-agora/crypto`. */
  crypto?: ConsoleCryptoOption | undefined;
  /** Token mode: checks the console's token. */
  verifyTenant?: TenantVerifierOption | undefined;
  /** Whether a crypto-sealed command must carry a token (default `true` with `verifyTenant`). */
  cryptoTokenRequired?: boolean | undefined;
  /** Token mode without crypto: this app's command key pair ({@link consoleCommandKeys}). */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk } | undefined;
  log?: ((line: string) => void) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): Promise<RedisConsoleChannel> {
  const channel = new RedisConsoleChannel({
    client: options.client,
    prefix: options.prefix,
    partition: options.runtime().manager.app,
    ...(options.secret !== undefined ? { secret: options.secret } : {}),
    ...(options.crypto !== undefined ? { crypto: options.crypto } : {}),
    ...(options.verifyTenant !== undefined ? { verifyTenant: options.verifyTenant } : {}),
    ...(options.keys !== undefined ? { keys: options.keys } : {}),
    ...(options.cryptoTokenRequired !== undefined
      ? { cryptoTokenRequired: options.cryptoTokenRequired }
      : {}),
  });
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
