import { channel } from 'node:diagnostics_channel';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks, validateConfig } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/index.js';
import { FLAGS_DIAGNOSTIC_EVENTS } from '../../src/enrichers.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { ControlPlaneAddress, fetchControlPlane } from '../../src/topology/url.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

interface Emitted {
  event: string;
  payload: unknown;
  app: string | undefined;
}

/** Stands in for `@adonis-agora/diagnostics` (1.0.0-rc.6+: `emit(lib, event, payload, { app })`). */
function installDiagnostics() {
  const calls: Emitted[] = [];
  (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
    lib: string,
    event: string,
    payload: unknown,
    options?: { app?: string },
  ) => {
    if (lib === 'flags') calls.push({ event, payload, app: options?.app });
  };
  // Subscribers on every channel, so each event reaches `emit` (not only the registering first).
  const noop = () => {};
  for (const event of FLAGS_DIAGNOSTIC_EVENTS) channel(`agora:flags:${event}`).subscribe(noop);
  return {
    calls,
    uninstall() {
      for (const event of FLAGS_DIAGNOSTIC_EVENTS)
        channel(`agora:flags:${event}`).unsubscribe(noop);
      delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    },
  };
}

const declarations = { new_player: flag.boolean({ default: false }) };

describe('control-plane attribution', () => {
  let db: TestDb;
  let cp: FlagsRuntime;
  let tenant: FlagsRuntime | undefined;
  let server: Server;
  let base: string;
  let diagnostics: ReturnType<typeof installDiagnostics>;

  beforeEach(async () => {
    diagnostics = installDiagnostics();
    db = await sqliteDb();
    cp = await createRuntime(
      defineConfig({
        topology: 'control-plane',
        flags: declarations,
        sinks: { warehouse: sinks.lucid() },
        verifyTenant: sharedSecretVerifier({ partitions: { shop: 's3cret' } }),
      }),
      lucidContext(db.database as never),
      { logger: quietLogger, runWorker: false },
    );
    const plane = new ControlPlane(cp, {
      verifyTenant: (cp.config as { verifyTenant: never }).verifyTenant,
    });
    const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
    plane.register({
      get: (pattern, handler) => {
        routes.push({ method: 'GET', pattern, handler: handler as Handler });
        return { as: () => {} };
      },
      post: (pattern, handler) => {
        routes.push({ method: 'POST', pattern, handler: handler as Handler });
        return { as: () => {} };
      },
    });
    server = await serve(routes);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_flags`;
  });

  afterEach(async () => {
    diagnostics.uninstall();
    await tenant?.close();
    tenant = undefined;
    await cp.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  const startTenant = (
    extra: { url?: unknown; diagnostics?: 'control-plane' | 'local' } = {},
  ): Promise<FlagsRuntime> =>
    createRuntime(
      defineConfig({
        topology: 'tenant',
        flags: declarations,
        tenant: {
          url: (extra.url ?? base) as string,
          token: 's3cret',
          partition: 'shop',
          stream: false,
          intervalMs: 60_000,
        },
        ...(extra.diagnostics ? { diagnostics: extra.diagnostics } : {}),
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );

  const of = (event: string) => diagnostics.calls.filter((call) => call.event === event);

  it('the control plane emits the tenant events it ingests, attributed to the tenant', async () => {
    tenant = await startTenant();
    await tenant.manager.for('u1').enabled('new_player');
    await tenant.manager.track('u1', 'purchase', { value: 10 });
    // Evaluations never leave the tenant: it emits them, stamped with its partition.
    expect(of('evaluation')).toEqual([
      {
        event: 'evaluation',
        payload: expect.objectContaining({ flag: 'new_player' }),
        app: 'shop',
      },
    ]);
    // The track is left to the control plane: nothing local yet.
    expect(of('track')).toEqual([]);

    await tenant.buffer!.flush();
    expect(of('track')).toEqual([
      {
        event: 'track',
        payload: expect.objectContaining({ name: 'purchase', app: 'shop', value: 10 }),
        app: 'shop',
      },
    ]);
  });

  it('diagnostics: "local" makes the tenant emit its events too', async () => {
    tenant = await startTenant({ diagnostics: 'local' });
    await tenant.manager.track('u1', 'purchase');
    expect(of('track')).toEqual([
      { event: 'track', payload: expect.objectContaining({ name: 'purchase' }), app: 'shop' },
    ]);
  });

  it('a standalone app emits without app, as before', async () => {
    const standalone = await createRuntime(
      defineConfig({ flags: declarations }),
      lucidContext(undefined),
      { logger: quietLogger, start: false },
    );
    try {
      await standalone.manager.track('u1', 'purchase');
      expect(of('track')).toEqual([
        { event: 'track', payload: expect.objectContaining({ name: 'purchase' }), app: undefined },
      ]);
    } finally {
      await standalone.close();
    }
  });

  it('resolves a lazy tenant.url before the first request', async () => {
    const url = vi.fn(async () => base);
    tenant = await startTenant({ url });
    expect(url).toHaveBeenCalledTimes(1);
    expect(tenant.source.status().lastError).toBeNull();
    const doctor = agoraDoctorChecks.find((check) => check.id === 'flags.control-plane-url')!;
    const app = {
      container: { hasBinding: () => true, make: async () => tenant },
    } as never;
    expect(await doctor.run(app)).toEqual({ status: 'ok', message: `control plane at ${base}` });
  });

  it('refreshes a lazy tenant.url after a connection error', async () => {
    const url = Object.assign(async () => 'http://127.0.0.1:1/_flags', {
      refresh: vi.fn(async () => base),
    });
    tenant = await startTenant({ url });
    expect(url.refresh).toHaveBeenCalledTimes(1);
    expect(tenant.source.status().lastError).toBeNull();
    expect(await tenant.controlPlaneUrl!.get()).toBe(base);
  });
});

describe('fetchControlPlane', () => {
  it('retries once on a 404 when the refreshed URL differs', async () => {
    let target = 'http://old/_flags';
    const address = new ControlPlaneAddress(
      Object.assign(async () => target, {
        refresh: async () => {
          target = 'http://new/_flags';
          return target;
        },
      }),
    );
    const doFetch = vi.fn(
      async (input: string | URL | Request) =>
        new Response(null, { status: String(input).startsWith('http://new') ? 200 : 404 }),
    );
    const response = await fetchControlPlane(address, '/v1/ruleset', () => ({}), doFetch as never);
    expect(response.status).toBe(200);
    expect(doFetch.mock.calls.map((call) => String(call[0]))).toEqual([
      'http://old/_flags/v1/ruleset',
      'http://new/_flags/v1/ruleset',
    ]);
  });

  it('keeps a string URL as is (no refresh, no retry)', async () => {
    const address = new ControlPlaneAddress('http://cp/_flags/');
    const doFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const response = await fetchControlPlane(address, '/v1/ruleset', () => ({}), doFetch as never);
    expect(response.status).toBe(404);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });
});

describe('config validation', () => {
  it('refuses a tenant.url that is neither a URL nor a function', () => {
    expect(() =>
      validateConfig({
        topology: 'tenant',
        flags: {},
        tenant: { url: 42 as never, token: 't', partition: 'shop' },
      }),
    ).toThrow(/tenant.url must be/);
  });

  it('accepts a function tenant.url', () => {
    expect(() =>
      validateConfig({
        topology: 'tenant',
        flags: {},
        tenant: { url: async () => 'http://cp', token: 't', partition: 'shop' },
      }),
    ).not.toThrow();
  });

  it('keeps diagnostics to tenants', () => {
    expect(() => validateConfig({ flags: {}, diagnostics: 'local' as never })).toThrow(
      /diagnostics only applies/,
    );
    expect(() =>
      validateConfig({
        topology: 'tenant',
        flags: {},
        diagnostics: 'nope' as never,
        tenant: { url: 'http://cp', token: 't', partition: 'shop' },
      }),
    ).toThrow(/"control-plane" or "local"/);
  });
});
