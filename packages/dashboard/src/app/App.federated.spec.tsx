import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConsoleCache } from '../agora-kit/console-data';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { App } from './App';
import { META } from './render.test-helper';

const originalFetch = globalThis.fetch;

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

let reachable = true;
const urls: string[] = [];

beforeEach(() => {
  reachable = true;
  urls.length = 0;
  resetConsoleCache();
  injectConfig({ api: '/f/api', environment: 'production' });
  stubFetch((_method, url) => {
    urls.push(url);
    if (url.includes('/consoles')) return { version: 1, current: 'flags', consoles: [] };
    if (url.includes('/apps'))
      return {
        local: { id: 'hub', label: 'Hub' },
        topology: 'standalone',
        appScope: '*',
        apps: [{ id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
        selected: url.includes('app=et') ? 'et' : null,
      };
    if (url.includes('/meta')) {
      return url.includes('app=et')
        ? {
            ...META,
            app: 'entre-textos',
            federated: {
              id: 'et',
              label: 'Entre Textos',
              mode: 'federated',
              actions: 'app',
              reachable,
            },
          }
        : META;
    }
    if (url.includes('/flags')) return { environment: 'production', version: '1', data: [] };
    return {
      data: [],
      meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
    };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
  clearConfig();
  window.history.replaceState(null, '', '/');
});

describe('a federated app picked in the console', () => {
  it('shows the federated notice and sends ?app= with every call', async () => {
    window.history.replaceState(null, '', '/?app=et#/flags');
    renderApp();
    const notice = await screen.findByRole('note');
    expect(notice.textContent).toMatch(/Federated: .*Entre Textos's own store/);
    expect(notice.textContent).toMatch(/Actions are sent to Entre Textos/);
    await waitFor(() =>
      expect(urls.some((u) => u.includes('/flags?') && u.includes('app=et'))).toBe(true),
    );
    expect(screen.getByRole('button', { name: 'App: Entre Textos' })).toBeTruthy();
    expect(document.querySelector('[data-federated-unreachable]')).toBeNull();
  });

  it('says so when the app does not answer', async () => {
    reachable = false;
    window.history.replaceState(null, '', '/?app=et#/flags');
    renderApp();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Entre Textos is not answering/);
  });

  it('shows no notice for this app', async () => {
    window.history.replaceState(null, '', '/#/flags');
    renderApp();
    await screen.findByRole('button', { name: 'App: Hub' });
    expect(document.querySelector('[data-federated-notice]')).toBeNull();
  });
});
