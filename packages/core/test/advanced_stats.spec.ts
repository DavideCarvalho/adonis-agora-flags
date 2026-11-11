import { describe, expect, it } from 'vitest';
import {
  type CupedStats,
  conversionStats,
  cupedTest,
  type SufficientStats,
  sequentialTest,
  welchTest,
} from '../src/stats.js';

/** Small deterministic PRNG (mulberry32) plus Box–Muller, so the simulations are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () =>
    Math.sqrt(-2 * Math.log(uniform() || 1e-12)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

const accumulate = (pairs: Array<[number, number]>): CupedStats =>
  pairs.reduce(
    (s, [x, y]) => ({
      n: s.n + 1,
      sumX: s.sumX + x,
      sumX2: s.sumX2 + x * x,
      sumY: s.sumY + y,
      sumY2: s.sumY2 + y * y,
      sumXY: s.sumXY + x * y,
    }),
    { n: 0, sumX: 0, sumX2: 0, sumY: 0, sumY2: 0, sumXY: 0 },
  );

const plain = (s: CupedStats): SufficientStats => ({ n: s.n, sum: s.sumY, sumSquares: s.sumY2 });

describe('cupedTest', () => {
  it('keeps the effect, shrinks the variance when the covariate predicts the metric', () => {
    const r = rng(7);
    const make = (lift: number) =>
      Array.from({ length: 2000 }, (): [number, number] => {
        const x = 10 + 3 * r.normal();
        return [x, x + lift + 0.5 * r.normal()];
      });
    const control = accumulate(make(0));
    const treatment = accumulate(make(0.1));
    const cuped = cupedTest(control, treatment);
    const welch = welchTest(plain(control), plain(treatment));
    expect(cuped.theta).toBeGreaterThan(0.9);
    expect(cuped.theta).toBeLessThan(1.1);
    expect(cuped.varianceReduction).toBeGreaterThan(0.9);
    // Same quantity measured, much tighter interval.
    expect(cuped.controlMean).toBeCloseTo(welch.controlMean, 12);
    expect(cuped.interval[1] - cuped.interval[0]).toBeLessThan(
      (welch.interval[1] - welch.interval[0]) / 3,
    );
    expect(cuped.pValue).toBeLessThan(welch.pValue);
    expect(cuped.difference).toBeGreaterThan(0.05);
    expect(cuped.difference).toBeLessThan(0.15);
  });

  it('degrades to Welch when the covariate is useless', () => {
    const control = accumulate(Array.from({ length: 50 }, (_, i): [number, number] => [0, i % 7]));
    const treatment = accumulate(
      Array.from({ length: 60 }, (_, i): [number, number] => [0, (i % 5) + 1]),
    );
    const cuped = cupedTest(control, treatment);
    const welch = welchTest(plain(control), plain(treatment));
    expect(cuped.theta).toBe(0);
    expect(cuped.varianceReduction).toBe(0);
    expect(cuped.pValue).toBeCloseTo(welch.pValue, 12);
  });
});

describe('sequentialTest', () => {
  it('reports a wider interval than the fixed-horizon test, centred on the same difference', () => {
    const control = conversionStats({ n: 20_000, conversions: 2000 });
    const treatment = conversionStats({ n: 20_000, conversions: 2300 });
    const seq = sequentialTest(control, treatment);
    const fixed = welchTest(control, treatment);
    expect(seq.difference).toBeCloseTo(fixed.difference, 12);
    expect(seq.interval[1] - seq.interval[0]).toBeGreaterThan(
      fixed.interval[1] - fixed.interval[0],
    );
    expect(seq.significant).toBe(true);
    expect(seq.pValue).toBeLessThan(0.05);
  });

  it('keeps the running minimum when given the previous p-value', () => {
    const control = conversionStats({ n: 1000, conversions: 100 });
    const treatment = conversionStats({ n: 1000, conversions: 101 });
    expect(sequentialTest(control, treatment).pValue).toBeGreaterThan(0.5);
    expect(sequentialTest(control, treatment, { previousPValue: 0.2 }).pValue).toBe(0.2);
  });

  it('controls false positives under continuous peeking (A/A simulation)', () => {
    const r = rng(42);
    const experiments = 300;
    const peeks = 25;
    const perPeek = 200;
    let falsePositives = 0;
    for (let e = 0; e < experiments; e++) {
      const a = { n: 0, sum: 0, sumSquares: 0 };
      const b = { n: 0, sum: 0, sumSquares: 0 };
      let rejected = false;
      for (let p = 0; p < peeks && !rejected; p++) {
        for (let i = 0; i < perPeek; i++) {
          const x = 5 + r.normal();
          const y = 5 + r.normal();
          a.n++;
          a.sum += x;
          a.sumSquares += x * x;
          b.n++;
          b.sum += y;
          b.sumSquares += y * y;
        }
        if (sequentialTest(a, b, { tau: 0.2 }).significant) rejected = true;
      }
      if (rejected) falsePositives++;
    }
    // Peeking 25 times at a fixed-horizon test would reject far more than 5%.
    expect(falsePositives / experiments).toBeLessThan(0.06);
  });
});
