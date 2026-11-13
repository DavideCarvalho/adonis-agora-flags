import type { MetricDefinition } from '@adonis-agora/flags-core';

export type { MetricDefinition, MetricKind } from '@adonis-agora/flags-core';

/** Everything a metric builder takes besides its kind and event. */
export type MetricOptions = Omit<MetricDefinition, 'kind' | 'event'>;

/** Builders for `metrics` in `config/flags.ts`. */
export const metric = {
  /** Share of subjects who did `event` at least once after exposure. */
  conversion(event: string, options: MetricOptions = {}): MetricDefinition {
    return { ...options, kind: 'conversion', event };
  },
  /** Times each subject did `event` after exposure, averaged per subject. */
  count(event: string, options: MetricOptions = {}): MetricDefinition {
    return { ...options, kind: 'count', event };
  },
  /** Sum of the events' `value` per subject (revenue per user), averaged per subject. */
  sum(event: string, options: MetricOptions = {}): MetricDefinition {
    return { ...options, kind: 'sum', event };
  },
};

/** Per-variant sufficient statistics of one metric (y) and its CUPED covariate (x). */
export interface VariantMetricStats {
  n: number;
  sumY: number;
  sumY2: number;
  sumX: number;
  sumX2: number;
  sumXY: number;
}

/**
 * The per-subject aggregation, as SQL expressions over a joined track row `t` and exposure row `x`.
 * Shared by every SQL backend so they agree on what a metric means. The time windows live in the
 * expressions, not in a WHERE clause: a subject with no event in the window must still count, as a
 * zero, in the denominator.
 */
export function subjectAggregates(definition: MetricDefinition): { post: string; pre: string } {
  const window = Math.trunc(Number(definition.windowMs ?? UNBOUNDED_MS));
  const preWindow = Math.trunc(Number(definition.cupedMs ?? 0));
  if (!Number.isFinite(window) || window <= 0) throw new RangeError('metric windowMs must be > 0');
  if (!Number.isFinite(preWindow) || preWindow < 0)
    throw new RangeError('metric cupedMs must be ≥ 0');
  const post = `t.ts >= x.first_seen_ts AND t.ts < x.first_seen_ts + ${window}`;
  const pre = `t.ts < x.first_seen_ts AND t.ts >= x.first_seen_ts - ${preWindow}`;
  const agg = (condition: string) => {
    if (definition.kind === 'conversion') return `MAX(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
    if (definition.kind === 'count') return `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
    return `COALESCE(SUM(CASE WHEN ${condition} THEN t.value ELSE 0 END), 0)`;
  };
  return { post: agg(post), pre: preWindow > 0 ? agg(pre) : '0' };
}

/** A window far beyond any real experiment, so "no limit" needs no special SQL. */
export const UNBOUNDED_MS = 100 * 365 * 24 * 3600 * 1000;
