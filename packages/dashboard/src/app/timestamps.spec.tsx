import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlagDetail, FlagRow } from '../client/flags-client';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { FlagEditor } from './FlagEditor';
import { FlagsList } from './FlagsList';
import { META, renderScreen } from './render.test-helper';
import { Segments } from './Segments';
import { formatDate, Stamps } from './shell';

const originalFetch = globalThis.fetch;
const CREATED = '2026-01-05T10:00:00.000Z';
const UPDATED = '2026-11-18T16:30:00.000Z';

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

const definition = {
  variants: { on: true, off: false },
  enabled: true,
  offVariant: 'off',
  fallthrough: { variant: 'off' },
};

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

describe('dates in the console', () => {
  it('formats a short date, and a dash when unknown', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('garbage')).toBe('—');
    expect(formatDate(UPDATED)).toBe(
      new Date(UPDATED).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      }),
    );
  });

  it('shows created and updated, with the full timestamp on hover', () => {
    render(<Stamps createdAt={CREATED} updatedAt={null} />);
    const created = screen.getByText(formatDate(CREATED));
    expect(created.getAttribute('title')).toBe(new Date(CREATED).toLocaleString());
    expect(screen.getByTestId('stamps').textContent).toContain('Updated —');
  });

  it('lists when each flag last changed', async () => {
    stubFetch(() => ({
      environment: 'production',
      version: '7',
      data: [
        row({ key: 'new_player', createdAt: CREATED, updatedAt: UPDATED }),
        row({ key: 'legacy', createdAt: null, updatedAt: null }),
      ],
    }));
    renderScreen(<FlagsList onOpen={() => {}} />);
    expect(await screen.findByText('new_player')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Updated' })).toBeTruthy();
    expect(screen.getByText(formatDate(UPDATED)).getAttribute('title')).toBe(
      new Date(UPDATED).toLocaleString(),
    );
    const legacy = screen.getByText('legacy').closest('tr')!;
    expect(legacy.textContent).toContain('—');
  });

  it('shows created and updated on the flag detail', async () => {
    const detail: FlagDetail = {
      environment: 'staging',
      version: '3',
      key: 'new_player',
      declaration: { type: 'boolean', default: false, apps: ['shop'] },
      stored: definition,
      definition,
      serving: { kind: 'fixed', variant: 'off' },
      audit: [],
      schedules: [],
      pendingRequests: [],
      requiresApproval: false,
      segments: [],
      layers: [],
      flags: {},
      createdAt: CREATED,
      updatedAt: UPDATED,
    };
    stubFetch((_method, url) =>
      url.includes('/preview') ? { valid: true, issues: [], serving: null } : detail,
    );
    renderScreen(<FlagEditor flagKey="new_player" onClose={() => {}} />, {
      environment: 'staging',
      meta: META,
    });
    expect(await screen.findByText(formatDate(CREATED))).toBeTruthy();
    expect(screen.getByText(formatDate(UPDATED))).toBeTruthy();
  });

  it('shows created and updated on each segment', async () => {
    stubFetch(() => ({
      environment: 'production',
      version: '2',
      data: [{ key: 'beta', segment: {}, usedBy: [], createdAt: CREATED, updatedAt: UPDATED }],
    }));
    renderScreen(<Segments />, { meta: META });
    expect(await screen.findByText('beta')).toBeTruthy();
    const stamps = screen.getByTestId('stamps');
    expect(stamps.textContent).toContain(formatDate(CREATED));
    expect(stamps.textContent).toContain(formatDate(UPDATED));
  });
});
