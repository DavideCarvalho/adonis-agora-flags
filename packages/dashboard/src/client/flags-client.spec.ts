import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, api, apiBase, buildQuery, defaultEnvironment, uiBase } from './flags-client';
import { clearConfig, injectConfig, status, stubFetch } from './test-config.test-helper';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
  // biome-ignore lint/suspicious/noDocumentCookie: the client reads document.cookie; the spec sets it.
  document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
});

describe('deployment config', () => {
  it('reads the JSON data block the provider injects', () => {
    injectConfig({ base: '/ops/flags', api: '/ops/flags/api', environment: 'staging' });
    expect(uiBase()).toBe('/ops/flags');
    expect(apiBase()).toBe('/ops/flags/api');
    expect(defaultEnvironment()).toBe('staging');
  });

  it('honours a root mount (an empty base is a value, not a miss)', () => {
    injectConfig({ base: '' });
    expect(uiBase()).toBe('');
    expect(apiBase()).toBe('/api');
  });

  it('falls back to the default mount without the block', () => {
    expect(uiBase()).toBe('/flags');
    expect(apiBase()).toBe('/flags/api');
    expect(defaultEnvironment()).toBe('production');
  });
});

describe('requests', () => {
  it('sends the environment on reads and writes', async () => {
    injectConfig({ api: '/f/api' });
    const { calls } = stubFetch(() => ({ status: 'applied', version: '2' }));
    await api.flags('staging');
    await api.setEnabled('staging', 'checkout v2', false);
    expect(calls[0]).toMatchObject({ url: '/f/api/flags?environment=staging', method: 'GET' });
    expect(calls[1]).toMatchObject({
      url: '/f/api/flags/checkout%20v2/enabled',
      method: 'POST',
      body: { environment: 'staging', enabled: false },
    });
  });

  it('echoes the host CSRF cookie on writes, and sends no header without one', async () => {
    const { calls } = stubFetch(() => ({ status: 'applied', version: '1' }));
    await api.setRollout('production', 'a', 10);
    expect(calls[0]?.headers['x-xsrf-token']).toBeUndefined();
    // biome-ignore lint/suspicious/noDocumentCookie: the client reads document.cookie; the spec sets it.
    document.cookie = 'XSRF-TOKEN=tok%3D1';
    await api.setRollout('production', 'a', 20);
    expect(calls[1]?.headers['x-xsrf-token']).toBe('tok=1');
  });

  it('turns a 422 into an ApiError carrying the issues', async () => {
    stubFetch(() =>
      status(422, {
        error: 'invalid change',
        issues: [{ path: 'flags.a.offVariant', message: 'unknown variant "x"' }],
      }),
    );
    const error = await api
      .saveFlag('production', 'a', {
        variants: {},
        enabled: true,
        offVariant: 'x',
        fallthrough: { variant: 'x' },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect((error as ApiError).issues[0]?.path).toBe('flags.a.offVariant');
  });

  it('shows the server sentence for a 403', async () => {
    stubFetch(() =>
      status(403, { error: 'a change cannot be approved by the person who requested it' }),
    );
    await expect(api.approve('cr1')).rejects.toThrow(/person who requested it/);
  });

  it('builds query strings without empty values', () => {
    expect(buildQuery({ a: 'x', b: '', c: undefined, d: 2 })).toBe('?a=x&d=2');
    expect(buildQuery({})).toBe('');
  });
});
