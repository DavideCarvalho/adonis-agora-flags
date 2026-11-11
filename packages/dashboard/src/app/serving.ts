import type { JsonValue, Serving, StaleReason } from '../client/flags-client';

/** A JSON value as one short line (`true`, `"b"`, `{…}`). */
export function formatValue(value: JsonValue | null | undefined): string {
  if (value === undefined) return '—';
  if (typeof value === 'string') return JSON.stringify(value);
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/** What a flag serves to everyone no rule matches, in words. */
export function describeServing(serving: Serving): string {
  switch (serving.kind) {
    case 'default':
      return `code default ${formatValue(serving.value)}`;
    case 'off':
      return `off → ${serving.variant}`;
    case 'fixed':
      return serving.variant;
    case 'rollout':
      return `${serving.percent}% on`;
    case 'split':
      return (
        serving.arms.map((arm) => `${arm.variant} ${arm.percent}%`).join(' / ') +
        (serving.bucketBy ? ` by ${serving.bucketBy}` : '')
      );
  }
}

/** The status hue a serving summary takes (`s-<tone>` in `index.css`). */
export function servingTone(serving: Serving): 'on' | 'off' | 'default' | 'pending' {
  switch (serving.kind) {
    case 'default':
      return 'default';
    case 'off':
      return 'off';
    case 'fixed':
      return serving.variant === 'off' ? 'off' : 'on';
    case 'rollout':
      return serving.percent >= 100 ? 'on' : serving.percent <= 0 ? 'off' : 'pending';
    case 'split':
      return 'pending';
  }
}

export const STALE_LABELS: Record<StaleReason, string> = {
  unused: 'not evaluated lately',
  expired: 'past its expiry',
  static: 'serves one value to everyone',
  undeclared: 'not declared in code',
  missing: 'declared, not configured',
};

/** `0.0123` → `+1.23%`. */
export function formatPercent(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return '—';
  const value = (fraction * 100).toFixed(digits);
  return `${fraction > 0 ? '+' : ''}${value}%`;
}

/** A p-value as people read it: `<0.001` below a thousandth. */
export function formatP(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.001) return '<0.001';
  return p.toFixed(3);
}

/** A mean as it should look for its metric: a rate for conversions, a number otherwise. */
export function formatMean(kind: string, mean: number): string {
  if (!Number.isFinite(mean)) return '—';
  if (kind === 'conversion') return `${(mean * 100).toFixed(2)}%`;
  return Math.abs(mean) >= 100 ? mean.toFixed(0) : mean.toFixed(3);
}
