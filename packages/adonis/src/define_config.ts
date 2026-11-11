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
import type { RelayOptions } from './relay/relay.js';
import { type ClickHouseOptions, ClickHouseSink } from './sinks/clickhouse.js';
import { LucidSink } from './sinks/lucid_sink.js';
import { ParquetSink, type ParquetSinkOptions } from './sinks/parquet_sink.js';
import { PostHogSink, type PostHogSinkOptions } from './sinks/posthog_sink.js';
import { CallbackSink, MemorySink, type Sink } from './sinks/sink.js';
import type { SqlDatabase } from './sql.js';
import { LucidStore } from './stores/lucid_store.js';
import { MemoryStore } from './stores/memory_store.js';
import type { FlagsStore } from './stores/store.js';
import type { Subject, SubjectLike } from './subject.js';
import type { TokenSource } from './topology/token.js';
import type { TenantVerifier } from './topology/verify.js';
import { DbTransport, type DbTransportOptions } from './transports/db_transport.js';
import { MemoryTransport } from './transports/memory_transport.js';
import {
  type RedisStreamClient,
  RedisTransport,
  type RedisTransportOptions,
} from './transports/redis_transport.js';
import type { Transport } from './transports/transport.js';

/** What factories receive: the app and lazy access to its database and Redis connections. */
export interface FactoryContext {
  app?: ApplicationService;
  /** A Lucid query client for `connection` (default connection when omitted). */
  db(connection?: string): Promise<SqlDatabase>;
  redis(connection?: string): Promise<RedisStreamClient>;
  autoCreateSchema: boolean;
  partitionEvents: boolean;
}

export type Factory<T> = (context: FactoryContext) => T | Promise<T>;

export const stores = {
  /** The ruleset in your database (Postgres, MySQL, SQLite). The default. */
  lucid(options: { connection?: string } = {}): Factory<FlagsStore> {
    return async (ctx) =>
      new LucidStore(await ctx.db(options.connection), {
        autoCreateSchema: ctx.autoCreateSchema,
        partitionEvents: ctx.partitionEvents,
      });
  },
  /** In process memory: tests and local development. */
  memory(seed?: ConstructorParameters<typeof MemoryStore>[0]): Factory<FlagsStore> {
    return () => new MemoryStore(seed);
  },
};

export const transports = {
  /** The event log in your database. Transactional; the default when the store is `lucid`. */
  db(options: DbTransportOptions & { connection?: string } = {}): Factory<Transport> {
    return async (ctx) =>
      new DbTransport(await ctx.db(options.connection), {
        autoCreateSchema: ctx.autoCreateSchema,
        partitionEvents: ctx.partitionEvents,
        ...options,
      });
  },
  /** Redis Streams through `@adonisjs/redis`. */
  redis(options: RedisTransportOptions & { connection?: string } = {}): Factory<Transport> {
    return async (ctx) => new RedisTransport(await ctx.redis(options.connection), options);
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
    return async (ctx) =>
      new LucidSink(await ctx.db(options.connection), {
        autoCreateSchema: ctx.autoCreateSchema,
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
        ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
      });
  },
  posthog(options: PostHogSinkOptions): Factory<Sink> {
    return () => new PostHogSink(options);
  },
  clickhouse(
    options: ClickHouseOptions & {
      batchSize?: number;
      intervalMs?: number;
      autoCreateSchema?: boolean;
    },
  ): Factory<Sink> {
    return () => new ClickHouseSink(options);
  },
  /** Parquet files through DuckDB (`@duckdb/node-api`); read by `analytics.duckdb()`. */
  parquet(options: ParquetSinkOptions): Factory<Sink> {
    return () => new ParquetSink(options);
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
    return async (ctx) => new LucidBackend(await ctx.db(options.connection));
  },
  duckdb(options: DuckDbOptions & { path: string }): Factory<AnalyticsBackend> {
    return () => new DuckDbBackend(options);
  },
  clickhouse(options: ClickHouseOptions): Factory<AnalyticsBackend> {
    return () => new ClickHouseBackend(options);
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
   * The subject of `ctx.flags`. Default: `ctx.auth?.user` when `@adonisjs/auth` is set up (its `id`),
   * anonymous otherwise.
   */
  subject?: (ctx: HttpContext) => SubjectLike | Promise<SubjectLike>;
  /** Extra targeting attributes for every subject. Server-side state only. */
  attributes?: (subject: Subject) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Count evaluations per flag for stale-flag detection. Default `true`. */
  usage?: boolean;
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
  /** Postgres: partition the event log by month. Default `false`. Decide before first boot. */
  partitionEvents?: boolean;
  /** Push ruleset changes to browsers through `@adonisjs/transmit`. Default `false`. */
  realtime?: { channel?: string } | boolean;
}

export interface StandaloneConfig<F extends Record<string, FlagDeclaration>>
  extends BaseConfig<F>,
    OwnedStateConfig {
  topology?: 'standalone';
}

export interface ControlPlaneConfig<F extends Record<string, FlagDeclaration>>
  extends BaseConfig<F>,
    OwnedStateConfig {
  topology: 'control-plane';
  controlPlane: {
    /** Route prefix. Default `/_flags`. */
    prefix?: string;
    /** Validates tenant tokens; derive the tenant from the token, never the body. */
    verifyTenant: TenantVerifier;
    /** Serve the OpenFeature Remote Evaluation Protocol. Default `true`. */
    ofrep?: boolean;
    /** Origins allowed to call OFREP from browsers. Default: none (no CORS headers). */
    corsOrigins?: string[];
  };
}

export interface TenantConfig<F extends Record<string, FlagDeclaration>> extends BaseConfig<F> {
  topology: 'tenant';
  /** The control-plane connection. */
  tenant: {
    url: string;
    /** A token source (`tokens.clientCredentials(...)`) or a fixed secret. */
    token: TokenSource | string;
    /** This app's name on the control-plane. */
    partition: string;
    /** File for the last ruleset received (served when the control-plane is down at boot). */
    snapshotPath?: string;
    stream?: boolean;
    intervalMs?: number;
    capabilities?: string[];
  };
  /** FORBIDDEN on a tenant: it owns no state; everything lives on the control-plane. */
  store?: never;
  transport?: never;
  sinks?: never;
  analytics?: never;
  approvals?: never;
}

export type FlagsConfig<
  F extends Record<string, FlagDeclaration> = Record<string, FlagDeclaration>,
> = StandaloneConfig<F> | ControlPlaneConfig<F> | TenantConfig<F>;

/** Identity helper that types `config/flags.ts`. */
export function defineConfig<const F extends Record<string, FlagDeclaration>>(
  config: FlagsConfig<F>,
): FlagsConfig<F> {
  if (config.topology === 'tenant' && config.role === 'worker') {
    throw new Error(
      '[flags] role "worker" makes no sense on a tenant: it has no relay; the control-plane fans events out',
    );
  }
  return config;
}
