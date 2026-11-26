import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import type { AdminAuthorizer, ApprovalsConfig } from './admin.js';
import type { AnalyticsBackend } from './analytics/backend.js';
import { ClickHouseBackend } from './analytics/clickhouse_backend.js';
import { DuckDbBackend, type DuckDbOptions } from './analytics/duckdb.js';
import { LucidBackend } from './analytics/lucid_backend.js';
import type { MetricDefinition } from './analytics/metrics.js';
import type { FlagDeclaration } from './declare.js';
import type { Enricher } from './enrichers.js';
import type { BufferOptions } from './events/buffer.js';
import type { FlagEvent } from './events/event.js';
import type { ConsoleCommandsOption } from './federation/console.js';
import type { FlagsIdentityProvider } from './identity.js';
import type { RelayOptions } from './relay/relay.js';
import { type ClickHouseOptions, ClickHouseSink } from './sinks/clickhouse.js';
import { LucidSink } from './sinks/lucid_sink.js';
import { ParquetSink, type ParquetSinkOptions } from './sinks/parquet_sink.js';
import { PostHogSink, type PostHogSinkOptions } from './sinks/posthog_sink.js';
import { CallbackSink, MemorySink, type Sink } from './sinks/sink.js';
import type { SqlDatabase } from './sql.js';
import {
  describeStackUse,
  fileUse,
  hasLucidConnection,
  hostOf,
  lucidUse,
  redisUse,
  type StackUse,
} from './stack.js';
import { LucidStore } from './stores/lucid_store.js';
import { MemoryStore } from './stores/memory_store.js';
import type { FlagsStore } from './stores/store.js';
import type { Subject, SubjectLike } from './subject.js';
import type { DeadLetter } from './tenant_transports/message.js';
import type { TenantTransport, WatchTransport } from './tenant_transports/types.js';
import type { TenantTokenSource } from './topology/token.js';
import { isTenantUrl, type TenantUrl } from './topology/url.js';
import type { TenantVerifierOption, UserVerifier } from './topology/verify.js';
import { DbTransport, type DbTransportOptions } from './transports/db_transport.js';
import { MemoryTransport } from './transports/memory_transport.js';
import { QueueTransport, type QueueTransportOptions } from './transports/queue_transport.js';
import {
  type RedisStreamClient,
  RedisTransport,
  type RedisTransportOptions,
} from './transports/redis_transport.js';
import type { Transport } from './transports/transport.js';

/** What factories receive: the app and lazy access to its database and Redis connections. */
export interface FactoryContext {
  app?: ApplicationService;
  /** The application's name (its package.json `name`), the default `app` stamped on events. */
  appName?: string | undefined;
  /** A Lucid query client for `connection` (default connection when omitted). */
  db(connection?: string): Promise<SqlDatabase>;
  redis(connection?: string): Promise<RedisStreamClient>;
  autoCreateSchema: boolean;
  partitionEvents: boolean;
}

export type Factory<T> = (context: FactoryContext) => T | Promise<T>;

/** Lucid-backed factories and the connection they were given (`undefined`: the default). */
const lucidFactories = new WeakMap<object, { connection: string | undefined }>();

function lucidFactory<T>(
  connection: string | undefined,
  purpose: string,
  factory: Factory<T>,
): Factory<T> {
  lucidFactories.set(factory, { connection });
  return describeStackUse(factory, () => lucidUse(connection, purpose));
}

function clickhouseUse(options: ClickHouseOptions, purpose: string): StackUse {
  const host = hostOf(options.url);
  return {
    tech: 'clickhouse',
    label: options.database ?? 'default',
    ...(host ? { host } : {}),
    purpose,
  };
}

export const stores = {
  /** The ruleset in your database (Postgres, MySQL, SQLite). The default. */
  lucid(options: { connection?: string } = {}): Factory<FlagsStore> {
    return lucidFactory(
      options.connection,
      'ruleset',
      async (ctx) =>
        new LucidStore(await ctx.db(options.connection), {
          autoCreateSchema: ctx.autoCreateSchema,
          partitionEvents: ctx.partitionEvents,
        }),
    );
  },
  /** In process memory: tests and local development. */
  memory(seed?: ConstructorParameters<typeof MemoryStore>[0]): Factory<FlagsStore> {
    return () => new MemoryStore(seed);
  },
};

export const transports = {
  /** The event log in your database. Transactional; the default when the store is `lucid`. */
  db(options: DbTransportOptions & { connection?: string } = {}): Factory<Transport> {
    return describeStackUse(
      async (ctx: FactoryContext) =>
        new DbTransport(await ctx.db(options.connection), {
          autoCreateSchema: ctx.autoCreateSchema,
          partitionEvents: ctx.partitionEvents,
          ...options,
        }),
      () => lucidUse(options.connection, 'event log'),
    );
  },
  /** Redis Streams through `@adonisjs/redis`. */
  redis(options: RedisTransportOptions & { connection?: string } = {}): Factory<Transport> {
    return describeStackUse(
      async (ctx: FactoryContext) =>
        new RedisTransport(await ctx.redis(options.connection), options),
      () => redisUse(options.connection, 'event log'),
    );
  },
  /**
   * Jobs on `@adonisjs/queue`: one job per batch per sink, run by your queue workers with the
   * queue's retries. No replay, not transactional.
   */
  queue(options: QueueTransportOptions = {}): Factory<Transport> {
    return async (ctx) => {
      const container = ctx.app?.container;
      if (container) {
        if (!container.hasBinding('queue.manager'))
          throw new Error(
            'the "queue" transport needs @adonisjs/queue configured (node ace add @adonisjs/queue)',
          );
        // Initializes the queue manager (adapters from config/queue.ts) before the first dispatch.
        await container.make('queue.manager' as never);
      }
      const logger = container?.hasBinding('logger')
        ? ((await container.make('logger')) as { warn(m: string): void; error(m: string): void })
        : undefined;
      return new QueueTransport(options, logger);
    };
  },
  /** In process memory: tests and local development. */
  memory(): Factory<Transport> {
    return () => new MemoryTransport();
  },
};

export const sinks = {
  /** Analysis tables in your database (`flags_exposures`, `flags_tracks`); read by `analytics.lucid()`. */
  lucid(
    options: { connection?: string; batchSize?: number; intervalMs?: number } = {},
  ): Factory<Sink> {
    return lucidFactory(
      options.connection,
      'exposures',
      async (ctx) =>
        new LucidSink(await ctx.db(options.connection), {
          autoCreateSchema: ctx.autoCreateSchema,
          ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
          ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
        }),
    );
  },
  posthog(options: PostHogSinkOptions): Factory<Sink> {
    const host = hostOf(options.host ?? 'https://us.i.posthog.com');
    return describeStackUse(() => new PostHogSink(options), {
      tech: 'posthog',
      label: 'posthog',
      ...(host ? { host } : {}),
      purpose: 'exposures',
    });
  },
  clickhouse(
    options: ClickHouseOptions & {
      batchSize?: number;
      intervalMs?: number;
      autoCreateSchema?: boolean;
    },
  ): Factory<Sink> {
    return describeStackUse(() => new ClickHouseSink(options), clickhouseUse(options, 'exposures'));
  },
  /** Parquet files through DuckDB (`@duckdb/node-api`); read by `analytics.duckdb()`. */
  parquet(options: ParquetSinkOptions): Factory<Sink> {
    return describeStackUse(() => new ParquetSink(options), fileUse(options.path, 'exposures'));
  },
  /** Your function receives every batch. Must be idempotent by `event.id`. */
  callback(
    fn: (events: FlagEvent[]) => Promise<void>,
    options: { batchSize?: number; intervalMs?: number } = {},
  ): Factory<Sink> {
    return () => new CallbackSink(fn, options.batchSize, options.intervalMs);
  },
  memory(): Factory<Sink> {
    return () => new MemorySink();
  },
};

export const analytics = {
  lucid(options: { connection?: string } = {}): Factory<AnalyticsBackend> {
    return describeStackUse(
      async (ctx: FactoryContext) => new LucidBackend(await ctx.db(options.connection)),
      () => lucidUse(options.connection, 'experiments'),
    );
  },
  duckdb(options: DuckDbOptions & { path: string }): Factory<AnalyticsBackend> {
    // In-process DuckDB over the Parquet files: the files are the infrastructure.
    return describeStackUse(() => new DuckDbBackend(options), fileUse(options.path, 'experiments'));
  },
  clickhouse(options: ClickHouseOptions): Factory<AnalyticsBackend> {
    return describeStackUse(
      () => new ClickHouseBackend(options),
      clickhouseUse(options, 'experiments'),
    );
  },
};

/** An experiment's analysis: which metrics decide it and which must not regress. */
export interface ExperimentConfig {
  metrics: string[];
  guardrails?: string[];
  /** Control variant. Default: the flag's `offVariant`. */
  control?: string;
  /** Confidence for fixed-horizon tests. Default 0.95. */
  confidence?: number;
  /** The flag that assigns it, when the experiment key differs from the flag key. */
  flag?: string;
}

interface BaseConfig<F extends Record<string, FlagDeclaration>> {
  /** Flags declared in code: types and defaults. Targeting lives in the store. */
  flags: F;
  /** Name stamped on events (a tenant uses its `partition`). Default: the app's name. */
  app?: string;
  /** Which environment's ruleset this process reads. Default `production`. */
  environment?: string;
  /** Which part of a split deployment this process is. Default `all`. See the ecosystem spec. */
  role?: 'all' | 'api' | 'worker';
  /** How background work (relay, schedules, results) runs. Default `auto`. */
  dispatcher?: 'auto' | 'durable' | 'in-process';
  events?: {
    buffer?: BufferOptions;
  };
  enrichers?: Enricher[];
  /**
   * How flags learns who people are: the subject of `ctx.flags`, the console's actor and access, and
   * who may change what. `identities.authkit()`, `identities.adonisAuth({ … })`, or your own
   * `FlagsIdentityProvider`. Default: the authkit identity when `@adonis-agora/authkit-client` is
   * installed, else `ctx.auth.user`; the console keeps its own defaults.
   */
  identity?: FlagsIdentityProvider;
  /**
   * The subject of `ctx.flags`, overriding `identity`. Default: the identity provider's, else the
   * authkit identity, else `ctx.auth.user`, else anonymous.
   */
  subject?: (ctx: HttpContext) => SubjectLike | Promise<SubjectLike>;
  /** Extra targeting attributes for every subject. Server-side state only. */
  attributes?: (subject: Subject) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Count evaluations per flag for stale-flag detection. Default `true`. */
  usage?: boolean;
  /**
   * Frontends that read flags straight from the flags API (`remoteFlags` in
   * `@adonis-agora/flags-react`). Turns on, in every topology, the token endpoint
   * (`GET /_flags/token`): it signs the same subject `ctx.flags` uses — the authkit identity, or your
   * `subject` resolver — into a short-lived token. On standalone and control-plane apps it also
   * serves the flags API the token is for (`<prefix>/v1/client/*`).
   */
  browser?: BrowserConfig;
}

export interface BrowserConfig {
  /** Path of the token endpoint on this app. Default `/_flags/token`; `false` to mount none. */
  tokenRoute?: string | false;
  /** Token lifetime in seconds. Default 300. */
  ttlSeconds?: number;
  /**
   * The flags API URL handed to the browser with each token. Default: this app's `/_flags`
   * (standalone, control-plane) or `tenant.url` (tenant). Set it when browsers reach the flags
   * server under another address than the app does.
   */
  publicUrl?: string;
  /** Standalone and control-plane: route prefix of the flags API. Default `/_flags` (or `controlPlane.prefix`). */
  prefix?: string;
  /** Standalone and control-plane: origins allowed to call the flags API cross-origin. */
  corsOrigins?: string[];
  /**
   * Standalone and control-plane: secret the per-app signing keys derive from. Default: the app key
   * (`APP_KEY`). Rotating it invalidates outstanding tokens; frontends fetch new ones.
   */
  secret?: string;
  /**
   * Standalone and control-plane: also accept tokens this package did not mint — e.g.
   * `userVerifiers.authkit(...)` for authkit access tokens held by mobile apps.
   */
  verifyUser?: UserVerifier;
}

interface OwnedStateConfig {
  /** Where the ruleset lives. Default `stores.lucid()`. */
  store?: Factory<FlagsStore>;
  /** Default: `db` with a lucid store, `memory` with a memory store. */
  transport?: Factory<Transport>;
  /** Event destinations, by name. Default `{ warehouse: sinks.lucid() }` with a lucid store. */
  sinks?: Record<string, Factory<Sink>>;
  relay?: RelayOptions & {
    /** How often each sink is drained (ms). Default 5000. */
    intervalMs?: number;
  };
  /** Ruleset reload: poll interval and Postgres notifications. */
  refresh?: { intervalMs?: number; notify?: boolean };
  /** Where experiment numbers come from. Default `analytics.lucid()` when the lucid sink exists. */
  analytics?: Factory<AnalyticsBackend>;
  metrics?: Record<string, MetricDefinition>;
  /** Experiment key → its metrics. */
  experiments?: Record<string, ExperimentConfig>;
  /**
   * Environments whose experiment results the worker recomputes. Default: this process's
   * `environment`. Events carry their environment, so staging traffic never mixes with production.
   */
  resultsEnvironments?: string[];
  /** How often the worker recomputes experiment results (ms). Default 600000. */
  resultsIntervalMs?: number;
  /**
   * Keep subjects on the variant they were first exposed to when weights change. Reads the
   * subject's exposures once per request from the lucid sink's table. Default `false`.
   */
  sticky?: boolean;
  /** Events older than this (days) are pruned from the `db` transport once every sink has them. Default 30. */
  retentionDays?: number;
  /** Who may change flags (console, commands, admin API). */
  authorize?: AdminAuthorizer;
  /** Environments whose changes need a second person's approval. */
  approvals?: ApprovalsConfig;
  /** Create the tables at boot. Default `true` (the ecosystem convention). */
  autoCreateSchema?: boolean;
  /**
   * Keep every table in this Postgres schema (MySQL: database), created at boot if missing. Every
   * query names it (`flags.flags_events`), so nothing depends on `search_path`: safe behind
   * PgBouncer in transaction mode. Default: none (the connection's default schema).
   */
  schema?: string;
  /** Postgres: partition the event log by month. Default `false`. Decide before first boot. */
  partitionEvents?: boolean;
  /** Push ruleset changes to browsers through `@adonisjs/transmit`. Default `false`. */
  realtime?: { channel?: string } | boolean;
  /**
   * Let another app's flags console (its `apps` in config/flags_dashboard.ts) show and change this
   * app's flags. Every instance listens on Redis (`@adonisjs/redis`); exactly one runs each change,
   * through this app's own admin, so validation, approvals and the audit log apply. Commands are
   * authenticated: with `@adonis-agora/crypto` booted in this app, automatically (key
   * `console-flags`); otherwise set `secret` or `verifyTenant` (the boot fails without one).
   * Changes are taken only with `actions: true`. Default: off.
   */
  consoleCommands?: ConsoleCommandsOption;
}

export interface StandaloneConfig<F extends Record<string, FlagDeclaration>>
  extends BaseConfig<F>,
    OwnedStateConfig {
  topology?: 'standalone';
  /** Control-plane only. */
  verifyTenant?: never;
  controlPlane?: never;
  /** Tenant only. */
  diagnostics?: never;
}

export interface ControlPlaneConfig<F extends Record<string, FlagDeclaration>>
  extends BaseConfig<F>,
    OwnedStateConfig {
  topology: 'control-plane';
  /**
   * Authenticates tenants. The partition, environment and capabilities come from the verified
   * token, never from the request. A function, an object with `verify` (a class instance), or a
   * lazy import of one (`() => import('#tenants/verifier')`). With authkit:
   * `authkitTenantVerifier({ issuer, resource: 'urn:agora:flags' })` from
   * `@adonis-agora/authkit-client`; without: `sharedSecretVerifier({ partitions })`.
   */
  verifyTenant: TenantVerifierOption;
  controlPlane?: {
    /** Route prefix. Default `/_flags`. */
    prefix?: string;
    /** Serve the OpenFeature Remote Evaluation Protocol. Default `true`. */
    ofrep?: boolean;
    /** Origins allowed to call OFREP from browsers. Default: none (no CORS headers). */
    corsOrigins?: string[];
    /**
     * Brokers tenants talk to this server through, besides HTTP (`tenantTransports.redis()`, …).
     * The HTTP routes stay mounted whatever you list: browsers, OFREP and HTTP tenants use them.
     */
    transports?: TenantTransport[];
    /** Largest tenant message accepted over a broker (bytes). Default 1 MiB. */
    maxMessageBytes?: number;
    /** Called with each tenant message given up on (poison or out of attempts). Default: logs it. */
    onDeadLetter?: (letter: DeadLetter) => void | Promise<void>;
    /** Moved: `verifyTenant` is a top-level option. */
    verifyTenant?: never;
  };
  /** Tenant only. */
  diagnostics?: never;
}

export interface TenantConfig<F extends Record<string, FlagDeclaration>> extends BaseConfig<F> {
  topology: 'tenant';
  /** The control-plane connection. */
  tenant: {
    /**
     * The control-plane URL (`https://flags.example.com/_flags`), or a function resolving it
     * (`controlPlaneUrl(...)` from `@adonis-agora/authkit-client`): resolved before the first
     * request, refreshed (its `refresh()`) after a connection error or a 404. Needed by the `http`
     * transport (the default) and by `browser` (browsers always reach the control-plane over HTTP).
     */
    url?: TenantUrl;
    /**
     * How this app talks to the control-plane (server to server): `tenantTransports.http()` (the
     * default), `.queue()`, `.bullmq()`, `.redis()`, `.durable()`. Carries events, usage and
     * declarations, and the ruleset too when the driver can (`http`, `redis`, `durable`).
     */
    transport?: TenantTransport;
    /**
     * How the ruleset arrives, when it differs from `transport`: `http`, `redis` or `durable`.
     * Default: `transport` when it can carry the ruleset, else `http`.
     */
    watch?: WatchTransport;
    /**
     * The bearer token sent to the control-plane: a shared secret, a function returning a token
     * (`authkitTenantToken(...)` from `@adonis-agora/authkit-client`), or an object with `get()`.
     */
    token: TenantTokenSource;
    /** This app's name on the control-plane. */
    partition: string;
    /** File for the last ruleset received (served when the control-plane is down at boot). */
    snapshotPath?: string;
    stream?: boolean;
    intervalMs?: number;
    capabilities?: string[];
  };
  /**
   * Where exposures and tracks reach `@adonis-agora/diagnostics`. `'control-plane'` (default): the
   * control plane emits them, with `app` set to this tenant, once it has them; this app does not, so
   * nothing is recorded twice. `'local'`: this app emits them too (when the control plane does not
   * run diagnostics). Evaluations are always emitted here, with `app` set to `tenant.partition`.
   */
  diagnostics?: 'control-plane' | 'local';
  /** FORBIDDEN on a tenant: it owns no state; everything lives on the control-plane. */
  store?: never;
  transport?: never;
  sinks?: never;
  analytics?: never;
  approvals?: never;
  verifyTenant?: never;
  /** FORBIDDEN on a tenant: its flags are edited on the control-plane. */
  consoleCommands?: never;
}

export type FlagsConfig<
  F extends Record<string, FlagDeclaration> = Record<string, FlagDeclaration>,
> = StandaloneConfig<F> | ControlPlaneConfig<F> | TenantConfig<F>;

/**
 * Refuses shapes that cannot work: `verifyTenant` outside a control-plane or still nested under
 * `controlPlane`, a tenant without a token. Called by `defineConfig` and at boot.
 */
export function validateConfig(config: FlagsConfig): void {
  const raw = config as unknown as {
    topology?: string;
    role?: string;
    verifyTenant?: unknown;
    controlPlane?: Record<string, unknown>;
    diagnostics?: unknown;
    tenant?: {
      url?: unknown;
      partition?: string;
      token?: unknown;
      transport?: { driver?: string; canWatch?: boolean };
      watch?: { driver?: string; canWatch?: boolean };
    };
    browser?: unknown;
    consoleCommands?: unknown;
  };
  const topology = raw.topology ?? 'standalone';
  if (raw.consoleCommands !== undefined && raw.consoleCommands !== false) {
    if (topology === 'tenant') {
      throw new Error(
        '[@adonis-agora/flags] consoleCommands does not apply to a tenant: its flags are edited on the control-plane console',
      );
    }
    const option = raw.consoleCommands;
    if (option !== true) {
      const value = option as { prefix?: unknown; connection?: unknown; actions?: unknown } | null;
      if (!value || typeof value !== 'object') {
        throw new Error(
          '[@adonis-agora/flags] consoleCommands must be true or { prefix, connection, actions }',
        );
      }
      if (value.prefix !== undefined && (typeof value.prefix !== 'string' || value.prefix === '')) {
        throw new Error('[@adonis-agora/flags] consoleCommands.prefix must be a non-empty string');
      }
      if (
        value.connection !== undefined &&
        (typeof value.connection !== 'string' || value.connection === '')
      ) {
        throw new Error(
          '[@adonis-agora/flags] consoleCommands.connection must be a connection name of config/redis.ts',
        );
      }
      if (value.actions !== undefined && typeof value.actions !== 'boolean') {
        throw new Error('[@adonis-agora/flags] consoleCommands.actions must be a boolean');
      }
      const auth = value as { secret?: unknown; crypto?: unknown };
      if (auth.secret !== undefined) {
        const secret =
          typeof auth.secret === 'string'
            ? auth.secret
            : typeof (auth.secret as { release?: unknown } | null)?.release === 'function'
              ? (auth.secret as { release(): unknown }).release()
              : undefined;
        if (typeof secret !== 'string' || secret.length < 16) {
          throw new Error(
            '[@adonis-agora/flags] consoleCommands.secret must be at least 16 characters',
          );
        }
      }
      if (
        auth.crypto !== undefined &&
        auth.crypto !== false &&
        (!auth.crypto ||
          typeof auth.crypto !== 'object' ||
          !('cipher' in auth.crypto) ||
          !(auth.crypto as { cipher?: unknown }).cipher)
      ) {
        throw new Error(
          '[@adonis-agora/flags] consoleCommands.crypto must be { cipher, key? }, or false to turn the automatic crypto mode off',
        );
      }
    }
  }
  if (raw.controlPlane && 'verifyTenant' in raw.controlPlane) {
    throw new Error(
      "[flags] controlPlane.verifyTenant moved to the top level of config/flags.ts: `verifyTenant: authkitTenantVerifier({ issuer, resource: 'urn:agora:flags' })` (from @adonis-agora/authkit-client) or `verifyTenant: sharedSecretVerifier({ partitions })`",
    );
  }
  if (topology === 'control-plane') {
    if (raw.verifyTenant === undefined || raw.verifyTenant === null) {
      throw new Error(
        '[flags] topology "control-plane" needs `verifyTenant` (authkitTenantVerifier from @adonis-agora/authkit-client, or sharedSecretVerifier)',
      );
    }
    const kind = typeof raw.verifyTenant;
    if (
      kind !== 'function' &&
      !(
        kind === 'object' && typeof (raw.verifyTenant as { verify?: unknown }).verify === 'function'
      )
    ) {
      throw new Error(
        '[flags] verifyTenant must be a function, an object with verify() (a class instance), or a lazy import of one',
      );
    }
  } else if (raw.verifyTenant !== undefined) {
    throw new Error(
      `[flags] verifyTenant only applies to topology "control-plane" (this is "${topology}")`,
    );
  }
  if (topology !== 'control-plane' && raw.controlPlane !== undefined) {
    throw new Error(
      `[flags] controlPlane only applies to topology "control-plane" (this is "${topology}")`,
    );
  }
  if (topology !== 'tenant' && raw.diagnostics !== undefined) {
    throw new Error(
      `[flags] diagnostics only applies to topology "tenant" (this is "${topology}")`,
    );
  }
  if (topology === 'tenant') {
    if (!raw.tenant?.partition) {
      throw new Error('[flags] topology "tenant" needs tenant.partition');
    }
    if (
      raw.diagnostics !== undefined &&
      raw.diagnostics !== 'control-plane' &&
      raw.diagnostics !== 'local'
    ) {
      throw new Error('[flags] diagnostics must be "control-plane" or "local"');
    }
    if (raw.tenant.url !== undefined && !isTenantUrl(raw.tenant.url)) {
      throw new Error(
        '[flags] tenant.url must be the control-plane URL or a function resolving it (controlPlaneUrl() from @adonis-agora/authkit-client)',
      );
    }
    const push = raw.tenant.transport;
    const watch = raw.tenant.watch;
    if (watch && watch.canWatch !== true) {
      throw new Error(
        `[flags] tenant.watch: the "${watch.driver}" transport cannot carry the ruleset; use tenantTransports.http(), .redis() or .durable()`,
      );
    }
    const usesHttp =
      !push || push.driver === 'http' || (watch ? watch.driver === 'http' : push.canWatch !== true);
    if (!raw.tenant.url && usesHttp) {
      throw new Error(
        '[flags] topology "tenant" needs tenant.url (the control-plane URL) for the http transport',
      );
    }
    if (!raw.tenant.url && raw.browser) {
      throw new Error(
        '[flags] `browser` on a tenant needs tenant.url: browsers always reach the control-plane over HTTP',
      );
    }
    if (raw.tenant.token === undefined || raw.tenant.token === null || raw.tenant.token === '') {
      throw new Error(
        '[flags] topology "tenant" needs tenant.token: authkitTenantToken({ issuer, clientId, clientSecret, resource: \'urn:agora:flags\' }) from @adonis-agora/authkit-client, or the shared secret',
      );
    }
    if (raw.role === 'worker') {
      throw new Error(
        '[flags] role "worker" makes no sense on a tenant: it has no relay; the control-plane fans events out',
      );
    }
  }
}

/** Identity helper that types `config/flags.ts`. */
export function defineConfig<const F extends Record<string, FlagDeclaration>>(
  config: FlagsConfig<F>,
): FlagsConfig<F> {
  validateConfig(config as FlagsConfig);
  return describeStackUse(config, () => defaultStackUses(config as FlagsConfig));
}

/**
 * What the omitted options fall back to (see `createRuntime`): a lucid store on the default
 * connection, the `db` transport on the store's connection, a lucid `warehouse` sink and lucid
 * analytics on that sink. Explicit factories describe themselves.
 */
export function defaultStackUses(config: FlagsConfig): StackUse[] {
  if (config.topology === 'tenant') return [];
  const uses: StackUse[] = [];
  const store = config.store
    ? lucidFactories.get(config.store)
    : hasLucidConnection()
      ? { connection: undefined }
      : undefined;
  if (!config.store && store) uses.push(lucidUse(undefined, 'ruleset'));
  if (!config.transport && store) uses.push(lucidUse(store.connection, 'event log'));
  const sink = config.sinks
    ? Object.values(config.sinks)
        .map((factory) => lucidFactories.get(factory))
        .find((meta) => meta !== undefined)
    : store
      ? { connection: undefined }
      : undefined;
  if (!config.sinks && sink) uses.push(lucidUse(undefined, 'exposures'));
  if (!config.analytics && sink) uses.push(lucidUse(sink.connection, 'experiments'));
  return uses;
}
