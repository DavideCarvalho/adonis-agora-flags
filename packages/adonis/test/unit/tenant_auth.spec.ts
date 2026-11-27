import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authkitTenantToken, authkitTenantVerifier } from '@adonis-agora/authkit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, type FlagsConfig, sinks } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { FLAGS_RESOURCE, resolveTenantToken, TENANT_SCOPES } from '../../src/topology/token.js';
import {
  resolveTenantVerifier,
  sharedSecretVerifier,
  type TenantVerifierOption,
  type TenantVerifierRequest,
  type VerifiedTenant,
} from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';
import { startIssuer, type TestIssuer } from '../issuer.js';

const declarations = { new_player: flag.boolean({ default: false }) };
const ALL = Object.values(TENANT_SCOPES);

async function controlPlaneWith(db: TestDb, verifyTenant: TenantVerifierOption) {
  const runtime = await createRuntime(
    defineConfig({
      topology: 'control-plane',
      flags: declarations,
      sinks: { warehouse: sinks.lucid() },
      verifyTenant,
    }),
    lucidContext(db.database as never),
    { logger: quietLogger },
  );
  const plane = new ControlPlane(runtime, { verifyTenant });
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
  const server = await serve(routes);
  return {
    runtime,
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

describe('tenants authenticated by a remote authkit issuer', () => {
  let issuer: TestIssuer;
  let db: TestDb;
  let cp: FlagsRuntime;
  let tenant: FlagsRuntime | undefined;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    issuer = await startIssuer({
      'shop-client': { secret: 'shh', partition: 'shop', capabilities: ALL },
      'reader-client': {
        secret: 'r',
        partition: 'reader',
        capabilities: [TENANT_SCOPES.rulesetRead],
      },
      'staging-client': {
        secret: 's',
        partition: 'stage',
        capabilities: ALL,
        environment: 'staging',
      },
    });
    db = await sqliteDb();
    ({
      runtime: cp,
      server,
      base,
    } = await controlPlaneWith(
      db,
      authkitTenantVerifier({ issuer: issuer.url, resource: FLAGS_RESOURCE }),
    ));
  });

  afterEach(async () => {
    await tenant?.close();
    tenant = undefined;
    await cp.close();
    await closeServer(server);
    await db.close();
    await issuer.close();
  });

  const tokenFor = (clientId: string, clientSecret: string, resource = FLAGS_RESOURCE) =>
    authkitTenantToken({ issuer: issuer.url, clientId, clientSecret, resource })();

  const get = (path: string, token: string, claimed = 'shop') =>
    fetch(`${base}/_flags${path}`, {
      headers: { authorization: `Bearer ${token}`, 'x-flags-tenant': claimed },
    });

  const post = (path: string, token: string, body: unknown, claimed = 'shop') =>
    fetch(`${base}/_flags${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-flags-tenant': claimed,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  it('runs a tenant end to end with authkitTenantToken: partition from the token', async () => {
    await cp.admin!.turnOn('new_player', { id: 'alice' });
    await cp.manager.refresh();
    tenant = await createRuntime(
      defineConfig({
        topology: 'tenant',
        flags: declarations,
        tenant: {
          url: `${base}/_flags`,
          partition: 'shop',
          token: authkitTenantToken({
            issuer: issuer.url,
            clientId: 'shop-client',
            clientSecret: 'shh',
            resource: FLAGS_RESOURCE,
          }),
          stream: false,
          intervalMs: 60_000,
        },
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );
    expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);

    await tenant.manager.track('u1', 'purchase', { value: 10 });
    await tenant.buffer!.flush();
    await cp.relay!.drain('warehouse');
    const rows = (await db.database.rawQuery('SELECT app, name FROM flags_tracks')) as Array<{
      app: string;
      name: string;
    }>;
    expect(rows).toEqual([{ app: 'shop', name: 'purchase' }]);
    await vi.waitFor(async () =>
      expect((await cp.store!.declarations('shop')).map((d) => d.key)).toEqual(['new_player']),
    );
    // One token served every request.
    expect(issuer.tokenRequests()).toBe(1);
  });

  it('takes the partition from the token, never from the request', async () => {
    const token = await tokenFor('shop-client', 'shh');
    const response = await post(
      '/v1/declarations',
      token,
      { declarations: { spoofed: { type: 'boolean', default: false } } },
      'billing',
    );
    expect(response.status).toBe(204);
    expect(await cp.store!.declarations('billing')).toEqual([]);
    expect((await cp.store!.declarations('shop')).map((d) => d.key)).toEqual(['spoofed']);
  });

  it('checks capabilities per endpoint', async () => {
    const token = await tokenFor('reader-client', 'r');
    expect((await get('/v1/ruleset', token, 'reader')).status).toBe(200);
    const events = await post('/v1/events', token, { events: [] }, 'reader');
    expect(events.status).toBe(403);
    expect(await events.json()).toEqual({ error: 'token lacks the flags:events:write capability' });
    expect((await post('/v1/declarations', token, { declarations: {} }, 'reader')).status).toBe(
      403,
    );
    expect((await post('/v1/usage', token, { rows: [] }, 'reader')).status).toBe(403);
  });

  it('serves the environment named by the token', async () => {
    await cp.admin!.turnOn('new_player', { id: 'alice' }, { environment: 'staging' });
    const staging = (await (
      await get('/v1/ruleset', await tokenFor('staging-client', 's'), 'stage')
    ).json()) as { flags: Record<string, unknown> };
    expect(staging.flags.new_player).toBeDefined();
    const production = (await (
      await get('/v1/ruleset', await tokenFor('shop-client', 'shh'))
    ).json()) as { flags: Record<string, unknown> };
    expect(production.flags.new_player).toBeUndefined();
  });

  it('refuses tokens for another resource, unsigned, expired, user and partition-less tokens', async () => {
    const durable = await tokenFor('shop-client', 'shh', 'urn:agora:durable');
    expect((await get('/v1/ruleset', durable)).status).toBe(401);

    const forged = await issuer.sign(
      { sub: 'shop-client', client_id: 'shop-client', partition: 'shop', capabilities: ALL },
      { audience: FLAGS_RESOURCE, key: 'other' },
    );
    expect((await get('/v1/ruleset', forged)).status).toBe(401);

    const expired = await issuer.sign(
      { sub: 'shop-client', client_id: 'shop-client', partition: 'shop', capabilities: ALL },
      { audience: FLAGS_RESOURCE, expiresIn: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect((await get('/v1/ruleset', expired)).status).toBe(401);

    const user = await issuer.sign(
      { sub: 'user-1', client_id: 'shop-client', partition: 'shop', capabilities: ALL },
      { audience: FLAGS_RESOURCE },
    );
    expect((await get('/v1/ruleset', user)).status).toBe(401);

    const noPartition = await issuer.sign(
      { sub: 'shop-client', client_id: 'shop-client', capabilities: ALL },
      { audience: FLAGS_RESOURCE },
    );
    expect((await get('/v1/ruleset', noPartition)).status).toBe(401);

    const idToken = await issuer.sign(
      { sub: 'shop-client', client_id: 'shop-client', partition: 'shop', capabilities: ALL },
      { audience: FLAGS_RESOURCE, typ: 'JWT' },
    );
    expect((await get('/v1/ruleset', idToken)).status).toBe(401);

    expect((await fetch(`${base}/_flags/v1/ruleset`)).status).toBe(401);
  });

  it('accepts wildcard capabilities on every endpoint and refuses unrelated ones', async () => {
    const sign = (capabilities: string[]) =>
      issuer.sign(
        { sub: 'shop-client', client_id: 'shop-client', partition: 'shop', capabilities },
        { audience: FLAGS_RESOURCE },
      );
    for (const capabilities of [['flags:*'], ['*']]) {
      const token = await sign(capabilities);
      expect((await get('/v1/ruleset', token)).status).toBe(200);
      expect((await post('/v1/events', token, { events: [] })).status).toBe(202);
      expect((await post('/v1/declarations', token, { declarations: {} })).status).toBe(204);
      expect((await post('/v1/usage', token, { rows: [] })).status).toBe(204);
    }

    const unrelated = await sign(['config:*', 'flags:events:write']);
    const ruleset = await get('/v1/ruleset', unrelated);
    expect(ruleset.status).toBe(403);
    expect(await ruleset.json()).toEqual({
      error: 'token lacks the flags:ruleset:read capability',
    });
  });

  it('refuses a token without capabilities on every endpoint', async () => {
    const bare = await issuer.sign(
      { sub: 'shop-client', client_id: 'shop-client', partition: 'shop' },
      { audience: FLAGS_RESOURCE },
    );
    expect((await get('/v1/ruleset', bare)).status).toBe(403);
    expect((await post('/v1/events', bare, { events: [] })).status).toBe(403);
  });
});

describe('sharedSecretVerifier', () => {
  const verify = sharedSecretVerifier({
    partitions: {
      shop: 's3cret',
      billing: { secret: 'b', environment: 'staging', capabilities: [TENANT_SCOPES.rulesetRead] },
    },
  });

  it('accepts the partition whose secret matches, with every capability by default', async () => {
    expect(await verify({ token: 's3cret', partition: 'shop' })).toEqual({
      partition: 'shop',
      capabilities: ALL,
    });
    expect(await verify({ token: 'b', tenant: 'billing' })).toEqual({
      partition: 'billing',
      environment: 'staging',
      capabilities: [TENANT_SCOPES.rulesetRead],
    });
  });

  it('refuses a wrong secret, another partition, an unknown one or a missing token', async () => {
    expect(await verify({ token: 'nope', partition: 'shop' })).toBeNull();
    expect(await verify({ token: 's3cret', partition: 'billing' })).toBeNull();
    expect(await verify({ token: 's3cret', partition: 'ghost' })).toBeNull();
    expect(await verify({ partition: 'shop' })).toBeNull();
    expect(await verify({ token: 's3cret' })).toBeNull();
  });

  it('needs a partitions map', () => {
    expect(() => sharedSecretVerifier({} as never)).toThrow(/partitions/);
  });
});

describe('verifyTenant forms', () => {
  const answer: VerifiedTenant = { partition: 'shop', capabilities: ALL };
  const request: TenantVerifierRequest = { token: 't', partition: 'shop' };

  class Verifier {
    calls = 0;
    verify(input: TenantVerifierRequest) {
      this.calls++;
      return input.token === 't' ? answer : null;
    }
  }

  it('accepts a function', async () => {
    const verify = resolveTenantVerifier(async ({ token }) => (token === 't' ? answer : null));
    expect(await verify(request)).toEqual(answer);
    expect(await verify({ token: 'x' })).toBeNull();
  });

  it('accepts a class instance', async () => {
    const verify = resolveTenantVerifier(new Verifier());
    expect(await verify(request)).toEqual(answer);
  });

  it('accepts a lazy import of a class, built once', async () => {
    const make = vi.fn((cls: new () => Verifier) => new cls());
    const load = vi.fn(async () => ({ default: Verifier }));
    const verify = resolveTenantVerifier(load, make as never);
    expect(await verify(request)).toEqual(answer);
    expect(await verify(request)).toEqual(answer);
    expect(load).toHaveBeenCalledTimes(1);
    expect(make).toHaveBeenCalledTimes(1);
  });

  it('accepts a lazy import of an object', async () => {
    const instance = new Verifier();
    const verify = resolveTenantVerifier(async () => ({ default: instance }));
    expect(await verify(request)).toEqual(answer);
    expect(await verify(request)).toEqual(answer);
    expect(instance.calls).toBe(2);
  });

  it('accepts the function authkit-client returns, which also has verify()', async () => {
    const fn = Object.assign(async () => answer, { verify: async () => answer });
    expect(await resolveTenantVerifier(fn)(request)).toEqual(answer);
  });

  it('throws on a malformed answer instead of accepting it', async () => {
    const legacy = resolveTenantVerifier((() => ({ tenant: 'shop' })) as never);
    await expect(legacy(request)).rejects.toThrow(/rename it to `partition`/);
    const noCapabilities = resolveTenantVerifier((() => ({ partition: 'shop' })) as never);
    await expect(noCapabilities(request)).rejects.toThrow(/capabilities/);
  });

  it('refuses a value that is none of the forms', () => {
    expect(() => resolveTenantVerifier('secret' as never)).toThrow(/verifyTenant must be/);
  });
});

describe('tenant.token forms', () => {
  it('accepts a string, a function (with reset) and an object with get()', async () => {
    expect(await resolveTenantToken('s').get()).toBe('s');
    const reset = vi.fn();
    const fn = Object.assign(async () => 'f', { reset });
    const source = resolveTenantToken(fn);
    expect(await source.get()).toBe('f');
    source.invalidate?.();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(await resolveTenantToken({ get: async () => 'o' }).get()).toBe('o');
    expect(() => resolveTenantToken(42 as never)).toThrow(/tenant.token/);
  });
});

describe('config validation', () => {
  const verifyTenant = sharedSecretVerifier({ partitions: { shop: 's' } });

  it('refuses verifyTenant nested under controlPlane (the old shape)', () => {
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        flags: {},
        controlPlane: { verifyTenant },
      } as never),
    ).toThrow(/controlPlane.verifyTenant moved to the top level/);
  });

  it('needs verifyTenant on a control-plane', () => {
    expect(() => defineConfig({ topology: 'control-plane', flags: {} } as never)).toThrow(
      /needs `verifyTenant`/,
    );
    expect(() =>
      defineConfig({ topology: 'control-plane', flags: {}, verifyTenant: 'x' } as never),
    ).toThrow(/verifyTenant must be/);
  });

  it('refuses verifyTenant and controlPlane on other topologies', () => {
    expect(() => defineConfig({ flags: {}, verifyTenant } as never)).toThrow(
      /only applies to topology "control-plane"/,
    );
    expect(() => defineConfig({ flags: {}, controlPlane: { prefix: '/f' } } as never)).toThrow(
      /controlPlane only applies/,
    );
  });

  it('needs a token on a tenant (auto-detection off)', () => {
    expect(() =>
      defineConfig({
        topology: 'tenant',
        flags: {},
        tenant: { auto: false, url: 'http://cp', partition: 'shop' },
      } as never),
    ).toThrow(/needs tenant.token/);
  });

  it('validates at boot too, for configs not built with defineConfig', async () => {
    const config = {
      topology: 'control-plane',
      flags: {},
      controlPlane: { verifyTenant },
    } as unknown as FlagsConfig;
    await expect(createRuntime(config, lucidContext(undefined))).rejects.toThrow(
      /moved to the top level/,
    );
  });

  it('accepts the new shape', () => {
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        flags: {},
        verifyTenant,
        controlPlane: { prefix: '/flags' },
      }),
    ).not.toThrow();
  });
});
