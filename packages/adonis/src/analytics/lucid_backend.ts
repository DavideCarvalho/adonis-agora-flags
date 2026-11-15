import { query, type SqlClient, toNumber } from '../sql.js';
import { type AnalyticsBackend, type AnalyticsScope, scopedApps, statsFromRow } from './backend.js';
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
  readonly filtersByApp = true;

  constructor(private readonly db: SqlClient) {}

  async exposures(
    experiment: string,
    environment: string,
    scope?: AnalyticsScope,
  ): Promise<Record<string, number>> {
    const apps = appFilter('app', scope);
    const rows = await query<{ variant: string; n: unknown }>(
      this.db,
      `SELECT variant, COUNT(*) AS n FROM flags_exposures WHERE environment = ? AND experiment = ?${apps.sql} GROUP BY variant`,
      [environment, experiment, ...apps.bindings],
    );
    return Object.fromEntries(rows.map((row) => [row.variant, toNumber(row.n)]));
  }

  async metric(
    experiment: string,
    definition: MetricDefinition,
    environment: string,
    scope?: AnalyticsScope,
  ): Promise<Record<string, VariantMetricStats>> {
    const { post, pre } = subjectAggregates(definition);
    const trackApps = appFilter('t.app', scope);
    const exposureApps = appFilter('x.app', scope);
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
              AND t.ts < x.first_seen_ts + ?${trackApps.sql}
            WHERE x.environment = ? AND x.experiment = ?${exposureApps.sql}
            GROUP BY x.variant, x.subject
         ) per_subject
        GROUP BY variant`,
      [
        definition.event,
        preWindow,
        window,
        ...trackApps.bindings,
        environment,
        experiment,
        ...exposureApps.bindings,
      ],
    );
    return Object.fromEntries(rows.map((row) => [String(row.variant), statsFromRow(row)]));
  }
}

/** ` AND <column> IN (?, …)` for a scoped query; nothing for every app; never-true for no app. */
function appFilter(
  column: string,
  scope: AnalyticsScope | undefined,
): { sql: string; bindings: string[] } {
  const apps = scopedApps(scope);
  if (apps === undefined) return { sql: '', bindings: [] };
  if (apps.length === 0) return { sql: ' AND 1 = 0', bindings: [] };
  return { sql: ` AND ${column} IN (${apps.map(() => '?').join(', ')})`, bindings: apps };
}
