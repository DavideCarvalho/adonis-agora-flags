import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExperimentResults } from '../client/flags-client';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { ExperimentDetail } from './Experiments';
import { renderScreen } from './render.test-helper';

const originalFetch = globalThis.fetch;

function results(overrides: Partial<ExperimentResults> = {}): ExperimentResults {
  return {
    experiment: 'checkout',
    flag: 'checkout',
    control: 'control',
    computedAt: '2026-11-11T12:00:00.000Z',
    exposures: { control: 500, one_page: 420 },
    srm: { pValue: 0.002, mismatch: false, expected: { control: 50, one_page: 50 } },
    metrics: [
      {
        name: 'purchase',
        kind: 'conversion',
        event: 'purchase',
        direction: 'increase',
        guardrail: false,
        variants: [
          { variant: 'control', n: 500, mean: 0.1 },
          { variant: 'one_page', n: 420, mean: 0.15 },
        ],
        comparisons: [
          {
            variant: 'one_page',
            test: 'proportion',
            difference: 0.05,
            relativeLift: 0.5,
            pValue: 0.0004,
            interval: [0.01, 0.09],
            significant: true,
            sequential: { pValue: 0.02, interval: [0.001, 0.1], significant: true },
            verdict: 'better',
          },
        ],
        alert: false,
      },
      {
        name: 'latency',
        kind: 'mean',
        event: 'page',
        direction: 'decrease',
        guardrail: true,
        variants: [
          { variant: 'control', n: 500, mean: 200 },
          { variant: 'one_page', n: 420, mean: 260 },
        ],
        comparisons: [
          {
            variant: 'one_page',
            test: 'welch',
            difference: 60,
            relativeLift: 0.3,
            pValue: 0.01,
            interval: [20, 100],
            significant: true,
            sequential: { pValue: 0.03, interval: [5, 120], significant: true },
            verdict: 'worse',
          },
        ],
        alert: true,
      },
    ],
    warnings: ['revenue: not enough subjects to compare "x" with "control" yet'],
    ...overrides,
  };
}

function detail(r: ExperimentResults | null) {
  return {
    key: 'checkout',
    flag: 'checkout',
    config: { metrics: ['purchase'], guardrails: ['latency'] },
    analytics: true,
    results: r,
  };
}

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

describe('experiment results', () => {
  it('shows control vs variant per metric with lift, p-values and verdicts', async () => {
    stubFetch(() => detail(results()));
    renderScreen(<ExperimentDetail experimentKey="checkout" onClose={() => {}} />);
    expect(await screen.findByRole('heading', { name: 'purchase' })).toBeTruthy();
    expect(screen.getByText('+50.00%')).toBeTruthy();
    expect(screen.getByText('<0.001')).toBeTruthy();
    expect(screen.getByText('0.020')).toBeTruthy();
    expect(screen.getByText('better')).toBeTruthy();
    expect(screen.getByText('15.00%')).toBeTruthy();
    expect(screen.getByText(/not enough subjects/)).toBeTruthy();
  });

  it('raises a guardrail that regressed', async () => {
    stubFetch(() => detail(results()));
    renderScreen(<ExperimentDetail experimentKey="checkout" onClose={() => {}} />);
    expect(await screen.findByText('guardrail regressed')).toBeTruthy();
    expect(screen.getByText('worse')).toBeTruthy();
  });

  it('warns about a sample ratio mismatch above everything else', async () => {
    stubFetch(() =>
      detail(
        results({
          srm: { pValue: 0.00001, mismatch: true, expected: { control: 50, one_page: 50 } },
        }),
      ),
    );
    renderScreen(<ExperimentDetail experimentKey="checkout" onClose={() => {}} />);
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((a) => /Sample ratio mismatch/.test(a.textContent ?? ''))).toBe(true);
  });

  it('does not warn when the split is as configured', async () => {
    stubFetch(() => detail(results()));
    renderScreen(<ExperimentDetail experimentKey="checkout" onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'purchase' });
    expect(screen.queryByText(/Sample ratio mismatch/)).toBeNull();
  });

  it('recomputes on demand and shows the new numbers', async () => {
    const { calls } = stubFetch((method) =>
      method === 'POST'
        ? { key: 'checkout', results: results({ exposures: { control: 1, one_page: 999 } }) }
        : detail(null),
    );
    renderScreen(<ExperimentDetail experimentKey="checkout" onClose={() => {}} />);
    expect(await screen.findByText(/Not computed yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Recompute now' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url === '/f/api/experiments/checkout/recompute'),
      ).toBe(true),
    );
    expect(await screen.findByText('999')).toBeTruthy();
  });
});
