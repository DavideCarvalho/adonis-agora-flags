import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlagRow } from '../client/flags-client';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { FlagsList, filterFlags } from './FlagsList';
import { pickCombo, renderScreen } from './render.test-helper';

const originalFetch = globalThis.fetch;

function row(overrides: Partial<FlagRow> & Pick<FlagRow, 'key'>): FlagRow {
  return {
    declaration: { type: 'boolean', default: false, apps: ['shop'] },
    inRuleset: true,
    enabled: true,
    serving: { kind: 'fixed', variant: 'on' },
    tags: [],
    owner: null,
    expiresAt: null,
    experiment: false,
    rules: 0,
    overrides: 0,
    stale: [],
    ...overrides,
  };
}

const FLAGS = [
  row({
    key: 'new_player',
    owner: 'video',
    tags: ['player'],
    serving: { kind: 'rollout', percent: 20 },
  }),
  row({
    key: 'checkout',
    experiment: true,
    serving: {
      kind: 'split',
      arms: [
        { variant: 'a', percent: 50 },
        { variant: 'b', percent: 50 },
      ],
    },
  }),
  row({
    key: 'old_banner',
    stale: ['unused', 'static'],
    inRuleset: false,
    enabled: null,
    serving: { kind: 'default', value: false },
  }),
];

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

describe('filterFlags', () => {
  it('searches, filters by tag/owner and narrows to stale or experiments', () => {
    const all = { search: '', tag: '', owner: '', show: 'all' as const };
    expect(filterFlags(FLAGS, { ...all, search: 'PLAY' }).map((f) => f.key)).toEqual([
      'new_player',
    ]);
    expect(filterFlags(FLAGS, { ...all, tag: 'player' }).map((f) => f.key)).toEqual(['new_player']);
    expect(filterFlags(FLAGS, { ...all, owner: 'video' }).map((f) => f.key)).toEqual([
      'new_player',
    ]);
    expect(filterFlags(FLAGS, { ...all, show: 'stale' }).map((f) => f.key)).toEqual(['old_banner']);
    expect(filterFlags(FLAGS, { ...all, show: 'experiments' }).map((f) => f.key)).toEqual([
      'checkout',
    ]);
  });
});

describe('the flag list', () => {
  it('shows what each flag serves', async () => {
    stubFetch(() => ({ environment: 'production', version: '7', data: FLAGS }));
    renderScreen(<FlagsList onOpen={() => {}} />);
    expect(await screen.findByText('20% on')).toBeTruthy();
    expect(screen.getByText('a 50% / b 50%')).toBeTruthy();
    expect(screen.getByText('code default false')).toBeTruthy();
    expect(screen.getByText(/ruleset v7/)).toBeTruthy();
  });

  it('flips the kill switch in one click, in the current environment', async () => {
    const { calls } = stubFetch((method) =>
      method === 'POST'
        ? { status: 'applied', version: '8' }
        : { environment: 'staging', version: '7', data: FLAGS },
    );
    renderScreen(<FlagsList onOpen={() => {}} />, { environment: 'staging' });
    fireEvent.click(await screen.findByRole('switch', { name: 'Kill switch for new_player' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/f/api/flags/new_player/enabled');
    expect(post.body).toEqual({ environment: 'staging', enabled: false });
    expect(await screen.findByText('Applied (version 8).')).toBeTruthy();
  });

  it('says so when the switch became a change request instead', async () => {
    stubFetch((method) =>
      method === 'POST'
        ? { status: 'pending', request: { id: 'cr1' } }
        : { environment: 'production', version: '1', data: FLAGS },
    );
    renderScreen(<FlagsList onOpen={() => {}} />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Kill switch for checkout' }));
    expect(await screen.findByText(/Filed for approval/)).toBeTruthy();
  });

  it('opens a flag', async () => {
    stubFetch(() => ({ environment: 'production', version: '1', data: FLAGS }));
    const onOpen = vi.fn();
    renderScreen(<FlagsList onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: 'checkout' }));
    expect(onOpen).toHaveBeenCalledWith('checkout');
  });
});

describe('the flag list: filters in the URL', () => {
  const keys = () =>
    screen
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => FLAGS.some((f) => f.key === t));

  it('opens filtered from a shared link', async () => {
    window.history.replaceState(null, '', '/flags#/flags?env=staging&show=stale');
    stubFetch(() => ({ environment: 'staging', version: '1', data: FLAGS }));
    renderScreen(<FlagsList onOpen={() => {}} />, { environment: 'staging' });
    await screen.findByText('code default false');
    expect(keys()).toEqual(['old_banner']);
  });

  it('typing replaces the history entry, keeping the route and the environment', async () => {
    window.history.replaceState(null, '', '/flags?app=shop#/flags?env=staging');
    stubFetch(() => ({ environment: 'staging', version: '1', data: FLAGS }));
    renderScreen(<FlagsList onOpen={() => {}} />, { environment: 'staging' });
    await screen.findByText('20% on');
    const start = window.history.length;
    fireEvent.change(screen.getByLabelText('Search flags'), { target: { value: 'play' } });
    await waitFor(() => expect(window.location.hash).toBe('#/flags?env=staging&q=play'));
    expect(window.location.search).toBe('?app=shop');
    expect(window.history.length).toBe(start);
    expect(keys()).toEqual(['new_player']);

    // Cleared back to the default: the param leaves the URL.
    fireEvent.change(screen.getByLabelText('Search flags'), { target: { value: '' } });
    await waitFor(() => expect(window.location.hash).toBe('#/flags?env=staging'));
  });

  it('picking a view pushes, and back undoes it', async () => {
    window.history.replaceState(null, '', '/flags#/flags');
    stubFetch(() => ({ environment: 'production', version: '1', data: FLAGS }));
    renderScreen(<FlagsList onOpen={() => {}} />);
    await screen.findByText('20% on');
    fireEvent.click(screen.getByRole('tab', { name: /Experiments/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/flags?show=experiments'));
    expect(keys()).toEqual(['checkout']);
    await pickCombo('Owner', 'vid', 'video');
    await waitFor(() => expect(window.location.hash).toBe('#/flags?show=experiments&owner=video'));

    act(() => window.history.back());
    await waitFor(() => expect(window.location.hash).toBe('#/flags?show=experiments'));
    act(() => window.history.back());
    await waitFor(() => expect(keys()).toEqual(['new_player', 'checkout', 'old_banner']));
  });
});
