import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Call, clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { App } from './App';
import { META } from './render.test-helper';

const originalFetch = globalThis.fetch;
let calls: Call[];
let opsOverride: Record<string, unknown> = {};

function stubApi() {
  ({ calls } = stubFetch((_method, url) => {
    if (url.includes('/meta')) return META;
    if (url.includes('/flags')) return { environment: 'production', version: '1', data: [] };
    if (url.includes('/segments')) return { data: [] };
    if (url.includes('/change-requests'))
      return {
        requiresApproval: true,
        actor: { id: 'alice' },
        data: [],
        meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
      };
    if (url.includes('/ops')) {
      return {
        app: 'shop',
        environment: 'production',
        topology: 'standalone',
        role: 'all',
        source: { version: '1', loadedAt: null, lastError: null, stale: false, mode: 'poll' },
        buffer: { pending: 0, published: 0, dropped: 0 },
        transport: { name: 'db', transactional: true, durable: true },
        sinks: [{ sink: 'warehouse', lag: 3, delivered: 10, leasedBy: null, lastError: 'timeout' }],
        sinkError: null,
        relay: true,
        worker: true,
        analytics: true,
        tenants: [],
        ...opsOverride,
      };
    }
    return {};
  }));
}

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

function setHash(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

beforeEach(() => {
  injectConfig({ api: '/f/api', environment: 'production' });
  stubApi();
});

afterEach(() => {
  opsOverride = {};
  globalThis.fetch = originalFetch;
  clearConfig();
  window.location.hash = '';
});

describe('the shell', () => {
  it('opens on the flag list', () => {
    renderApp();
    expect(screen.getByRole('link', { name: 'Flags' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1, name: 'Flags' })).toBeTruthy();
  });

  it('groups the sidebar into the four sections, each screen a real link', () => {
    renderApp();
    for (const section of ['Flags', 'Experiments', 'Governance', 'Config']) {
      expect(screen.getAllByText(section).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole('link', { name: 'Hygiene' }).getAttribute('href')).toBe('#/hygiene');
  });

  it('writes the hash when a nav item is pressed and follows it back', async () => {
    renderApp();
    fireEvent.click(screen.getByRole('link', { name: 'Approvals' }));
    expect(window.location.hash).toBe('#/approvals');
    setHash('#/segments');
    expect(await screen.findByRole('heading', { level: 1, name: 'Segments' })).toBeTruthy();
  });

  it('switches environment through the hash, and every read follows it', async () => {
    renderApp();
    const select = (await screen.findByRole('combobox', {
      name: 'Environment',
    })) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    fireEvent.change(select, { target: { value: 'staging' } });
    expect(window.location.hash).toBe('#/flags?env=staging');
    // The nav keeps the environment in every link.
    setHash('#/flags?env=staging');
    expect(screen.getByRole('link', { name: 'Segments' }).getAttribute('href')).toBe(
      '#/segments?env=staging',
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url === '/f/api/flags?environment=staging')).toBe(true),
    );
  });

  it('shows the viewer the provider sent, else the acting person the API reports', async () => {
    renderApp();
    expect(await screen.findByText('alice')).toBeTruthy();
  });

  it('prefers the data block viewer and offers ⌘K search when the provider announces it', async () => {
    injectConfig({
      viewer: { label: 'Ann Lee', role: 'admin' },
      search: { endpoint: '/f/api/consoles/search' },
    });
    renderApp();
    expect(await screen.findByText('Ann Lee')).toBeTruthy();
    expect(screen.queryByText('alice')).toBeNull();
    expect(screen.getByRole('button', { name: /search/i })).toBeTruthy();
  });

  it('flags an environment that needs approvals', async () => {
    renderApp();
    expect(await screen.findByText('approvals on')).toBeTruthy();
    setHash('#/flags?env=staging');
    await waitFor(() => expect(screen.queryByText('approvals on')).toBeNull());
  });

  it('shows sink lag and errors on the ops screen', async () => {
    window.location.hash = '#/ops';
    renderApp();
    expect(await screen.findByText('timeout')).toBeTruthy();
    expect(screen.getByText('warehouse')).toBeTruthy();
  });

  it('shows a transport that delivers through its own jobs instead of "no relay"', async () => {
    opsOverride = {
      transport: { name: 'queue', transactional: false, durable: true },
      sinks: [{ sink: 'warehouse' }],
      relay: false,
      delivery: 'transport',
    };
    window.location.hash = '#/ops';
    renderApp();
    expect(await screen.findByText('delivered by queue jobs')).toBeTruthy();
    expect(screen.queryByText('no relay')).toBeNull();
  });
});
