import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Call, clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { Activity } from './Activity';
import { renderScreen } from './render.test-helper';

const originalFetch = globalThis.fetch;
let calls: Call[];

function page(nextCursor: string | null) {
  return {
    data: [],
    meta: { nextCursor, prevCursor: null, hasNext: nextCursor !== null, hasPrev: false },
  };
}

beforeEach(() => {
  injectConfig({ api: '/f/api' });
  ({ calls } = stubFetch((_method, url) => {
    if (url.includes('c2')) return page(null);
    if (url.includes('c1')) return page('c2');
    return page('c1');
  }));
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

const lastUrl = () => decodeURIComponent(calls.at(-1)?.url ?? '');

describe('the audit log: view in the URL', () => {
  it('opens on the page and filter a shared link names', async () => {
    window.history.replaceState(null, '', '/#/activity?entity=flag&after=c1');
    renderScreen(<Activity />);
    await waitFor(() => expect(lastUrl()).toContain('c1'));
    expect(lastUrl()).toContain('flag');
    expect(screen.getByRole('tab', { name: 'Flags' }).getAttribute('aria-selected')).toBe('true');
  });

  it('pages push cursors, back returns, and a filter goes back to the newest page', async () => {
    window.history.replaceState(null, '', '/#/activity');
    renderScreen(<Activity />);
    const older = await screen.findByRole('button', { name: 'Older' });
    await waitFor(() => expect(older.hasAttribute('disabled')).toBe(false));
    fireEvent.click(older);
    await waitFor(() => expect(window.location.hash).toBe('#/activity?after=c1'));
    await waitFor(() => expect(lastUrl()).toContain('c1'));
    act(() => window.history.back());
    await waitFor(() => expect(window.location.hash).toBe('#/activity'));

    act(() => window.history.forward());
    await waitFor(() => expect(window.location.hash).toBe('#/activity?after=c1'));
    // Typing replaces the entry (even though it resets the pushed page cursor).
    const before = window.history.length;
    fireEvent.change(screen.getByLabelText('Filter by key'), { target: { value: 'checkout' } });
    await waitFor(() => expect(window.location.hash).toBe('#/activity?key=checkout'));
    expect(window.history.length).toBe(before);
  });
});
