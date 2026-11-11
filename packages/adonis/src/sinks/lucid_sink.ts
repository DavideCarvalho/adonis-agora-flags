import type { FlagEvent } from '../events/event.js';
import { createFlagsTables } from '../schema.js';
import { type Dialect, dialectOf, insertIgnore, jsonValue, type SqlDatabase } from '../sql.js';
import type { Sink } from './sink.js';

/**
 * The analysis tables in your database: `flags_exposures` (one row per experiment and subject — the
 * first exposure wins, which is also what sticky assignment reads) and `flags_tracks` (one row per
 * tracked event, deduped by event id). The `lucid` analytics backend reads them.
 */
export class LucidSink implements Sink {
  readonly kind = 'lucid';
  readonly dialect: Dialect;

  constructor(
    readonly db: SqlDatabase,
    private readonly options: {
      autoCreateSchema?: boolean;
      batchSize?: number;
      intervalMs?: number;
    } = {},
  ) {
    this.dialect = dialectOf(db);
  }

  get batchSize() {
    return this.options.batchSize;
  }

  get intervalMs() {
    return this.options.intervalMs;
  }

  async setup(): Promise<void> {
    if (this.options.autoCreateSchema !== false) await createFlagsTables(this.db);
  }

  async write(events: FlagEvent[]): Promise<void> {
    const exposures = events.filter((e) => e.type === 'exposure' && e.experiment && e.variant);
    const tracks = events.filter((e) => e.type === 'track' && e.name);
    await this.db.transaction(async (trx) => {
      for (let i = 0; i < exposures.length; i += 300) {
        const chunk = exposures.slice(i, i + 300);
        await trx.rawQuery(
          insertIgnore(
            this.dialect,
            'flags_exposures',
            ['experiment', 'subject', 'variant', 'flag', 'app', 'subject_type', 'first_seen_ts'],
            chunk.length,
          ),
          chunk.flatMap((e) => [
            e.experiment,
            e.subject,
            e.variant,
            e.flag ?? e.experiment,
            e.app,
            e.subjectType,
            e.ts,
          ]),
        );
      }
      for (let i = 0; i < tracks.length; i += 300) {
        const chunk = tracks.slice(i, i + 300);
        await trx.rawQuery(
          insertIgnore(
            this.dialect,
            'flags_tracks',
            ['event_id', 'name', 'subject', 'subject_type', 'app', 'value', 'props', 'ts'],
            chunk.length,
          ),
          chunk.flatMap((e) => [
            e.id,
            e.name,
            e.subject,
            e.subjectType,
            e.app,
            e.value ?? null,
            jsonValue(e.props),
            e.ts,
          ]),
        );
      }
    });
  }

  async forget(subject: string): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx.rawQuery('DELETE FROM flags_exposures WHERE subject = ?', [subject]);
      await trx.rawQuery('DELETE FROM flags_tracks WHERE subject = ?', [subject]);
    });
  }
}
