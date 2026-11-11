import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DuckDb, type DuckDbOptions } from '../analytics/duckdb.js';
import type { FlagEvent } from '../events/event.js';
import type { Sink } from './sink.js';

export interface ParquetSinkOptions extends DuckDbOptions {
  /**
   * Where the files go: a local directory (`storage/flags`) or an object-store prefix DuckDB can
   * write (`s3://bucket/flags`, with credentials in `duckdb.setup`). Files are laid out as
   * `type=…/day=YYYY-MM-DD/<uuid>.parquet`.
   */
  path: string;
  /**
   * Events per file. Parquet wants big files: the default 50,000 keeps file counts sane. The relay
   * hands this sink batches of this size.
   */
  batchSize?: number;
  /** Delivery interval (ms). Default 60000 — let batches fill. */
  intervalMs?: number;
}

/**
 * Writes events as Parquet through DuckDB. Cheap, long retention with no server: the `duckdb`
 * analytics backend reads the same files. `@duckdb/node-api` is an optional peer with a native
 * binary; run the relay for this sink in a worker, not in web processes.
 *
 * Erasure rewrites the affected local files without the subject's rows (`forget`). For object
 * stores, rewrite them with your own tooling.
 */
export class ParquetSink implements Sink {
  readonly kind = 'parquet';
  readonly #duck: DuckDb;

  constructor(private readonly options: ParquetSinkOptions) {
    this.#duck = new DuckDb(options);
  }

  get batchSize() {
    return this.options.batchSize ?? 50_000;
  }

  get intervalMs() {
    return this.options.intervalMs ?? 60_000;
  }

  get #local() {
    return !/^[a-z0-9]+:\/\//i.test(this.options.path);
  }

  async setup(): Promise<void> {
    if (this.#local) await mkdir(this.options.path, { recursive: true });
  }

  async write(events: FlagEvent[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((e) => ({
      event_id: e.id,
      schema_version: e.schemaVersion,
      app: e.app,
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
      day: new Date(e.ts).toISOString().slice(0, 10),
    }));
    const staging = `staging_${randomUUID().replaceAll('-', '')}`;
    await this.#duck.withConnection(async (sql) => {
      await sql(`CREATE TEMP TABLE ${staging} (
        event_id VARCHAR, schema_version INTEGER, app VARCHAR, type VARCHAR, flag VARCHAR,
        experiment VARCHAR, variant VARCHAR, name VARCHAR, subject VARCHAR, subject_type VARCHAR,
        value DOUBLE, props VARCHAR, ts BIGINT, day VARCHAR)`);
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const values = chunk
          .map(
            (r) =>
              `(${[
                r.event_id,
                r.schema_version,
                r.app,
                r.type,
                r.flag,
                r.experiment,
                r.variant,
                r.name,
                r.subject,
                r.subject_type,
                r.value,
                r.props,
                r.ts,
                r.day,
              ]
                .map(literal)
                .join(', ')})`,
          )
          .join(', ');
        await sql(`INSERT INTO ${staging} VALUES ${values}`);
      }
      await sql(
        `COPY ${staging} TO ${literal(this.options.path)} (FORMAT PARQUET, PARTITION_BY (type, day), FILENAME_PATTERN 'part_{uuid}', APPEND)`,
      );
      await sql(`DROP TABLE ${staging}`);
    });
  }

  async forget(subject: string): Promise<void> {
    if (!this.#local) {
      throw new Error(
        'ParquetSink.forget only rewrites local files; rewrite object-store files with your own tooling',
      );
    }
    for (const file of await listParquet(this.options.path)) {
      await this.#duck.withConnection(async (sql, select) => {
        const matches = await select<{ n: number | bigint }>(
          `SELECT COUNT(*) AS n FROM read_parquet(${literal(file)}) WHERE subject = ${literal(subject)}`,
        );
        if (Number(matches[0]?.n ?? 0) === 0) return;
        const rewritten = `${file}.rewrite`;
        await sql(
          `COPY (SELECT * FROM read_parquet(${literal(file)}) WHERE subject <> ${literal(subject)}) TO ${literal(rewritten)} (FORMAT PARQUET)`,
        );
        await rm(file);
        const { rename } = await import('node:fs/promises');
        await rename(rewritten, file);
      });
    }
  }

  async close(): Promise<void> {
    await this.#duck.close();
  }
}

async function listParquet(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listParquet(full)));
    else if (entry.name.endsWith('.parquet')) out.push(full);
  }
  return out;
}

/** A SQL literal for DuckDB. */
export function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replaceAll("'", "''")}'`;
}
