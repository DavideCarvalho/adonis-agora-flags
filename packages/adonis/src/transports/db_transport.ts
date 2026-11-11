import { type FlagEvent } from '../events/event.js';
import { createFlagsTables, ensureEventPartitions, type SchemaOptions } from '../schema.js';
import {
  type Dialect,
  dialectOf,
  insertIgnore,
  jsonValue,
  parseJson,
  query,
  type SqlClient,
  type SqlDatabase,
  toNumber,
} from '../sql.js';
import type { Delivery, PublishOptions, SinkStatus, Transport } from './transport.js';

export interface DbTransportOptions extends SchemaOptions {
  /**
   * MySQL only. InnoDB hands out auto-increment ids before commit, so a slow transaction can
   * commit an id lower than one already relayed. The relay only reads events older than this
   * window (ms) to leave such transactions time to commit. Default 10000. Postgres does not need
   * it (it orders by transaction id and reads only finished transactions); SQLite has a single
   * writer.
   */
  mysqlSafetyMs?: number;
  autoCreateSchema?: boolean;
}

const COLUMNS = [
  'event_id',
  'schema_version',
  'app',
  'environment',
  'type',
  'flag',
  'experiment',
  'variant',
  'name',
  'subject',
  'subject_type',
  'value',
  'props',
  'ts',
];

/**
 * The event log in your database (`flags_events`), with one cursor per sink in
 * `flags_sink_cursors`. The only transactional transport: `publish` accepts the caller's Lucid
 * transaction.
 *
 * Leases are `UPDATE … WHERE lease expired` (no transaction held open while a sink sends), and the
 * cursor only moves while the lease is still ours, so a replica that stalled past its lease cannot
 * move it back. Delivery is at-least-once; sinks dedupe by event id.
 *
 * Gap safety: ids are assigned before commit, so reading strictly by id could skip an event whose
 * transaction committed late. On Postgres the cursor is `(xid, id)` and the relay reads only rows of
 * transactions older than the oldest still running (`pg_snapshot_xmin`), which closes the gap
 * exactly. MySQL uses a time window (`mysqlSafetyMs`); SQLite serializes writers.
 */
export class DbTransport implements Transport {
  readonly name = 'db';
  readonly capabilities = { transactional: true, durable: true };
  readonly dialect: Dialect;

  constructor(
    readonly db: SqlDatabase,
    private readonly options: DbTransportOptions = {},
  ) {
    this.dialect = dialectOf(db);
  }

  async setup(): Promise<void> {
    if (this.options.autoCreateSchema !== false) await createFlagsTables(this.db, this.options);
    else await ensureEventPartitions(this.db, Date.now());
  }

  async publish(events: FlagEvent[], options: PublishOptions = {}): Promise<void> {
    if (events.length === 0) return;
    const client = options.client ?? this.db;
    // Chunked: one statement per 500 rows keeps every driver under its bind-parameter limit.
    for (let i = 0; i < events.length; i += 500) {
      const chunk = events.slice(i, i + 500);
      const placeholders = chunk.map(() => `(${COLUMNS.map(() => '?').join(', ')})`).join(', ');
      const bindings = chunk.flatMap((e) => [
        e.id,
        e.schemaVersion,
        e.app,
        e.environment,
        e.type,
        e.flag ?? null,
        e.experiment ?? null,
        e.variant ?? null,
        e.name ?? null,
        e.subject,
        e.subjectType,
        e.value ?? null,
        jsonValue(e.props),
        e.ts,
      ]);
      await client.rawQuery(
        `INSERT INTO flags_events (${COLUMNS.join(', ')}) VALUES ${placeholders}`,
        bindings,
      );
    }
  }

  async consume(
    sink: string,
    options: { batchSize: number; leaseMs: number; owner: string },
  ): Promise<Delivery | null> {
    const now = Date.now();
    await this.db.rawQuery(
      insertIgnore(
        this.dialect,
        'flags_sink_cursors',
        ['sink', 'last_id', 'last_tx', 'delivered', 'updated_at'],
        1,
      ),
      [sink, 0, 0, 0, now],
    );
    await this.db.rawQuery(
      `UPDATE flags_sink_cursors SET leased_by = ?, lease_until = ?
        WHERE sink = ? AND (lease_until IS NULL OR lease_until < ? OR leased_by = ?)`,
      [options.owner, now + options.leaseMs, sink, now, options.owner],
    );
    const cursorRows = await query<{
      leased_by: string | null;
      last_id: unknown;
      last_tx: unknown;
    }>(this.db, 'SELECT leased_by, last_id, last_tx FROM flags_sink_cursors WHERE sink = ?', [
      sink,
    ]);
    const cursor = cursorRows[0];
    if (!cursor || cursor.leased_by !== options.owner) return null;
    const lastId = toNumber(cursor.last_id);
    const lastTx = String(cursor.last_tx ?? 0);

    const rows = await this.#read(lastTx, lastId, options.batchSize);
    const events = rows.map(toEvent);
    const tail = rows.at(-1);
    const owner = options.owner;
    let settled = false;
    const once = async (fn: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      await fn();
    };
    return {
      events,
      ack: () =>
        once(async () => {
          if (!tail) return this.#release(sink, owner);
          await this.db.rawQuery(
            `UPDATE flags_sink_cursors
                SET last_id = ?, last_tx = ?, delivered = delivered + ?, last_error = NULL, updated_at = ?, lease_until = NULL
              WHERE sink = ? AND leased_by = ?`,
            [
              toNumber(tail.id),
              tail.tx_text === undefined ? 0 : String(tail.tx_text),
              events.length,
              Date.now(),
              sink,
              owner,
            ],
          );
        }),
      release: () => once(() => this.#release(sink, owner)),
      fail: (error) =>
        once(async () => {
          const message = error instanceof Error ? error.message : String(error);
          await this.db.rawQuery(
            'UPDATE flags_sink_cursors SET last_error = ?, lease_until = NULL, updated_at = ? WHERE sink = ? AND leased_by = ?',
            [message.slice(0, 2000), Date.now(), sink, owner],
          );
        }),
    };
  }

  async #release(sink: string, owner: string) {
    await this.db.rawQuery(
      'UPDATE flags_sink_cursors SET lease_until = NULL WHERE sink = ? AND leased_by = ?',
      [sink, owner],
    );
  }

  async #read(
    lastTx: string,
    lastId: number,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> {
    if (this.dialect === 'postgres') {
      return query(
        this.db,
        `SELECT *, tx::text AS tx_text FROM flags_events
          WHERE (tx, id) > (?::text::xid8, ?)
            AND tx < pg_snapshot_xmin(pg_current_snapshot())
          ORDER BY tx, id
          LIMIT ?`,
        [lastTx, lastId, limit],
      );
    }
    if (this.dialect === 'mysql') {
      const horizon = Date.now() - (this.options.mysqlSafetyMs ?? 10_000);
      return query(
        this.db,
        'SELECT * FROM flags_events WHERE id > ? AND ts < ? ORDER BY id LIMIT ?',
        [lastId, horizon, limit],
      );
    }
    return query(this.db, 'SELECT * FROM flags_events WHERE id > ? ORDER BY id LIMIT ?', [
      lastId,
      limit,
    ]);
  }

  async rewind(sink: string): Promise<void> {
    await this.db.rawQuery(
      'UPDATE flags_sink_cursors SET last_id = 0, last_tx = 0, delivered = 0, last_error = NULL, updated_at = ? WHERE sink = ?',
      [Date.now(), sink],
    );
  }

  async status(sinks: string[]): Promise<SinkStatus[]> {
    const cursors = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM flags_sink_cursors',
    );
    const byName = new Map(cursors.map((row) => [String(row.sink), row]));
    const maxRows = await query<{ max: unknown }>(
      this.db,
      'SELECT MAX(id) AS max FROM flags_events',
    );
    const maxId = toNumber(maxRows[0]?.max ?? 0);
    const out: SinkStatus[] = [];
    for (const sink of sinks) {
      const row = byName.get(sink);
      const lastId = toNumber(row?.last_id ?? 0);
      // Exact lag would be a COUNT over the log; ids are dense enough for an estimate.
      out.push({
        sink,
        lag: Math.max(0, maxId - lastId),
        delivered: toNumber(row?.delivered ?? 0),
        leasedBy:
          row?.leased_by && toNumber(row.lease_until) > Date.now() ? String(row.leased_by) : null,
        lastError: row?.last_error ? String(row.last_error) : null,
      });
    }
    return out;
  }

  async safePruneId(sinks: string[]): Promise<number> {
    if (sinks.length === 0) {
      const maxRows = await query<{ max: unknown }>(
        this.db,
        'SELECT MAX(id) AS max FROM flags_events',
      );
      return toNumber(maxRows[0]?.max ?? 0);
    }
    const placeholders = sinks.map(() => '?').join(', ');
    const rows = await query<{ min: unknown; count: unknown }>(
      this.db,
      `SELECT MIN(last_id) AS min, COUNT(*) AS count FROM flags_sink_cursors WHERE sink IN (${placeholders})`,
      sinks,
    );
    // A sink that never consumed has no cursor row yet: nothing is safe to prune.
    if (toNumber(rows[0]?.count ?? 0) < sinks.length) return 0;
    return toNumber(rows[0]?.min ?? 0);
  }
}

export function toEvent(row: Record<string, unknown>): FlagEvent {
  return {
    id: String(row.event_id),
    schemaVersion: toNumber(row.schema_version),
    app: String(row.app),
    environment: String(row.environment),
    type: row.type as FlagEvent['type'],
    ...(row.flag !== null && row.flag !== undefined ? { flag: String(row.flag) } : {}),
    ...(row.experiment !== null && row.experiment !== undefined
      ? { experiment: String(row.experiment) }
      : {}),
    ...(row.variant !== null && row.variant !== undefined ? { variant: String(row.variant) } : {}),
    ...(row.name !== null && row.name !== undefined ? { name: String(row.name) } : {}),
    subject: String(row.subject),
    subjectType: String(row.subject_type),
    ...(row.value !== null && row.value !== undefined ? { value: toNumber(row.value) } : {}),
    ...(row.props !== null && row.props !== undefined
      ? { props: parseJson<Record<string, unknown>>(row.props) }
      : {}),
    ts: toNumber(row.ts),
  };
}

/** Exposed for the db transport's SQL client typing in tests. */
export type { SqlClient };
