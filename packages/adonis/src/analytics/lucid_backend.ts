import { query, type SqlClient, toNumber } from '../sql.js';
import { type AnalyticsBackend, statsFromRow } from './backend.js';
import {
  type MetricDefinition,
  subjectAggregates,
  UNBOUNDED_MS,
  type VariantMetricStats,
} from './metrics.js';

/**
 * Reads the `lucid` sink's tables (`flags_exposures`, `flags_tracks`). Level 1 of DESIGN §12: fine
 * up to tens of millions of events a month, especially with results computed by the worker and
 * cached, as the provider does.
 */
export class LucidBackend implements AnalyticsBackend {
  readonly kind = 'lucid';

  constructor(private readonly db: SqlClient) {}

  async exposures(experiment: string, environment: string): Promise<Record<string, number>> {
    const rows = await query<{ variant: string; n: unknown }>(
      this.db,
      'SELECT variant, COUNT(*) AS n FROM flags_exposures WHERE environment = ? AND experiment = ? GROUP BY variant',
      [environment, experiment],
    );
    return Object.fromEntries(rows.map((row) => [row.variant, toNumber(row.n)]));
  }

  async metric(
    experiment: string,
    definition: MetricDefinition,
    environment: string,
  ): Promise<Record<string, VariantMetricStats>> {
    const { post, pre } = subjectAggregates(definition);
    const window = definition.windowMs ?? UNBOUNDED_MS;
    const preWindow = definition.cupedMs ?? 0;
    const rows = await query<Record<string, unknown>>(
      this.db,
      `SELECT variant,
              COUNT(*) AS n,
              SUM(y) AS sum_y, SUM(y * y) AS sum_y2,
              SUM(xv) AS sum_x, SUM(xv * xv) AS sum_x2, SUM(xv * y) AS sum_xy
         FROM (
           SELECT x.variant AS variant, x.subject AS subject,
                  ${post} AS y,
                  ${pre} AS xv
             FROM flags_exposures x
             LEFT JOIN flags_tracks t
               ON t.subject = x.subject
              AND t.environment = x.environment
              AND t.name = ?
              AND t.ts >= x.first_seen_ts - ?
              AND t.ts < x.first_seen_ts + ?
            WHERE x.environment = ? AND x.experiment = ?
            GROUP BY x.variant, x.subject
         ) per_subject
        GROUP BY variant`,
      [definition.event, preWindow, window, environment, experiment],
    );
    return Object.fromEntries(rows.map((row) => [String(row.variant), statsFromRow(row)]));
  }
}
