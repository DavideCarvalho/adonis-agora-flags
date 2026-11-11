import { type AnalyticsBackend, statsFromRow } from './backend.js';
import {
  type MetricDefinition,
  subjectAggregates,
  UNBOUNDED_MS,
  type VariantMetricStats,
} from './metrics.js';

export interface DuckDbOptions {
  /** DuckDB database file. Default `:memory:` (the data lives in the Parquet files). */
  database?: string;
  /**
   * Statements run on every new connection: `INSTALL httpfs; LOAD httpfs;`, `CREATE SECRET …` for
   * S3/GCS credentials, `SET memory_limit = '1GB'`.
   */
  setup?: string[];
}

type Sql = (statement: string) => Promise<void>;
type Select = <T = Record<string, unknown>>(statement: string) => Promise<T[]>;

interface DuckModule {
  DuckDBInstance: {
    create(
      path?: string,
      options?: Record<string, string>,
    ): Promise<{
      connect(): Promise<{
        run(sql: string): Promise<unknown>;
        runAndReadAll(sql: string): Promise<{ getRowObjectsJS(): Array<Record<string, unknown>> }>;
        closeSync(): void;
      }>;
      closeSync(): void;
    }>;
  };
}

/** A lazily-created DuckDB instance. `@duckdb/node-api` is imported on first use only. */
export class DuckDb {
  #instance: Awaited<ReturnType<DuckModule['DuckDBInstance']['create']>> | undefined;

  constructor(private readonly options: DuckDbOptions = {}) {}

  async #get() {
    if (!this.#instance) {
      let mod: DuckModule;
      try {
        mod = (await import('@duckdb/node-api')) as unknown as DuckModule;
      } catch {
        throw new Error(
          '@adonis-agora/flags: the parquet sink and the duckdb analytics backend need "@duckdb/node-api". Install it.',
        );
      }
      this.#instance = await mod.DuckDBInstance.create(this.options.database ?? ':memory:');
    }
    return this.#instance;
  }

  async withConnection<T>(fn: (sql: Sql, select: Select) => Promise<T>): Promise<T> {
    const instance = await this.#get();
    const connection = await instance.connect();
    try {
      for (const statement of this.options.setup ?? []) await connection.run(statement);
      const sql: Sql = async (statement) => {
        await connection.run(statement);
      };
      const select: Select = async <T>(statement: string) =>
        (await connection.runAndReadAll(statement)).getRowObjectsJS() as T[];
      return await fn(sql, select);
    } finally {
      connection.closeSync();
    }
  }

  async close(): Promise<void> {
    this.#instance?.closeSync();
    this.#instance = undefined;
  }
}

function literal(value: string | number): string {
  return typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;
}

/**
 * Level 2 of DESIGN §12: reads the Parquet files the `parquet` sink writes, with DuckDB, in process.
 * No server to run. Point it at the same `path`. Queries scan files, so run it where a few seconds
 * of CPU are fine (the worker computes and caches results; the console reads the cache).
 */
export class DuckDbBackend implements AnalyticsBackend {
  readonly kind = 'duckdb';
  readonly #duck: DuckDb;

  constructor(private readonly options: DuckDbOptions & { path: string }) {
    this.#duck = new DuckDb(options);
  }

  get #glob() {
    return literal(`${this.options.path.replace(/\/$/, '')}/**/*.parquet`);
  }

  /** First exposure per subject, deduped by event id like every other backend. */
  #exposuresSql(experiment: string, environment: string) {
    return `SELECT subject, arg_min(variant, ts) AS variant, min(ts) AS first_seen_ts
              FROM read_parquet(${this.#glob}, hive_partitioning = true, union_by_name = true)
             WHERE type = 'exposure' AND environment = ${literal(environment)}
               AND experiment = ${literal(experiment)}
             GROUP BY subject`;
  }

  async exposures(experiment: string, environment: string): Promise<Record<string, number>> {
    return this.#duck.withConnection(async (_sql, select) => {
      const rows = await select<{ variant: string; n: number | bigint }>(
        `SELECT variant, COUNT(*) AS n FROM (${this.#exposuresSql(experiment, environment)}) GROUP BY variant`,
      ).catch(noFiles);
      return Object.fromEntries(rows.map((row) => [row.variant, Number(row.n)]));
    });
  }

  async metric(
    experiment: string,
    definition: MetricDefinition,
    environment: string,
  ): Promise<Record<string, VariantMetricStats>> {
    const { post, pre } = subjectAggregates(definition);
    const window = definition.windowMs ?? UNBOUNDED_MS;
    const preWindow = definition.cupedMs ?? 0;
    return this.#duck.withConnection(async (_sql, select) => {
      const rows = await select(
        `WITH x AS (${this.#exposuresSql(experiment, environment)}),
              t AS (
                SELECT DISTINCT ON (event_id) subject, value, ts
                  FROM read_parquet(${this.#glob}, hive_partitioning = true, union_by_name = true)
                 WHERE type = 'track' AND environment = ${literal(environment)}
                   AND name = ${literal(definition.event)}
              )
         SELECT variant, COUNT(*) AS n,
                SUM(y) AS sum_y, SUM(y * y) AS sum_y2,
                SUM(xv) AS sum_x, SUM(xv * xv) AS sum_x2, SUM(xv * y) AS sum_xy
           FROM (
             SELECT x.variant AS variant, x.subject AS subject,
                    CAST(${post} AS DOUBLE) AS y,
                    CAST(${pre} AS DOUBLE) AS xv
               FROM x
               LEFT JOIN t
                 ON t.subject = x.subject
                AND t.ts >= x.first_seen_ts - ${preWindow}
                AND t.ts < x.first_seen_ts + ${window}
              GROUP BY x.variant, x.subject
           )
          GROUP BY variant`,
      ).catch(noFiles);
      return Object.fromEntries(rows.map((row) => [String(row.variant), statsFromRow(row)]));
    });
  }

  close() {
    return this.#duck.close();
  }
}

/** No Parquet file yet means no data, not an error. */
function noFiles(error: unknown): never[] {
  if (/No files found|does not exist|IO Error/i.test(String((error as Error)?.message))) return [];
  throw error;
}
