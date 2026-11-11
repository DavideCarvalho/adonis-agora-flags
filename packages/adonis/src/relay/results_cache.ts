import type { ExperimentResults } from '../analytics/results.js';
import { jsonValue, parseJson, query, type SqlDatabase } from '../sql.js';

/** Last computed experiment results: the console reads these instead of scanning events. */
export interface ResultsCache {
  get(environment: string, experiment: string): Promise<ExperimentResults | null>;
  set(environment: string, experiment: string, results: ExperimentResults): Promise<void>;
}

export class MemoryResultsCache implements ResultsCache {
  #map = new Map<string, ExperimentResults>();
  async get(environment: string, experiment: string) {
    return this.#map.get(`${environment}\u0000${experiment}`) ?? null;
  }
  async set(environment: string, experiment: string, results: ExperimentResults) {
    this.#map.set(`${environment}\u0000${experiment}`, results);
  }
}

/** `flags_results`, shared by every replica. */
export class LucidResultsCache implements ResultsCache {
  constructor(private readonly db: SqlDatabase) {}

  async get(environment: string, experiment: string): Promise<ExperimentResults | null> {
    const rows = await query<{ payload: unknown }>(
      this.db,
      'SELECT payload FROM flags_results WHERE environment = ? AND experiment = ?',
      [environment, experiment],
    );
    return rows[0] ? parseJson<ExperimentResults>(rows[0].payload) : null;
  }

  async set(environment: string, experiment: string, results: ExperimentResults): Promise<void> {
    await this.db.transaction(async (trx) => {
      await trx.rawQuery('DELETE FROM flags_results WHERE environment = ? AND experiment = ?', [
        environment,
        experiment,
      ]);
      await trx.rawQuery(
        'INSERT INTO flags_results (environment, experiment, payload, computed_at) VALUES (?, ?, ?, ?)',
        [environment, experiment, jsonValue(results), Date.now()],
      );
    });
  }
}
