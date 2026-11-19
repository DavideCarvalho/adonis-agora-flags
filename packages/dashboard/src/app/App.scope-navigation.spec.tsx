import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  injectConfig({ api: '/f/api', environment: 'production' });
  stubFetch((_method, url) => {
    if (url.includes('/meta'))
      return { ...META, topology: 'control-plane', apps: ['blog', 'shop'], appScope: '*' };
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

const sidebar = () => within(screen.getByRole('navigation', { name: 'Console' }));

describe('the picked app (`?app=`) survives in-console navigation', () => {
  it('through the sidebar', async () => {
    window.history.replaceState(null, '', '/?app=shop#/flags');
    renderApp();
    const trigger = await screen.findByRole('button', { name: /^App/ });
    expect(trigger.textContent).toContain('shop');
    for (const [label, hash] of [
      ['Experiments', '#/experiments'],
      ['Segments', '#/segments'],
      ['Flags', '#/flags'],
    ] as const) {
      fireEvent.click(sidebar().getByRole('link', { name: label }));
      await waitFor(() => expect(window.location.hash).toBe(hash));
      expect(window.location.search).toBe('?app=shop');
    }
    expect(screen.getByRole('button', { name: /^App/ }).textContent).toContain('shop');
  });

  it('through the ⌘K page commands', async () => {
    // jsdom has no scrollIntoView, which cmdk calls on the active item.
    Element.prototype.scrollIntoView ??= () => undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, '', '/?app=shop#/flags');
    renderApp();
    await screen.findByRole('button', { name: /^App/ });
    act(() => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    fireEvent.click(await screen.findByRole('option', { name: /^Experiments/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/experiments'));
    expect(window.location.search).toBe('?app=shop');
  });

  it('through detail routes and the filters (nuqs writes into the hash)', async () => {
    window.history.replaceState(null, '', '/?app=shop#/flags');
    renderApp();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Search flags' }), {
      target: { value: 'checkout' },
    });
    await waitFor(() => expect(window.location.hash).toContain('q=checkout'));
    expect(window.location.search).toBe('?app=shop');
    act(() => {
      window.location.hash = '#/flags/new-checkout';
    });
    await waitFor(() => expect(window.location.hash).toBe('#/flags/new-checkout'));
    expect(window.location.search).toBe('?app=shop');
  });
});
