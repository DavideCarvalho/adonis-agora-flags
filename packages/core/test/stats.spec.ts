import { describe, expect, it } from 'vitest';
import {
  chiSquareSf,
  normalCdf,
  normalQuantile,
  normalSf,
  proportionTest,
  srmTest,
  studentTQuantile,
  studentTTwoSided,
  summarize,
  welchTest,
} from '../src/stats.js';

/**
 * The distribution checks use closed forms that hold exactly, so they need no external
 * reference values: chi-square with 2 df is exponential, t with 1 df is Cauchy, t with 2 df
 * has an algebraic CDF, and chi-square with 1 df is a squared standard normal.
 */
describe('distributions', () => {
  it('normal CDF and quantile', () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 12);
    expect(normalCdf(-1)).toBeCloseTo(1 - normalCdf(1), 14);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 9);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 9);
    // Tail stays accurate where 1 − Φ would underflow to 0.
    expect(normalSf(10)).toBeGreaterThan(0);
    expect(normalSf(10)).toBeCloseTo(7.619853024160527e-24, 30);
  });

  it('chi-square survival', () => {
    for (const x of [0.1, 1, 3.5, 12]) {
      expect(chiSquareSf(x, 2)).toBeCloseTo(Math.exp(-x / 2), 12);
      expect(chiSquareSf(x, 1)).toBeCloseTo(2 * normalSf(Math.sqrt(x)), 12);
    }
    expect(chiSquareSf(0, 3)).toBe(1);
  });

  it('Student t two-sided p-values and quantiles', () => {
    for (const t of [0.3, 1, 2.5, 9]) {
      expect(studentTTwoSided(t, 1)).toBeCloseTo(1 - (2 / Math.PI) * Math.atan(t), 12);
      expect(studentTTwoSided(t, 2)).toBeCloseTo(1 - t / Math.sqrt(t * t + 2), 12);
    }
    expect(studentTTwoSided(1.96, 1e7)).toBeCloseTo(2 * normalSf(1.96), 6);
    expect(studentTQuantile(0.975, 1)).toBeCloseTo(Math.tan(Math.PI * 0.475), 7);
  });
});

describe('summarize', () => {
  it('derives mean and sample variance from sufficient stats', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    const s = summarize({
      n: xs.length,
      sum: xs.reduce((a, b) => a + b, 0),
      sumSquares: xs.reduce((a, b) => a + b * b, 0),
    });
    expect(s.mean).toBe(5);
    expect(s.variance).toBeCloseTo(32 / 7, 12);
  });
});

describe('proportionTest', () => {
  it('computes the pooled z-test', () => {
    const r = proportionTest({ n: 10_000, conversions: 1000 }, { n: 10_000, conversions: 1100 });
    expect(r.difference).toBeCloseTo(0.01, 12);
    expect(r.relativeLift).toBeCloseTo(0.1, 12);
    const pooledSe = Math.sqrt(0.105 * 0.895 * (2 / 10_000));
    expect(r.z).toBeCloseTo(0.01 / pooledSe, 10);
    expect(r.pValue).toBeCloseTo(2 * normalSf(0.01 / pooledSe), 12);
    expect(r.pValue).toBeGreaterThan(0.02);
    expect(r.pValue).toBeLessThan(0.022);
    expect(r.interval[0]).toBeLessThan(0.01);
    expect(r.interval[1]).toBeGreaterThan(0.01);
  });

  it('handles identical zero-conversion arms', () => {
    const r = proportionTest({ n: 100, conversions: 0 }, { n: 100, conversions: 0 });
    expect(r.pValue).toBe(1);
    expect(Number.isNaN(r.relativeLift)).toBe(true);
  });
});

describe('welchTest', () => {
  const stats = (xs: number[]) => ({
    n: xs.length,
    sum: xs.reduce((a, b) => a + b, 0),
    sumSquares: xs.reduce((a, b) => a + b * b, 0),
  });

  it('matches the textbook formulas', () => {
    const a = [19.8, 20.4, 19.6, 17.8, 18.5, 18.9, 18.3, 18.9, 19.5, 22.0];
    const b = [
      28.2, 26.6, 20.1, 23.3, 25.2, 22.1, 17.7, 27.6, 20.6, 13.7, 23.2, 17.5, 20.6, 18.0, 23.9,
      21.6, 24.3, 20.4, 23.9, 13.3,
    ];
    const r = welchTest(stats(a), stats(b));
    const sa = summarize(stats(a));
    const sb = summarize(stats(b));
    const va = sa.variance / sa.n;
    const vb = sb.variance / sb.n;
    expect(r.t).toBeCloseTo((sb.mean - sa.mean) / Math.sqrt(va + vb), 12);
    expect(r.df).toBeCloseTo((va + vb) ** 2 / (va ** 2 / (sa.n - 1) + vb ** 2 / (sb.n - 1)), 10);
    expect(r.pValue).toBeCloseTo(studentTTwoSided(r.t, r.df), 12);
    expect(r.pValue).toBeGreaterThan(0.01);
    expect(r.pValue).toBeLessThan(0.05);
  });

  it('needs two observations per arm', () => {
    expect(() => welchTest(stats([1]), stats([1, 2]))).toThrow(RangeError);
  });
});

describe('srmTest', () => {
  it('passes a healthy 50/50 split', () => {
    expect(srmTest([5012, 4988], [50, 50]).mismatch).toBe(false);
  });

  it('flags a broken split', () => {
    const r = srmTest([5400, 4600], [50, 50]);
    expect(r.chiSquare).toBeCloseTo(64, 10);
    expect(r.pValue).toBeCloseTo(chiSquareSf(64, 1), 15);
    expect(r.mismatch).toBe(true);
  });

  it('respects uneven weights', () => {
    expect(srmTest([1000, 9000], [10, 90]).mismatch).toBe(false);
  });
});
