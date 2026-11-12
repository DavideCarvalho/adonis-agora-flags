import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFlag } from './index.js';

type Listener = (event: { detail: { page: { props: Record<string, unknown> } } }) => void;
const listeners = new Set<Listener>();

vi.mock('@inertiajs/react', () => ({
  router: {
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
});
