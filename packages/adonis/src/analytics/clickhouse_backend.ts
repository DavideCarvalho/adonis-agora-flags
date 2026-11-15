import { ClickHouseClient, type ClickHouseOptions } from '../sinks/clickhouse.js';
import { type AnalyticsBackend, type AnalyticsScope, scopedApps, statsFromRow } from './backend.js';
import { type MetricDefinition, subjectAggregates, type VariantMetricStats } from './metrics.js';

/**
 * Level 3 of DESIGN §12: reads the table the `clickhouse` sink writes. Queries use `FINAL` so
 * re-sent events are collapsed even before ClickHouse merges them.
 */
export class ClickHouseBackend implements AnalyticsBackend {
  readonly kind = 'clickhouse';
  readonly filtersByApp = true;
  readonly client: ClickHouseClient;

  constructor(options: ClickHouseOptions) {
    this.client = new ClickHouseClient(options);
  }

  /** A subject counts in the app where it was first exposed, like the `lucid` backend. */
  #exposuresSql(apps: AppFilter) {
    return `SELECT subject, argMin(variant, ts) AS variant, min(ts) AS first_seen_ts,
                   argMin(app, ts) AS first_app
              FROM ${this.client.table} FINAL
             WHERE type = 'exposure' AND environment = {environment:String}
               AND experiment = {experiment:String}
             GROUP BY subject${apps.sql ? ` HAVING ${apps.in('first_app')}` : ''}`;
  }

  async exposures(
    experiment: string,
    environment: string,
    scope?: AnalyticsScope,
  ): Promise<Record<string, number>> {
    const apps = appFilter(scope);
    const rows = await this.client.select<{ variant: string; n: string | number }>(
      `SELECT variant, count() AS n FROM (${this.#exposuresSql(apps)}) GROUP BY variant`,
      { experiment, environment, ...apps.params },
    );
    return Object.fromEntries(rows.map((row) => [row.variant, Number(row.n)]));
  }

  async metric(
    experiment: string,
    definition: MetricDefinition,
    environment: string,
    scope?: AnalyticsScope,
  ): Promise<Record<string, VariantMetricStats>> {
    const { post, pre } = subjectAggregates(definition);
    const apps = appFilter(scope);
    const rows = await this.client.select(
      `WITH x AS (${this.#exposuresSql(apps)}),
            t AS (
              SELECT subject, value, ts FROM ${this.client.table} FINAL
               WHERE type = 'track' AND environment = {environment:String}
                 AND name = {event:String}${apps.sql ? ` AND ${apps.in('app')}` : ''}
            )
       SELECT variant, count() AS n,
              sum(y) AS sum_y, sum(y * y) AS sum_y2,
              sum(xv) AS sum_x, sum(xv * xv) AS sum_x2, sum(xv * y) AS sum_xy
         FROM (
           SELECT x.variant AS variant, x.subject AS subject,
                  toFloat64(${post}) AS y,
                  toFloat64(${pre}) AS xv
             FROM x
             LEFT JOIN t ON t.subject = x.subject
            GROUP BY x.variant, x.subject
         )
        GROUP BY variant`,
      { experiment, environment, event: definition.event, ...apps.params },
    );
    return Object.fromEntries(rows.map((row) => [String(row.variant), statsFromRow(row)]));
  }
}

interface AppFilter {
  /** Non-empty when the query is scoped. */
  sql: string;
  in(column: string): string;
  params: Record<string, string>;
}

/** Scoped queries bind each app as its own `{appN:String}` parameter. */
function appFilter(scope: AnalyticsScope | undefined): AppFilter {
  const apps = scopedApps(scope);
  if (apps === undefined) return { sql: '', in: () => '1', params: {} };
  const params = Object.fromEntries(apps.map((app, i) => [`app${i}`, app]));
  const list = apps.map((_, i) => `{app${i}:String}`).join(', ');
  return {
    sql: 'scoped',
    in: (column) => (apps.length === 0 ? '0' : `${column} IN (${list})`),
    params,
  };
}
