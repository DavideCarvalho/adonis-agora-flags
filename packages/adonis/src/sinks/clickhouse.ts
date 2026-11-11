import type { FlagEvent } from '../events/event.js';
import type { Sink } from './sink.js';

export interface ClickHouseOptions {
  /** HTTP endpoint, e.g. `http://localhost:8123`. */
  url: string;
  database?: string;
  username?: string;
  password?: string;
  /** Table for every event. Default `flags_events`. */
  table?: string;
  fetch?: typeof fetch;
}

/** A tiny ClickHouse HTTP client: no driver dependency, just the HTTP interface. */
export class ClickHouseClient {
  readonly #fetch: typeof fetch;
  readonly table: string;

  constructor(readonly options: ClickHouseOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.table = options.table ?? 'flags_events';
  }

  /** POSTs `sql` (in the `query` parameter) with an optional data body. */
  async #request(sql: string, body?: string, settings: Record<string, string | number> = {}) {
    const url = new URL(this.options.url);
    url.searchParams.set('query', sql);
    if (this.options.database) url.searchParams.set('database', this.options.database);
    for (const [key, value] of Object.entries(settings)) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = {};
    if (this.options.username) {
      headers.authorization = `Basic ${Buffer.from(`${this.options.username}:${this.options.password ?? ''}`).toString('base64')}`;
    }
    const response = await this.#fetch(url, {
      method: 'POST',
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`ClickHouse answered ${response.status}: ${text.slice(0, 500)}`);
    return text;
  }

  exec(sql: string) {
    return this.#request(sql);
  }

  async insert(rows: Array<Record<string, unknown>>) {
    if (rows.length === 0) return;
    await this.#request(
      `INSERT INTO ${this.table} FORMAT JSONEachRow`,
      rows.map((row) => JSON.stringify(row)).join('\n'),
      // Server-side batching: many small inserts become few parts.
      { async_insert: 1, wait_for_async_insert: 1 },
    );
  }

  /** Runs a SELECT with `{name:Type}` parameters and returns the rows. */
  async select<T = Record<string, unknown>>(
    sql: string,
    params: Record<string, string | number> = {},
  ): Promise<T[]> {
    const settings: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(params)) settings[`param_${key}`] = value;
    const text = await this.#request(`${sql} FORMAT JSONEachRow`, undefined, settings);
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as T);
  }

  async createTable() {
    // ReplacingMergeTree on the event id: re-sent events collapse on merge, and the analytics
    // queries count DISTINCT subjects, so pre-merge duplicates never change a result.
    await this.exec(`CREATE TABLE IF NOT EXISTS ${this.table} (
      event_id String,
      schema_version UInt8,
      app LowCardinality(String),
      environment LowCardinality(String),
      type LowCardinality(String),
      flag Nullable(String),
      experiment Nullable(String),
      variant Nullable(String),
      name Nullable(String),
      subject String,
      subject_type LowCardinality(String),
      value Nullable(Float64),
      props String,
      ts Int64
    ) ENGINE = ReplacingMergeTree
    PARTITION BY toYYYYMM(fromUnixTimestamp64Milli(ts))
    ORDER BY (environment, type, ifNull(experiment, ''), ifNull(name, ''), subject, event_id)`);
  }
}

/** Every event into one ClickHouse table, read back by the `clickhouse` analytics backend. */
export class ClickHouseSink implements Sink {
  readonly kind = 'clickhouse';
  readonly client: ClickHouseClient;

  constructor(
    options: ClickHouseOptions & {
      batchSize?: number;
      intervalMs?: number;
      autoCreateSchema?: boolean;
    },
  ) {
    this.client = new ClickHouseClient(options);
    this.batchSize = options.batchSize ?? 5000;
    if (options.intervalMs !== undefined) this.intervalMs = options.intervalMs;
    this.#autoCreate = options.autoCreateSchema !== false;
  }

  readonly batchSize: number;
  readonly intervalMs?: number;
  readonly #autoCreate: boolean;

  async setup(): Promise<void> {
    if (this.#autoCreate) await this.client.createTable();
  }

  async write(events: FlagEvent[]): Promise<void> {
    await this.client.insert(
      events.map((e) => ({
        event_id: e.id,
        schema_version: e.schemaVersion,
        app: e.app,
        environment: e.environment,
        type: e.type,
        flag: e.flag ?? null,
        experiment: e.experiment ?? null,
        variant: e.variant ?? null,
        name: e.name ?? null,
        subject: e.subject,
        subject_type: e.subjectType,
        value: e.value ?? null,
        props: JSON.stringify(e.props ?? {}),
        ts: e.ts,
      })),
    );
  }

  async forget(subject: string): Promise<void> {
    await this.client.exec(
      `ALTER TABLE ${this.client.table} DELETE WHERE subject = '${subject.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`,
    );
  }
}
