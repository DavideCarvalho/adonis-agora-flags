import type { ExperimentResults } from '../analytics/results.js';
import { jsonValue, parseJson, query, type SqlDatabase } from '../sql.js';

/** Last computed experiment results: the console reads these instead of scanning events. */
export interface ResultsCache {
  get(experiment: string): Promise<ExperimentResults | null>;
  set(experiment: string, results: ExperimentResults): Promise<void>;
}

export class MemoryResultsCache implements ResultsCache {
  #map = new Map<string, ExperimentResults>();
  async get(experiment: string) {
    return this.#map.get(experiment) ?? null;
  }
  async set(experiment: string, results: ExperimentResults) {
    this.#map.set(experiment, results);
  }
}

/** `flags_results`, shared by every replica. */
export class LucidResultsCache implements ResultsCache {
  constructor(private readonly db: SqlDatabase) {}

  async get(experiment: string): Promise<ExperimentResults | null> {
    const rows = await query<{ payload: unknown }>(
      this.db,
      'SELECT payload FROM flags_results WHERE experiment = ?',
      [experiment],
    );
    return rows[0] ? parseJson<ExperimentResults>(rows[0].payload) : null;
  }

  async set(experiment: string, results: ExperimentResults): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx.rawQuery('DELETE FROM flags_results WHERE experiment = ?', [experiment]);
      await trx.rawQuery(
        'INSERT INTO flags_results (experiment, payload, computed_at) VALUES (?, ?, ?)',
        [experiment, jsonValue(results), Date.now()],
      );
    });
  }
}
