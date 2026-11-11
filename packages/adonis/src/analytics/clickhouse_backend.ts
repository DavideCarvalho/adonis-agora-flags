import { ClickHouseClient, type ClickHouseOptions } from '../sinks/clickhouse.js';
import { type AnalyticsBackend, statsFromRow } from './backend.js';
import { type MetricDefinition, subjectAggregates, type VariantMetricStats } from './metrics.js';

/**
 * Level 3 of DESIGN §12: reads the table the `clickhouse` sink writes. Queries use `FINAL` so
 * re-sent events are collapsed even before ClickHouse merges them.
 */
export class ClickHouseBackend implements AnalyticsBackend {
  readonly kind = 'clickhouse';
  readonly client: ClickHouseClient;

  constructor(options: ClickHouseOptions) {
    this.client = new ClickHouseClient(options);
  }

  #exposuresSql() {
    return `SELECT subject, argMin(variant, ts) AS variant, min(ts) AS first_seen_ts
              FROM ${this.client.table} FINAL
             WHERE type = 'exposure' AND environment = {environment:String}
               AND experiment = {experiment:String}
             GROUP BY subject`;
  }

  async exposures(experiment: string, environment: string): Promise<Record<string, number>> {
    const rows = await this.client.select<{ variant: string; n: string | number }>(
      `SELECT variant, count() AS n FROM (${this.#exposuresSql()}) GROUP BY variant`,
      { experiment, environment },
    );
    return Object.fromEntries(rows.map((row) => [row.variant, Number(row.n)]));
  }

  async metric(
    experiment: string,
    definition: MetricDefinition,
    environment: string,
  ): Promise<Record<string, VariantMetricStats>> {
    const { post, pre } = subjectAggregates(definition);
    const rows = await this.client.select(
      `WITH x AS (${this.#exposuresSql()}),
            t AS (
              SELECT subject, value, ts FROM ${this.client.table} FINAL
               WHERE type = 'track' AND environment = {environment:String}
                 AND name = {event:String}
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
      { experiment, environment, event: definition.event },
    );
    return Object.fromEntries(rows.map((row) => [String(row.variant), statsFromRow(row)]));
  }
}
