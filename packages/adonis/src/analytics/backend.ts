import type { MetricDefinition, VariantMetricStats } from './metrics.js';

/**
 * Where experiment numbers come from. DESIGN §12: the backend only aggregates — per-variant
 * sufficient statistics — and the inference runs once, in TypeScript (`flags-core/stats`), so every
 * backend reports the same results for the same data.
 */
export interface AnalyticsBackend {
  readonly kind: string;
  /** Subjects exposed to the experiment, per variant. */
  exposures(experiment: string): Promise<Record<string, number>>;
  /** One metric's statistics per variant, over every exposed subject (zeros included). */
  metric(
    experiment: string,
    definition: MetricDefinition,
  ): Promise<Record<string, VariantMetricStats>>;
  close?(): Promise<void>;
}

export function emptyStats(): VariantMetricStats {
  return { n: 0, sumY: 0, sumY2: 0, sumX: 0, sumX2: 0, sumXY: 0 };
}

/** Maps a backend row (any numeric representation) to {@link VariantMetricStats}. */
export function statsFromRow(row: Record<string, unknown>): VariantMetricStats {
  const n = (key: string) => {
    const value = row[key];
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') return Number(value);
    return 0;
  };
  return {
    n: n('n'),
    sumY: n('sum_y'),
    sumY2: n('sum_y2'),
    sumX: n('sum_x'),
    sumX2: n('sum_x2'),
    sumXY: n('sum_xy'),
  };
}
