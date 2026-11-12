import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFlag } from './index.js';

type Listener = (event: { detail: { page: { props: Record<string, unknown> } } }) => void;
const listeners = new Set<Listener>();

const reloads: unknown[] = [];

vi.mock('@inertiajs/react', () => ({
  router: {
    reload: (options: unknown) => reloads.push(options),
    on: (_type: string, listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));

const { InertiaFlagsProvider } = await import('./inertia.js');

afterEach(cleanup);

function Banner() {
  return <p>{String(useFlag('banner' as never, 'off' as never))}</p>;
}

const respond = (props: Record<string, unknown>) =>
  act(() => {
    for (const listener of listeners) listener({ detail: { page: { props } } });
  });

describe('InertiaFlagsProvider', () => {
  it('follows the flags prop on every Inertia response, not just the first page', async () => {
    render(
      <InertiaFlagsProvider initialPage={{ props: { flags: { banner: 'snow' } } }}>
        <Banner />
      </InertiaFlagsProvider>,
    );
    expect(screen.getByText('snow')).toBeTruthy();
    // router.reload({ only: ['flags'] }) after the flag changed
    await respond({ flags: { banner: 'lights' } });
    expect(screen.getByText('lights')).toBeTruthy();
    // a partial reload without the prop keeps the current values
    await respond({ user: {} });
    expect(screen.getByText('lights')).toBeTruthy();
  });

  it('stops listening when unmounted', () => {
    const { unmount } = render(
      <InertiaFlagsProvider initialPage={{ props: {} }}>
        <Banner />
      </InertiaFlagsProvider>,
    );
    expect(listeners.size).toBe(1);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('reloads the flags prop when the ruleset changes, with realtime', async () => {
    let deliver: ((message: { version: string }) => void) | undefined;
    const channels: string[] = [];
    const transmit = {
      subscription: (channel: string) => {
        channels.push(channel);
        return {
          create: async () => {},
          onMessage: <T,>(handler: (message: T) => void) => {
            deliver = handler as never;
            return () => {
              deliver = undefined;
            };
          },
          delete: async () => {},
        };
      },
    };
    const { unmount } = render(
      <InertiaFlagsProvider initialPage={{ props: {} }} prop="ff" realtime={{ transmit }}>
        <Banner />
      </InertiaFlagsProvider>,
    );
    await vi.waitFor(() => expect(deliver).toBeDefined());
    expect(channels).toEqual(['flags/ruleset']);
    deliver!({ version: '7' });
    expect(reloads).toEqual([{ only: ['ff'] }]);
    unmount();
    expect(deliver).toBeUndefined();
  });
});
