import { FlagsAdmin } from './admin.js';
import type { AnalyticsBackend } from './analytics/backend.js';
import { LucidBackend } from './analytics/lucid_backend.js';
import { serializeDeclarations } from './declare.js';
import type {
  ControlPlaneConfig,
  FactoryContext,
  FlagsConfig,
  StandaloneConfig,
} from './define_config.js';
import { analytics as analyticsFactories, sinks as sinkFactories } from './define_config.js';
import { enrichers as builtInEnrichers, type Enricher, runEnrichers } from './enrichers.js';
import { EventBuffer } from './events/buffer.js';
import type { BrowserTokens } from './http/browser_tokens.js';
import { FlagsManager } from './manager.js';
import { Relay } from './relay/relay.js';
import { LucidResultsCache, MemoryResultsCache, type ResultsCache } from './relay/results_cache.js';
import { FlagsWorker } from './relay/worker.js';
import { type RulesetSource, StoreSource } from './ruleset_source.js';
import { LucidSink } from './sinks/lucid_sink.js';
import type { Sink } from './sinks/sink.js';
import { assertSchemaName, inSchema, query, type SqlDatabase } from './sql.js';
import { LucidStore } from './stores/lucid_store.js';
import { MemoryStore } from './stores/memory_store.js';
import type { FlagsStore } from './stores/store.js';
import { RemoteSource } from './topology/remote_source.js';
import { type TokenSource, tokens } from './topology/token.js';
import { DbTransport } from './transports/db_transport.js';
import { HttpTransport } from './transports/http_transport.js';
import { MemoryTransport } from './transports/memory_transport.js';
import type { Transport } from './transports/transport.js';
import { UsageCounter } from './usage.js';

export interface Logger {
  info?(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export type Topology = 'standalone' | 'control-plane' | 'tenant';
export type Role = 'all' | 'api' | 'worker';

/** Everything a flags deployment is made of, built from `config/flags.ts`. */
export interface FlagsRuntime {
  config: FlagsConfig;
  topology: Topology;
  role: Role;
  manager: FlagsManager;
  source: RulesetSource;
  admin?: FlagsAdmin;
  store?: FlagsStore;
  transport?: Transport;
  sinks: Map<string, Sink>;
  relay?: Relay;
  analytics?: AnalyticsBackend;
  resultsCache?: ResultsCache;
  worker?: FlagsWorker;
  buffer?: EventBuffer;
  usage?: UsageCounter;
  enrichers: Enricher[];
  /** Tenant only: how it authenticates to the control-plane. */
  token?: TokenSource;
  /** Issues browser tokens, when `browser` is configured (set by the provider). */
  browser?: BrowserTokens | undefined;
  close(): Promise<void>;
}

export interface RuntimeOptions {
  logger?: Logger;
  /** Called after a ruleset change applied in this process (to notify browsers, etc.). */
  onApplied?: (environment: string, version: string) => void;
  /** Start timers (source polling, buffer, usage, in-process worker). Default `true`. */
  start?: boolean;
  /** Whether this process runs the in-process worker loop. Decided by the provider. */
  runWorker?: boolean;
  /**
   * Hold a connection for Postgres `LISTEN` (instant ruleset changes). Default `true`; the provider
   * turns it off in ace commands and the REPL: a held connection keeps Lucid from closing its
   * pool, so `node ace migration:run` and friends would never exit.
   */
  listen?: boolean;
}

/** Resolves defaults that depend on what is installed (`lucid` when available, else memory). */
async function lucidAvailable(ctx: FactoryContext): Promise<boolean> {
  try {
    await ctx.db();
    return true;
  } catch (error) {
    // A misconfiguration (a `schema` the database cannot honour) must not fall back to memory.
    if ((error as { flagsConfigError?: boolean }).flagsConfigError) throw error;
    return false;
  }
}

/** Builds (and starts) the runtime. Shared by the provider, the commands and the tests. */
export async function createRuntime(
  config: FlagsConfig,
  ctx: FactoryContext,
  options: RuntimeOptions = {},
): Promise<FlagsRuntime> {
  const topology: Topology = config.topology ?? 'standalone';
  const schema = (config as { schema?: string }).schema;
  if (schema) {
    assertSchemaName(schema);
    // Every factory (store, transport, sinks, analytics) gets clients bound to the schema. A client
    // that cannot honour it (SQLite) fails here, loudly, not later as "no database".
    const db = ctx.db.bind(ctx);
    ctx = {
      ...ctx,
      db: async (connection) => {
        const client = await db(connection);
        try {
          return inSchema(client, schema);
        } catch (error) {
          throw Object.assign(error as Error, { flagsConfigError: true });
        }
      },
    };
  }
  const role: Role = config.role ?? 'all';
  const environment = config.environment ?? 'production';
  const app =
    config.topology === 'tenant' ? config.tenant.partition : (config.app ?? ctx.appName ?? 'app');
  const logger = options.logger;
  const declarations = config.flags;
  const enricherList = [builtInEnrichers.diagnostics(), ...(config.enrichers ?? [])];
  for (const enricher of enricherList) await enricher.setup?.();
  const start = options.start !== false;

  if (config.topology === 'tenant') {
    const tenant = config.tenant;
    const token = typeof tenant.token === 'string' ? tokens.static(tenant.token) : tenant.token;
    const source = new RemoteSource({
      url: tenant.url,
      token,
      partition: tenant.partition,
      ...(tenant.snapshotPath ? { snapshotPath: tenant.snapshotPath } : {}),
      ...(tenant.stream !== undefined ? { stream: tenant.stream } : {}),
      ...(tenant.intervalMs !== undefined ? { intervalMs: tenant.intervalMs } : {}),
      ...(tenant.capabilities ? { capabilities: tenant.capabilities } : {}),
      onError: (error) => logger?.warn(`[flags] control-plane: ${(error as Error).message}`),
    });
    const transport = new HttpTransport({ url: tenant.url, token, partition: tenant.partition });
    const buffer = new EventBuffer(transport, {
      ...config.events?.buffer,
      onError: (error) =>
        logger?.warn(`[flags] sending events failed: ${(error as Error).message}`),
    });
    const base = tenant.url.replace(/\/$/, '');
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await token.get()}`,
          'x-flags-tenant': tenant.partition,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`control-plane answered ${response.status} on ${path}`);
    };
    const usage =
      config.usage === false
        ? undefined
        : new UsageCounter(
            environment,
            (rows) => post('/v1/usage', { rows }),
            (error) => logger?.warn(`[flags] usage flush failed: ${(error as Error).message}`),
          );
    const manager = new FlagsManager({
      app,
      environment,
      declarations,
      source,
      buffer,
      transport,
      enrichers: enricherList,
      ...(usage ? { usage } : {}),
      ...(config.attributes ? { attributes: config.attributes } : {}),
      ...(logger ? { logger } : {}),
    });
    if (start) {
      await source.start();
      buffer.start();
      usage?.start();
      // Tell the control-plane what this app declares, so its console knows the flags exist.
      void post('/v1/declarations', { declarations: serializeDeclarations(declarations) }).catch(
        (error) =>
          logger?.warn(`[flags] publishing declarations failed: ${(error as Error).message}`),
      );
    }
    return {
      config,
      topology,
      role,
      manager,
      source,
      transport,
      sinks: new Map(),
      buffer,
      ...(usage ? { usage } : {}),
      enrichers: enricherList,
      token,
      async close() {
        await source.stop();
        await buffer.close();
        await usage?.close();
      },
    };
  }

  const owned = config as
    | StandaloneConfig<Record<string, never>>
    | ControlPlaneConfig<Record<string, never>>;
  const hasLucid = await lucidAvailable(ctx);
  const store: FlagsStore = owned.store
    ? await owned.store(ctx)
    : hasLucid
      ? await (async () =>
          new LucidStore(await ctx.db(), {
            autoCreateSchema: ctx.autoCreateSchema,
            partitionEvents: ctx.partitionEvents,
          }))()
      : new MemoryStore();
  if (!owned.store && !hasLucid) {
    logger?.warn(
      '[flags] @adonisjs/lucid is not configured: flags live in memory and reset on restart',
    );
  }
  await store.setup?.();

  const usesLucidStore = store instanceof LucidStore;
  const transport: Transport = owned.transport
    ? await owned.transport(ctx)
    : usesLucidStore
      ? new DbTransport((store as LucidStore).db, {
          autoCreateSchema: ctx.autoCreateSchema,
          partitionEvents: ctx.partitionEvents,
        })
      : new MemoryTransport();
  await transport.setup?.();
  if (!transport.capabilities.durable) {
    logger?.warn(
      `[flags] the "${transport.name}" transport is not durable: undelivered events are lost on restart`,
    );
  }

  const sinkFactories_ =
    owned.sinks ?? (usesLucidStore ? { warehouse: sinkFactories.lucid() } : {});
  const sinkMap = new Map<string, Sink>();
  for (const [name, factory] of Object.entries(sinkFactories_)) {
    const sink = await factory(ctx);
    await sink.setup?.();
    sinkMap.set(name, sink);
  }

  const lucidSink = [...sinkMap.values()].find(
    (sink): sink is LucidSink => sink instanceof LucidSink,
  );
  const analyticsBackend: AnalyticsBackend | undefined = owned.analytics
    ? await owned.analytics(ctx)
    : lucidSink
      ? new LucidBackend(lucidSink.db)
      : undefined;
  void analyticsFactories;

  const resultsCache: ResultsCache = usesLucidStore
    ? new LucidResultsCache((store as LucidStore).db)
    : new MemoryResultsCache();

  const source = new StoreSource(store, {
    environment,
    ...(owned.refresh?.intervalMs !== undefined ? { intervalMs: owned.refresh.intervalMs } : {}),
    ...(options.listen === false
      ? { notify: false }
      : owned.refresh?.notify !== undefined
        ? { notify: owned.refresh.notify }
        : {}),
    onError: (error) =>
      logger?.warn(`[flags] reloading the ruleset failed: ${(error as Error).message}`),
  });

  const buffer = new EventBuffer(transport, {
    ...config.events?.buffer,
    onError: (error) =>
      logger?.warn(`[flags] publishing events failed: ${(error as Error).message}`),
  });
  const usage =
    config.usage === false
      ? undefined
      : new UsageCounter(
          environment,
          (rows) => store.recordUsage(rows),
          (error) => logger?.warn(`[flags] usage flush failed: ${(error as Error).message}`),
        );

  const admin = new FlagsAdmin(store, {
    environment,
    declarations,
    ...(owned.approvals ? { approvals: owned.approvals } : {}),
    ...(owned.authorize
      ? { authorize: owned.authorize }
      : config.identity?.can
        ? { authorize: config.identity.can.bind(config.identity) }
        : {}),
    onApplied: (env, version, applied) => {
      if (env === environment) void source.refresh();
      const { change, actor, changeRequestId } = applied;
      runEnrichers(enricherList, (e) =>
        e.onChange?.({
          environment: env,
          version,
          entity: change.entity,
          ...(change.key !== undefined ? { key: change.key } : {}),
          deleted: change.value === null,
          actor,
          ...(changeRequestId ? { changeRequestId } : {}),
        }),
      );
      options.onApplied?.(env, version);
    },
  });

  const sticky =
    owned.sticky && lucidSink
      ? async (subject: string) => {
          const rows = await query<{ flag: string; variant: string }>(
            lucidSink.db,
            "SELECT flag, variant FROM flags_exposures WHERE environment = ? AND subject = ? AND variant <> '__holdout__'",
            [environment, subject],
          );
          return Object.fromEntries(rows.map((row) => [row.flag, row.variant]));
        }
      : undefined;
  if (owned.sticky && !lucidSink)
    logger?.warn('[flags] sticky assignments need the lucid sink; they are off');

  const relay =
    transport.consume && sinkMap.size > 0
      ? new Relay(transport, sinkMap, {
          ...(owned.relay?.batchSize !== undefined ? { batchSize: owned.relay.batchSize } : {}),
          ...(owned.relay?.leaseMs !== undefined ? { leaseMs: owned.relay.leaseMs } : {}),
        })
      : undefined;

  const worker = new FlagsWorker({
    ...(relay ? { relay } : {}),
    ...(owned.relay?.intervalMs !== undefined ? { relayIntervalMs: owned.relay.intervalMs } : {}),
    admin,
    source,
    environment,
    ...(owned.resultsEnvironments ? { resultsEnvironments: owned.resultsEnvironments } : {}),
    ...(analyticsBackend ? { analytics: analyticsBackend } : {}),
    resultsCache,
    ...(owned.metrics ? { metrics: owned.metrics } : {}),
    ...(owned.experiments ? { experiments: owned.experiments } : {}),
    ...(owned.resultsIntervalMs !== undefined
      ? { resultsIntervalMs: owned.resultsIntervalMs }
      : {}),
    transport,
    ...(transport instanceof DbTransport ? { eventsDb: transport.db } : {}),
    ...(owned.retentionDays !== undefined ? { retentionDays: owned.retentionDays } : {}),
    ...(logger ? { logger } : {}),
  });

  const manager = new FlagsManager({
    app,
    environment,
    declarations,
    source,
    buffer,
    transport,
    enrichers: enricherList,
    ...(usage ? { usage } : {}),
    ...(sticky ? { sticky } : {}),
    ...(config.attributes ? { attributes: config.attributes } : {}),
    admin,
    results: (experiment, env) => resultsCache.get(env ?? environment, experiment),
    forget: async (subject) => {
      for (const sink of sinkMap.values()) await sink.forget?.(subject);
      if (transport instanceof DbTransport) {
        await transport.db.rawQuery('DELETE FROM flags_events WHERE subject = ?', [subject]);
      }
    },
    ...(logger ? { logger } : {}),
  });

  if (start) {
    await source.start();
    buffer.start();
    usage?.start();
    if (options.runWorker) worker.start();
  }

  return {
    config,
    topology,
    role,
    manager,
    source,
    admin,
    store,
    transport,
    sinks: sinkMap,
    ...(relay ? { relay } : {}),
    ...(analyticsBackend ? { analytics: analyticsBackend } : {}),
    resultsCache,
    worker,
    buffer,
    ...(usage ? { usage } : {}),
    enrichers: enricherList,
    async close() {
      await worker.stop();
      await source.stop();
      await buffer.close();
      await usage?.close();
      for (const sink of sinkMap.values()) await sink.close?.();
      await analyticsBackend?.close?.();
      await transport.close?.();
    },
  };
}

/** A database for factories, from a Lucid `Database` (or anything with `connection()`). */
export function lucidContext(
  db: { connection(name?: string): SqlDatabase } | undefined,
  options: Partial<
    Pick<FactoryContext, 'autoCreateSchema' | 'partitionEvents' | 'redis' | 'app'>
  > = {},
): FactoryContext {
  return {
    async db(connection?: string) {
      if (!db) throw new Error('@adonisjs/lucid is not available');
      return db.connection(connection);
    },
    redis:
      options.redis ??
      (async () => {
        throw new Error('no redis connection available');
      }),
    autoCreateSchema: options.autoCreateSchema ?? true,
    partitionEvents: options.partitionEvents ?? false,
    ...(options.app ? { app: options.app } : {}),
  };
}
