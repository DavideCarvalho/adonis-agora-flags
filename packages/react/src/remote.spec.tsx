import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flag, FlagsProvider, remoteFlags, useFlag, useFlagsStatus, useTrack } from './index.js';

afterEach(cleanup);

/** A fake flags server: answers evaluate with an ETag, records events. */
function fakeServer(initial: { values: Record<string, unknown>; experiments?: string[] }) {
  let state = { version: '1', ...initial, experiments: initial.experiments ?? [] };
  const events: unknown[] = [];
  const tokens: string[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    tokens.push(headers.authorization ?? '');
    if (url.endsWith('/v1/client/events')) {
      events.push(...(JSON.parse(String(init.body)).events as unknown[]));
      return new Response('{}', { status: 202 });
    }
    const etag = `"${state.version}"`;
    if (headers['if-none-match'] === etag) return new Response(null, { status: 304 });
    return new Response(
      JSON.stringify({
        version: state.version,
        values: state.values,
        variants: {},
        experiments: state.experiments,
      }),
      { status: 200, headers: { etag } },
    );
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    events,
    tokens,
    change(values: Record<string, unknown>) {
      state = { ...state, values, version: String(Number(state.version) + 1) };
    },
  };
}

function Banner() {
  const banner = useFlag('banner' as never, 'off' as never) as string;
  const { ready } = useFlagsStatus();
  const track = useTrack();
  return (
    <button type="button" onClick={() => track('click', { value: 1 })}>
      {ready ? banner : 'loading'}
    </button>
  );
}

describe('remote source', () => {
  it('evaluates against the flags server, sends the token, and serves fallbacks until then', async () => {
    const server = fakeServer({ values: { banner: 'snow' } });
    const source = remoteFlags({
      url: 'https://flags.test/_flags',
      token: () => 'tok-1',
      fetch: server.fetch,
      stream: false,
    });
    render(
      <FlagsProvider source={source}>
        <Banner />
      </FlagsProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('snow'));
    expect(server.tokens[0]).toBe('Bearer tok-1');
  });

  it('picks up changes on refresh, using the ETag when nothing changed', async () => {
    const server = fakeServer({ values: { banner: 'snow' } });
    const source = remoteFlags({
      url: 'https://flags.test/_flags',
      token: 't',
      fetch: server.fetch,
      stream: false,
    });
    render(
      <FlagsProvider source={source}>
        <Banner />
      </FlagsProvider>,
    );
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('snow'));
    await act(() => source.refresh());
    expect(screen.getByRole('button').textContent).toBe('snow');
    server.change({ banner: 'lights' });
    await act(() => source.refresh());
    expect(screen.getByRole('button').textContent).toBe('lights');
  });

  it('records one exposure per experiment flag shown, and tracks conversions', async () => {
    const server = fakeServer({
      values: { banner: 'snow', checkout: 'one_page' },
      experiments: ['checkout'],
    });
    const source = remoteFlags({
      url: 'https://flags.test/_flags',
      token: 't',
      fetch: server.fetch,
      stream: false,
    });
    render(
      <FlagsProvider source={source}>
        <Banner />
        <Flag name={'checkout' as never} is="one_page">
          <span>one page</span>
        </Flag>
        <Flag name={'checkout' as never} is="one_page">
          <span>again</span>
        </Flag>
      </FlagsProvider>,
    );
    await waitFor(() => expect(screen.getByText('one page')).toBeTruthy());
    screen.getByRole('button').click();
    await act(() => source.flush());
    expect(server.events).toEqual([
      { type: 'exposure', flag: 'checkout' },
      { type: 'track', name: 'click', value: 1 },
    ]);
  });

  it('reconnects the stream with a fresh token after an error', async () => {
    const server = fakeServer({ values: {} });
    const instances: Array<{ url: string; onerror: (() => void) | null; closed: boolean }> = [];
    class FakeEventSource {
      onerror: (() => void) | null = null;
      closed = false;
      constructor(readonly url: string) {
        instances.push(this);
      }
      addEventListener() {}
      close() {
        this.closed = true;
      }
    }
    let n = 0;
    const source = remoteFlags({
      url: 'https://flags.test/_flags',
      token: () => `tok-${++n}`,
      fetch: server.fetch,
      EventSource: FakeEventSource as never,
    });
    vi.useFakeTimers();
    try {
      source.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(instances).toHaveLength(1);
      const firstToken = new URL(instances[0]!.url).searchParams.get('token');
      // The server closes the stream when the token expires.
      instances[0]!.onerror?.();
      expect(instances[0]!.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(instances).toHaveLength(2);
      const secondToken = new URL(instances[1]!.url).searchParams.get('token');
      expect(secondToken).not.toBe(firstToken);
    } finally {
      source.stop();
      vi.useRealTimers();
    }
  });
});

describe('token endpoint', () => {
  function endpointServer() {
    const flags = fakeServer({ values: { banner: 'snow' } });
    let issued = 0;
    let reject: string | undefined;
    let lastTokenHeaders: Record<string, string> = {};
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === 'https://app.test/_flags/token') {
        issued++;
        expect(init.credentials).toBe('include');
        lastTokenHeaders = init.headers as Record<string, string>;
        return new Response(
          JSON.stringify({
            token: `tok-${issued}`,
            expiresAt: Date.now() + 300_000,
            url: 'https://flags.test/_flags',
          }),
          { status: 200 },
        );
      }
      const auth = (init.headers as Record<string, string>).authorization;
      if (auth === `Bearer ${reject}`) return new Response('{}', { status: 401 });
      return (flags.fetch as unknown as (u: string, i: RequestInit) => Promise<Response>)(
        url,
        init,
      );
    }) as unknown as typeof globalThis.fetch;
    return {
      fetch,
      flags,
      get issued() {
        return issued;
      },
      get tokenHeaders() {
        return lastTokenHeaders;
      },
      reject(token: string) {
        reject = token;
      },
    };
  }

  it('fetches a token once, keeps it until it nears expiry, and goes where it says', async () => {
    const server = endpointServer();
    const source = remoteFlags({
      endpoint: 'https://app.test/_flags/token',
      credentials: 'include',
      fetch: server.fetch,
      stream: false,
    });
    await source.refresh();
    await source.refresh();
    expect(source.getSnapshot().values).toEqual({ banner: 'snow' });
    expect(server.issued).toBe(1);
    expect(server.flags.tokens).toEqual(['Bearer tok-1', 'Bearer tok-1']);
  });

  it('fetches a new token once when the flags API rejects the cached one', async () => {
    const server = endpointServer();
    const source = remoteFlags({
      endpoint: 'https://app.test/_flags/token',
      credentials: 'include',
      fetch: server.fetch,
      stream: false,
    });
    await source.refresh();
    server.reject('tok-1');
    server.flags.change({ banner: 'lights' });
    await source.refresh();
    expect(server.issued).toBe(2);
    expect(source.getSnapshot().values).toEqual({ banner: 'lights' });
  });

  it('starts from a token already in the page, and reload() asks for a new one', async () => {
    const server = endpointServer();
    const source = remoteFlags({
      endpoint: 'https://app.test/_flags/token',
      credentials: 'include',
      initial: { token: 'page', expiresAt: Date.now() + 300_000, url: 'https://flags.test/_flags' },
      fetch: server.fetch,
      stream: false,
    });
    await source.refresh();
    expect(server.issued).toBe(0);
    expect(server.flags.tokens).toEqual(['Bearer page']);
    await source.reload();
    expect(server.issued).toBe(1);
  });

  it('sends extra headers to the token endpoint (access-token auth)', async () => {
    const server = endpointServer();
    const source = remoteFlags({
      endpoint: 'https://app.test/_flags/token',
      credentials: 'include',
      headers: async () => ({ authorization: 'Bearer oat_123' }),
      fetch: server.fetch,
      stream: false,
    });
    await source.refresh();
    expect(server.tokenHeaders.authorization).toBe('Bearer oat_123');
  });
});
