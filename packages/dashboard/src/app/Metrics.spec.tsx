import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { ExperimentEditor } from './editor-parts';
import { Metrics, metricOf } from './Metrics';
import { renderScreen } from './render.test-helper';

const originalFetch = globalThis.fetch;

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

const listing = {
  environment: 'production',
  version: '3',
  data: [
    {
      name: 'purchase',
      metric: { kind: 'conversion', event: 'purchase' },
      source: 'config',
      usedBy: ['checkout'],
    },
    {
      name: 'signup',
      metric: { kind: 'count', event: 'signup', windowMs: 7 * 86_400_000 },
      source: 'console',
      usedBy: [],
    },
  ],
};

describe('Metrics', () => {
  it('shows config metrics read-only and creates console ones', async () => {
    const { calls } = stubFetch((method) =>
      method === 'GET' ? listing : { status: 'applied', version: '4' },
    );
    renderScreen(<Metrics />);
    expect(await screen.findByText('purchase')).toBeTruthy();
    expect(screen.getByText('config')).toBeTruthy();
    expect(screen.getByTitle(/managed in code/)).toBeTruthy();
    expect(screen.getByText(/change it there/)).toBeTruthy();
    expect(screen.queryByText('overridden by code')).toBeNull();
    expect((screen.getByLabelText('signup window') as HTMLInputElement).value).toBe('7');

    fireEvent.click(screen.getByText('New metric'));
    fireEvent.change(screen.getByLabelText('New metric name'), { target: { value: 'refunds' } });
    fireEvent.change(screen.getByLabelText('new metric event'), { target: { value: 'refund' } });
    fireEvent.change(screen.getByLabelText('new metric direction'), {
      target: { value: 'decrease' },
    });
    fireEvent.click(screen.getAllByText('Save metric')[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe('/f/api/metrics/refunds');
    expect(put.body).toEqual({
      environment: 'production',
      metric: { kind: 'conversion', event: 'refund', direction: 'decrease' },
    });
  });

  it('shows a console metric the config overrides, and deletes it', async () => {
    const overridden = {
      ...listing,
      data: [
        {
          ...listing.data[0],
          overriddenConsole: { kind: 'count', event: 'buy' },
        },
      ],
    };
    const { calls } = stubFetch((method) =>
      method === 'GET' ? overridden : { status: 'applied', version: '4' },
    );
    renderScreen(<Metrics />);
    expect(await screen.findByText('overridden by code')).toBeTruthy();
    expect(screen.getByText('count of "buy" · higher is better')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete the console metric'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/f/api/metrics/purchase');
  });

  it('builds a metric from the form, leaving blanks out', () => {
    expect(
      metricOf({
        kind: 'sum',
        event: ' purchase ',
        description: '',
        direction: 'increase',
        windowDays: '14',
        cupedDays: '0',
      }),
    ).toEqual({ kind: 'sum', event: 'purchase', windowMs: 14 * 86_400_000 });
  });
});

describe('ExperimentEditor analysis', () => {
  const definition = {
    variants: { on: true, off: false },
    enabled: true,
    offVariant: 'off',
    fallthrough: { variant: 'off' },
    experiment: { metrics: ['purchase'] },
  };
  const metrics = [
    { name: 'purchase', source: 'config' as const },
    { name: 'refunds', source: 'console' as const },
  ];

  it('moves a metric between decides and guardrail, and sets control and confidence', () => {
    let latest: unknown = null;
    renderScreen(
      <ExperimentEditor
        definition={definition}
        layers={[]}
        metrics={metrics}
        onChange={(next) => {
          latest = next;
        }}
      />,
    );
    fireEvent.click(screen.getByLabelText('purchase guardrail'));
    expect((latest as typeof definition).experiment).toEqual({ guardrails: ['purchase'] });
    fireEvent.change(screen.getByLabelText('Control variant'), { target: { value: 'on' } });
    expect((latest as typeof definition).experiment).toEqual({
      metrics: ['purchase'],
      control: 'on',
    });
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: '90' } });
    expect((latest as typeof definition).experiment).toEqual({
      metrics: ['purchase'],
      confidence: 0.9,
    });
  });

  it('defers to an experiment defined in config', () => {
    renderScreen(
      <ExperimentEditor
        definition={definition}
        layers={[]}
        metrics={metrics}
        configExperiment="checkout"
        onChange={() => {}}
      />,
    );
    expect(screen.queryByLabelText('purchase decides')).toBeNull();
    expect(screen.getByText(/wins over the console/)).toBeTruthy();
    expect(screen.getByTitle(/managed in code/)).toBeTruthy();
  });

  it('says which picked metrics the config experiment overrides, and clears them', () => {
    let latest: unknown = null;
    renderScreen(
      <ExperimentEditor
        definition={{ ...definition, experiment: { metrics: ['purchase'], control: 'on' } }}
        layers={[]}
        metrics={metrics}
        configExperiment="checkout"
        onChange={(next) => {
          latest = next;
        }}
      />,
    );
    expect(screen.getByText('overridden by code')).toBeTruthy();
    expect(screen.getByText(/\(purchase\) are ignored/)).toBeTruthy();
    fireEvent.click(screen.getByText('Clear them'));
    expect((latest as typeof definition).experiment).toEqual({});
  });
});
