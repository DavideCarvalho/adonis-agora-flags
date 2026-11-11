import {
  type CupedStats,
  cupedTest,
  type FlagDefinition,
  proportionTest,
  type SrmResult,
  sequentialTest,
  srmTest,
  welchTest,
} from '@adonis-agora/flags-core';
import type { AnalyticsBackend } from './backend.js';
import type { MetricDefinition, VariantMetricStats } from './metrics.js';

/** The variant name exposures of global-holdout subjects are recorded under. */
export const HOLDOUT_VARIANT = '__holdout__';

/** An experiment as the results service sees it. */
export interface ExperimentSpec {
  /** Experiment key (the flag key unless `experiment.key` says otherwise). */
  key: string;
  flag: string;
  /** Metric name → definition. */
  metrics: Record<string, MetricDefinition>;
  /** Metrics that must not get worse; a significant move the wrong way is flagged. */
  guardrails?: string[];
  /** Control variant. Default: the flag's `offVariant`. */
  control?: string;
  /** Confidence level for fixed-horizon intervals. Default 0.95. */
  confidence?: number;
}

export interface Comparison {
  variant: string;
  test: 'proportion' | 'welch' | 'cuped';
  difference: number;
  relativeLift: number;
  pValue: number;
  interval: [number, number];
  significant: boolean;
  /** Always-valid (sequential) version of the same comparison: safe to peek. */
  sequential: { pValue: number; interval: [number, number]; significant: boolean };
  /** CUPED only. */
  varianceReduction?: number;
  /** `better` / `worse` according to the metric's direction, when significant. */
  verdict: 'better' | 'worse' | 'inconclusive';
}

export interface MetricResult {
  name: string;
  kind: MetricDefinition['kind'];
  event: string;
  direction: 'increase' | 'decrease';
  guardrail: boolean;
  variants: Array<{ variant: string; n: number; mean: number }>;
  comparisons: Comparison[];
  /** A guardrail that got significantly worse in some variant. */
  alert: boolean;
}

export interface ExperimentResults {
  experiment: string;
  flag: string;
  control: string;
  computedAt: string;
  exposures: Record<string, number>;
  /** Subjects of the global holdout who reached this experiment (not compared). */
  holdout: number;
  /** `null` when the flag has no single split to compare against. */
  srm: (SrmResult & { expected: Record<string, number> }) | null;
  metrics: MetricResult[];
  /** Comparisons computed with too few subjects (< 2 per variant) are skipped and listed here. */
  warnings: string[];
}

/**
 * The configured split weights, when the flag assigns through exactly one split (fallthrough or a
 * single rule). SRM is only meaningful against one known allocation.
 */
export function expectedWeights(flag: FlagDefinition): Record<string, number> | null {
  const splits = [flag.fallthrough, ...(flag.rules ?? []).map((rule) => rule.serve)].filter(
    (serve): serve is Extract<typeof serve, { split: unknown }> => 'split' in serve,
  );
  if (splits.length !== 1) return null;
  const weights: Record<string, number> = {};
  for (const arm of splits[0]!.split)
    if (arm.weight > 0) weights[arm.variant] = (weights[arm.variant] ?? 0) + arm.weight;
  return weights;
}

function asCuped(stats: VariantMetricStats): CupedStats {
  return stats;
}

/** Computes everything the console shows for an experiment. */
export async function computeResults(
  backend: AnalyticsBackend,
  spec: ExperimentSpec,
  flag: FlagDefinition | undefined,
  previous?: ExperimentResults,
): Promise<ExperimentResults> {
  const control = spec.control ?? flag?.offVariant ?? 'control';
  const confidence = spec.confidence ?? 0.95;
  const warnings: string[] = [];
  const allExposures = await backend.exposures(spec.key);
  // Global-holdout subjects are recorded under a reserved variant; they are not an arm of this
  // experiment, so they are reported apart and left out of every comparison.
  const holdout = allExposures[HOLDOUT_VARIANT] ?? 0;
  const exposures = Object.fromEntries(
    Object.entries(allExposures).filter(([variant]) => variant !== HOLDOUT_VARIANT),
  );

  let srm: ExperimentResults['srm'] = null;
  const expected = flag ? expectedWeights(flag) : null;
  if (expected && Object.keys(expected).length >= 2) {
    const variants = Object.keys(expected);
    const observed = variants.map((variant) => exposures[variant] ?? 0);
    if (observed.reduce((a, b) => a + b, 0) > 0) {
      srm = {
        ...srmTest(
          observed,
          variants.map((v) => expected[v]!),
        ),
        expected,
      };
    }
  }

  const metrics: MetricResult[] = [];
  for (const [name, definition] of Object.entries(spec.metrics)) {
    const { [HOLDOUT_VARIANT]: _held, ...stats } = await backend.metric(spec.key, definition);
    const direction = definition.direction ?? 'increase';
    const guardrail = spec.guardrails?.includes(name) ?? false;
    const variantNames = [...new Set([...Object.keys(exposures), ...Object.keys(stats)])].sort(
      (a, b) => (a === control ? -1 : b === control ? 1 : a.localeCompare(b)),
    );
    const result: MetricResult = {
      name,
      kind: definition.kind,
      event: definition.event,
      direction,
      guardrail,
      variants: variantNames.map((variant) => {
        const s = stats[variant];
        return { variant, n: s?.n ?? 0, mean: s && s.n > 0 ? s.sumY / s.n : 0 };
      }),
      comparisons: [],
      alert: false,
    };
    const base = stats[control];
    for (const variant of variantNames) {
      if (variant === control) continue;
      const treatment = stats[variant];
      if (!base || !treatment || base.n < 2 || treatment.n < 2) {
        warnings.push(`${name}: not enough subjects to compare "${variant}" with "${control}" yet`);
        continue;
      }
      const prior = previous?.metrics
        .find((m) => m.name === name)
        ?.comparisons.find((c) => c.variant === variant)?.sequential.pValue;
      const plainControl = { n: base.n, sum: base.sumY, sumSquares: base.sumY2 };
      const plainTreatment = { n: treatment.n, sum: treatment.sumY, sumSquares: treatment.sumY2 };
      let comparison: Omit<Comparison, 'verdict' | 'sequential' | 'variant'>;
      if (definition.cupedMs && definition.cupedMs > 0) {
        const r = cupedTest(asCuped(base), asCuped(treatment), confidence);
        comparison = {
          test: 'cuped',
          difference: r.difference,
          relativeLift: r.relativeLift,
          pValue: r.pValue,
          interval: r.interval,
          significant: r.pValue < 1 - confidence,
          varianceReduction: r.varianceReduction,
        };
      } else if (definition.kind === 'conversion') {
        const r = proportionTest(
          { n: base.n, conversions: base.sumY },
          { n: treatment.n, conversions: treatment.sumY },
          confidence,
        );
        comparison = {
          test: 'proportion',
          difference: r.difference,
          relativeLift: r.relativeLift,
          pValue: r.pValue,
          interval: r.interval,
          significant: r.pValue < 1 - confidence,
        };
      } else {
        const r = welchTest(plainControl, plainTreatment, confidence);
        comparison = {
          test: 'welch',
          difference: r.difference,
          relativeLift: r.relativeLift,
          pValue: r.pValue,
          interval: r.interval,
          significant: r.pValue < 1 - confidence,
        };
      }
      const seq = sequentialTest(plainControl, plainTreatment, {
        alpha: 1 - confidence,
        ...(prior !== undefined ? { previousPValue: prior } : {}),
      });
      const improves =
        direction === 'increase' ? comparison.difference > 0 : comparison.difference < 0;
      const verdict = comparison.significant ? (improves ? 'better' : 'worse') : 'inconclusive';
      result.comparisons.push({
        variant,
        ...comparison,
        sequential: { pValue: seq.pValue, interval: seq.interval, significant: seq.significant },
        verdict,
      });
      // Guardrails alert on the always-valid test, so watching them daily does not cry wolf.
      if (guardrail && seq.significant && !improves) result.alert = true;
    }
    metrics.push(result);
  }

  return {
    experiment: spec.key,
    flag: spec.flag,
    control,
    computedAt: new Date().toISOString(),
    exposures,
    holdout,
    srm,
    metrics,
    warnings,
  };
}
