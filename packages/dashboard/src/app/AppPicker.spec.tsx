// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AppsResponse, api, type Meta, withApp } from '../client/flags-client';
import { AppPicker, appPickerMode } from './AppPicker';
import { META } from './render.test-helper';

const central = (extra: Partial<Meta> = {}): Meta => ({
  ...META,
  topology: 'control-plane',
  apps: ['blog', 'shop'],
  appScope: '*',
  ...extra,
});

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/flags');
  vi.unstubAllGlobals();
});

describe('AppPicker', () => {
  it('is hidden on a standalone app and with a single app', () => {
    expect(appPickerMode({ ...META, apps: ['shop'], appScope: '*' })).toBe('off');
    expect(appPickerMode(central({ apps: ['shop'] }))).toBe('off');
    expect(appPickerMode(central({ apps: [] }))).toBe('off');
    expect(appPickerMode(undefined)).toBe('off');
    const { container } = render(<AppPicker meta={{ ...META, apps: ['shop'] }} />, { wrapper });
    expect(container.textContent).toBe('');
  });

  it('shows a fixed chip for someone limited to one app', () => {
    render(<AppPicker meta={central({ apps: ['shop'], appScope: ['shop'] })} />, { wrapper });
    expect(document.querySelector('[data-app-chip]')?.textContent).toBe('Appshop');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lists "All apps" first, filters, and records a pick in the URL', async () => {
    window.history.replaceState(null, '', '/flags#/experiments');
    render(<AppPicker meta={central()} />, { wrapper });
    const trigger = screen.getByRole('button', { name: 'App: All apps' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['All apps', 'blog', 'shop']);

    fireEvent.change(screen.getByRole('combobox', { name: 'Search apps' }), {
      target: { value: 'sh' },
    });
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['shop']);

    fireEvent.mouseDown(screen.getByRole('option', { name: 'shop' }));
    await waitFor(() => expect(window.location.search).toBe('?app=shop'));
    expect(window.location.hash).toBe('#/experiments');
    expect(screen.getByRole('button', { name: 'App: shop' })).toBeTruthy();
  });

  it('goes back to every app with "All apps"', async () => {
    window.history.replaceState(null, '', '/flags?app=blog');
    render(<AppPicker meta={central()} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: /^App/ }));
    fireEvent.mouseDown(await screen.findByRole('option', { name: 'All apps' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });
});

const directory = (extra: Partial<AppsResponse> = {}): AppsResponse => ({
  local: { id: 'hub', label: 'Hub' },
  topology: 'standalone',
  appScope: '*',
  apps: [{ id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
  selected: null,
  ...extra,
});

describe('AppPicker with federated apps', () => {
  it('offers this app first, then the federated apps tagged "federated"', async () => {
    expect(appPickerMode(META, directory())).toBe('pick');
    expect(appPickerMode(META, directory({ apps: [] }))).toBe('off');
    render(<AppPicker meta={META} directory={directory()} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'App: Hub' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Hub', 'Entre Textosfederated']);
    fireEvent.mouseDown(screen.getByRole('option', { name: /Entre Textos/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=et'));
    expect(screen.getByRole('button', { name: 'App: Entre Textos' })).toBeTruthy();
    expect(document.querySelector('[data-app-mode="federated"]')).toBeTruthy();
  });

  it('lists tenants and federated apps together on a central server', async () => {
    const both = directory({
      topology: 'control-plane',
      apps: [
        { id: 'blog', label: 'blog', mode: 'control-plane', actions: 'here' },
        { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'none' },
      ],
    });
    render(<AppPicker meta={central()} directory={both} />, { wrapper });
    fireEvent.click(screen.getByRole('button', { name: 'App: All apps' }));
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'All apps',
      'blog',
      'Entre Textosfederated',
    ]);
  });
});

describe('the picked app on every request', () => {
  it('appends ?app= when one is picked, and nothing otherwise', () => {
    expect(withApp('/experiments?environment=production')).toBe(
      '/experiments?environment=production',
    );
    window.history.replaceState(null, '', '/flags?app=shop');
    expect(withApp('/experiments?environment=production')).toBe(
      '/experiments?environment=production&app=shop',
    );
    expect(withApp('/ops')).toBe('/ops?app=shop');
  });

  it('sends it from the API client', async () => {
    window.history.replaceState(null, '', '/flags?app=blog');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    await api.experiments('production');
    await api.ops();
    await api.stale('production', 30, 30);
    const urls = fetch.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.every((url) => url.endsWith('app=blog'))).toBe(true);
  });
});
