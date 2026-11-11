/**
 * Experiment statistics over sufficient statistics. Whatever backend stores the events
 * (Postgres rollups, DuckDB over Parquet, ClickHouse) only has to return per-variant `n`, `Σx`
 * and `Σx²`; the inference lives here, once, so every backend reports the same numbers.
 *
 * Dependency-free: the distribution functions are the classic Lanczos log-gamma and continued
 * fraction forms of the regularized incomplete gamma and beta functions.
 */

/** Per-variant sufficient statistics for a numeric metric. */
export interface SufficientStats {
  n: number;
  sum: number;
  sumSquares: number;
}

/** Per-variant counts for a conversion (binary) metric. */
export interface ConversionCounts {
  n: number;
  conversions: number;
}

export interface Summary {
  n: number;
  mean: number;
  /** Sample variance (n − 1 denominator). `0` when n < 2. */
  variance: number;
}

/** Mean and sample variance from sufficient statistics. */
export function summarize(stats: SufficientStats): Summary {
  const { n, sum, sumSquares } = stats;
  if (n <= 0) return { n: 0, mean: 0, variance: 0 };
  const mean = sum / n;
  const variance = n < 2 ? 0 : Math.max(0, (sumSquares - n * mean * mean) / (n - 1));
  return { n, mean, variance };
}

export interface ProportionTestResult {
  controlRate: number;
  treatmentRate: number;
  /** treatmentRate − controlRate. */
  difference: number;
  /** difference / controlRate. `NaN` when the control rate is 0. */
  relativeLift: number;
  /** Pooled two-proportion z statistic. */
  z: number;
  /** Two-sided p-value. */
  pValue: number;
  /** Confidence interval of `difference` (unpooled standard error). */
  interval: [number, number];
}

/** Two-proportion z-test (two-sided) for conversion metrics. */
export function proportionTest(
  control: ConversionCounts,
  treatment: ConversionCounts,
  confidence = 0.95,
): ProportionTestResult {
  assertPositive(control.n, 'control.n');
  assertPositive(treatment.n, 'treatment.n');
  const p1 = control.conversions / control.n;
  const p2 = treatment.conversions / treatment.n;
  const difference = p2 - p1;
  const pooled = (control.conversions + treatment.conversions) / (control.n + treatment.n);
  const pooledSe = Math.sqrt(pooled * (1 - pooled) * (1 / control.n + 1 / treatment.n));
  const z = pooledSe === 0 ? 0 : difference / pooledSe;
  const se = Math.sqrt((p1 * (1 - p1)) / control.n + (p2 * (1 - p2)) / treatment.n);
  const zCrit = normalQuantile(1 - (1 - confidence) / 2);
  return {
    controlRate: p1,
    treatmentRate: p2,
    difference,
    relativeLift: p1 === 0 ? Number.NaN : difference / p1,
    z,
    pValue: pooledSe === 0 ? 1 : 2 * normalSf(Math.abs(z)),
    interval: [difference - zCrit * se, difference + zCrit * se],
  };
}

export interface WelchTestResult {
  controlMean: number;
  treatmentMean: number;
  /** treatmentMean − controlMean. */
  difference: number;
  relativeLift: number;
  t: number;
  /** Welch–Satterthwaite degrees of freedom. */
  df: number;
  /** Two-sided p-value. */
  pValue: number;
  interval: [number, number];
}

/** Welch's unequal-variance t-test (two-sided) for numeric metrics. */
export function welchTest(
  control: SufficientStats,
  treatment: SufficientStats,
  confidence = 0.95,
): WelchTestResult {
  const a = summarize(control);
  const b = summarize(treatment);
  if (a.n < 2 || b.n < 2)
    throw new RangeError('welchTest needs at least 2 observations per variant');
  const va = a.variance / a.n;
  const vb = b.variance / b.n;
  const se = Math.sqrt(va + vb);
  const difference = b.mean - a.mean;
  const relativeLift = a.mean === 0 ? Number.NaN : difference / a.mean;
  if (se === 0) {
    return {
      controlMean: a.mean,
      treatmentMean: b.mean,
      difference,
      relativeLift,
      t: 0,
      df: a.n + b.n - 2,
      pValue: difference === 0 ? 1 : 0,
      interval: [difference, difference],
    };
  }
  const t = difference / se;
  const df = (va + vb) ** 2 / (va ** 2 / (a.n - 1) + vb ** 2 / (b.n - 1));
  const tCrit = studentTQuantile(1 - (1 - confidence) / 2, df);
  return {
    controlMean: a.mean,
    treatmentMean: b.mean,
    difference,
    relativeLift,
    t,
    df,
    pValue: studentTTwoSided(t, df),
    interval: [difference - tCrit * se, difference + tCrit * se],
  };
}

export interface SrmResult {
  chiSquare: number;
  df: number;
  pValue: number;
  /** `true` when p < threshold: the observed split does not match the configured weights. */
  mismatch: boolean;
}

/**
 * Sample-ratio-mismatch check: compares the exposures each variant got with the configured
 * weights (chi-square goodness of fit). A mismatch almost always means broken instrumentation,
 * not a real effect, so results should not be trusted while it holds. The conventional
 * threshold is strict (0.001) because this runs continuously.
 */
export function srmTest(observed: number[], weights: number[], threshold = 0.001): SrmResult {
  if (observed.length !== weights.length || observed.length < 2) {
    throw new RangeError('srmTest needs one weight per variant and at least 2 variants');
  }
  const total = observed.reduce((s, x) => s + x, 0);
  const weightSum = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || weightSum <= 0)
    return { chiSquare: 0, df: observed.length - 1, pValue: 1, mismatch: false };
  let chiSquare = 0;
  for (let i = 0; i < observed.length; i++) {
    const expected = (total * weights[i]!) / weightSum;
    if (expected > 0) chiSquare += (observed[i]! - expected) ** 2 / expected;
  }
  const df = observed.length - 1;
  const pValue = chiSquareSf(chiSquare, df);
  return { chiSquare, df, pValue, mismatch: pValue < threshold };
}

// ── Distributions ────────────────────────────────────────────────────────────

/** Standard normal CDF. */
export function normalCdf(z: number): number {
  if (z === 0) return 0.5;
  const half = 0.5 * regularizedGammaP(0.5, (z * z) / 2);
  return z > 0 ? 0.5 + half : 0.5 - half;
}

/** Standard normal survival function, 1 − Φ(z), accurate in the tail. */
export function normalSf(z: number): number {
  if (z < 0) return 1 - normalSf(-z);
  return 0.5 * regularizedGammaQ(0.5, (z * z) / 2);
}

/** Inverse standard normal CDF. */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('normalQuantile needs 0 < p < 1');
  return bisect((z) => normalCdf(z) - p, -40, 40);
}

/** Two-sided p-value of a Student t statistic. */
export function studentTTwoSided(t: number, df: number): number {
  if (!Number.isFinite(t)) return 0;
  return regularizedBeta(df / (df + t * t), df / 2, 0.5);
}

/** Student t CDF. */
export function studentTCdf(t: number, df: number): number {
  const tail = studentTTwoSided(t, df) / 2;
  return t >= 0 ? 1 - tail : tail;
}

/** Inverse Student t CDF. */
export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('studentTQuantile needs 0 < p < 1');
  let bound = 50;
  while (studentTCdf(bound, df) < p && bound < 1e12) bound *= 10;
  return bisect((t) => studentTCdf(t, df) - p, -bound, bound);
}

/** Chi-square survival function, P(X > x). */
export function chiSquareSf(x: number, df: number): number {
  if (x <= 0) return 1;
  return regularizedGammaQ(df / 2, x / 2);
}

// ── Special functions ────────────────────────────────────────────────────────

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const y = x - 1;
  let a = 0.99999999999980993;
  const t = y + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i]! / (y + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

const EPS = 1e-15;
const MAX_ITER = 10_000;

/** Regularized lower incomplete gamma P(a, x). */
export function regularizedGammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x). */
export function regularizedGammaQ(a: number, x: number): number {
  if (x <= 0) return 1;
  return x < a + 1 ? 1 - gammaSeries(a, x) : gammaContinuedFraction(a, x);
}

function gammaSeries(a: number, x: number): number {
  let term = 1 / a;
  let sum = term;
  for (let n = 1; n < MAX_ITER; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < Math.abs(sum) * EPS) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

function gammaContinuedFraction(a: number, x: number): number {
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(x, a, b)) / a
    : 1 - (front * betaContinuedFraction(1 - x, b, a)) / b;
}

function betaContinuedFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < EPS) break;
  }
  return h;
}

function bisect(f: (x: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 200; i++) {
    const mid = (a + b) / 2;
    if (f(mid) < 0) a = mid;
    else b = mid;
    if (b - a < 1e-12 * Math.max(1, Math.abs(mid))) break;
  }
  return (a + b) / 2;
}

function assertPositive(value: number, name: string) {
  if (!(value > 0)) throw new RangeError(`${name} must be > 0`);
}
