import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpContext } from '@adonisjs/core/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/index.js';
import { registerBrowser } from '../../src/http/browser.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import type { MemorySink } from '../../src/sinks/sink.js';
import { bullmqTransport } from '../../src/tenant_transports/bullmq.js';
import { durableTransport } from '../../src/tenant_transports/durable.js';
import { tenantTransports } from '../../src/tenant_transports/index.js';
import {
  createMessage,
  type DeadLetter,
  MemoryDedupe,
} from '../../src/tenant_transports/message.js';
import { queueTransport } from '../../src/tenant_transports/queue.js';
import { redisKeys } from '../../src/tenant_transports/redis.js';
import type { TenantTransport } from '../../src/tenant_transports/types.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { FakeRedis, fakeBullMQ, fakeDurable, fakeQueue } from '../fake_brokers.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';

const SECRET = 'browser-secret';
const declarations = { new_player: flag.boolean({ default: false }) };
const subject = (ctx: HttpContext) => {
  const id = ctx.request.header('x-user');
  return id ? { id } : null;
};

function collect() {
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  const router = {
    get: (pattern: string, handler: unknown) => {
      routes.push({ method: 'GET', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
    post: (pattern: string, handler: unknown) => {
      routes.push({ method: 'POST', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
  };
  return { routes, router };
}

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function closeServer(server: Server | undefined) {
  if (!server) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function until(check: () => Promise<boolean> | boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out');
}

/**
 * A control-plane serving `transports` over brokers AND its HTTP routes (tenants on HTTP, browsers,
 * OFREP), the way the provider mounts it.
 */
async function startControlPlane(
  db: TestDb,
  transports: TenantTransport[],
  redis?: FakeRedis,
  extra: { onDeadLetter?: (letter: DeadLetter) => void; verifyTenant?: never } = {},
) {
  const runtime = await createRuntime(
    defineConfig({
      topology: 'control-plane',
      flags: declarations,
      sinks: { mem: sinks.memory() },
      subject,
      verifyTenant: sharedSecretVerifier({
        partitions: {
          shop: 's3cret',
          reader: { secret: 'r', capabilities: ['flags:ruleset:read'] },
        },
      }),
      browser: { secret: SECRET },
    }),
    lucidContext(db.database as never),
    { logger: quietLogger },
  );
  const plane = new ControlPlane(
    runtime,
    {
      verifyTenant: extra.verifyTenant ?? (runtime.config as { verifyTenant: never }).verifyTenant,
      transports,
      ...(extra.onDeadLetter ? { onDeadLetter: extra.onDeadLetter } : {}),
      logger: quietLogger,
    },
    SECRET,
  );
  await plane.serveTransports({ redis: async () => redis });
  const { routes, router } = collect();
  plane.register(router);
  registerBrowser(router, runtime, { secret: SECRET, controlPlane: plane });
  const server = await serve(routes);
  return { runtime, plane, server, origin: urlOf(server) };
}

async function startTenant(
  tenant: Record<string, unknown>,
  options: { browser?: boolean; redis?: FakeRedis } = {},
) {
  return createRuntime(
    defineConfig({
      topology: 'tenant',
      flags: declarations,
      subject,
      tenant: { token: 's3cret', partition: 'shop', intervalMs: 60_000, ...tenant } as never,
      ...(options.browser ? { browser: {} } : {}),
    }),
    { ...lucidContext(undefined), redis: async () => options.redis as never },
    { logger: quietLogger },
  );
}

/** The tenant's own HTTP server: its token endpoint, as an app with a frontend mounts it. */
async function tenantServer(tenant: FlagsRuntime) {
  const { routes, router } = collect();
  registerBrowser(router, tenant, {});
  return serve(routes);
}

/** A browser: token from the tenant app, then the control-plane over HTTP with that token. */
async function browserEvaluates(tenantOrigin: string, cpBase: string) {
  const issued = (await (
    await fetch(`${tenantOrigin}/_flags/token`, { headers: { 'x-user': 'u7' } })
  ).json()) as { token: string; url: string };
  expect(issued.url).toBe(cpBase);
  const response = await fetch(`${cpBase}/v1/client/evaluate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
    body: '{}',
  });
  expect(response.status).toBe(200);
  return response;
}

const tracks = (runtime: FlagsRuntime) =>
  (runtime.sinks.get('mem') as MemorySink).events.filter((e) => e.type === 'track');

describe('tenant transports', () => {
  let db: TestDb;
  let cp: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  let tenant: FlagsRuntime | undefined;
  let appServer: Server | undefined;
  let dir: string;

  beforeEach(async () => {
    db = await sqliteDb();
    dir = mkdtempSync(join(tmpdir(), 'flags-tt-'));
  });

  afterEach(async () => {
    await closeServer(appServer);
    appServer = undefined;
    await tenant?.close();
    tenant = undefined;
    if (cp) {
      await cp.plane.close();
      await cp.runtime.close();
      await closeServer(cp.server);
      cp = undefined;
    }
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('redis', () => {
    it('carries events and the ruleset over Redis while browsers use HTTP on the same control-plane', async () => {
      const redis = new FakeRedis();
      cp = await startControlPlane(db, [tenantTransports.redis()], redis);
      await cp.runtime.admin!.turnOn('new_player', { id: 'alice' });
      await cp.runtime.manager.refresh();

      tenant = await startTenant(
        {
          url: `${cp.origin}/_flags`, // only for browsers: the tenant itself talks over Redis
          transport: tenantTransports.redis(),
          snapshotPath: join(dir, 'ruleset.json'),
        },
        { browser: true, redis },
      );
      expect(tenant.tenantLinks!.push.driver).toBe('redis');
      expect(tenant.tenantLinks!.watch.driver).toBe('redis');
      expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);
      await until(() => tenant!.source.status().mode === 'stream');

      // A change reaches the tenant through pub/sub.
      await cp.runtime.admin!.turnOff('new_player', { id: 'alice' });
      await cp.runtime.manager.refresh();
      await until(async () => !(await tenant!.manager.for('u2').enabled('new_player')));
      await vi.waitFor(() =>
        expect(JSON.parse(readFileSync(join(dir, 'ruleset.json'), 'utf8')).version).toBe(
          tenant!.source.current().version,
        ),
      );

      // Events go through the stream; the app comes from the verified token.
      await tenant.manager.track('u1', 'purchase', { value: 3 });
      await tenant.buffer!.flush();
      await until(async () => {
        await cp!.runtime.relay!.drain('mem');
        return tracks(cp!.runtime).length === 1;
      });
      expect(tracks(cp.runtime)[0]).toMatchObject({ app: 'shop', name: 'purchase' });
      await until(async () => (await cp!.runtime.store!.declarations('shop')).length === 1);
      expect(redis.stream(redisKeys().inbox).length).toBeGreaterThanOrEqual(3);

      // The frontend: token from the tenant app, flags straight from the control-plane over HTTP.
      appServer = await tenantServer(tenant);
      await browserEvaluates(urlOf(appServer), `${cp.origin}/_flags`);

      // HTTP tenants and OFREP still work on the same control-plane.
      const ruleset = await fetch(`${cp.origin}/_flags/v1/ruleset`, {
        headers: { authorization: 'Bearer s3cret', 'x-flags-tenant': 'shop' },
      });
      expect(ruleset.status).toBe(200);
      const ofrep = await fetch(`${cp.origin}/ofrep/v1/evaluate/flags/new_player`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer s3cret',
          'x-flags-tenant': 'shop',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ context: { targetingKey: 'u1' } }),
      });
      expect(ofrep.status).toBe(200);
    });

    it('boots from the Redis key, then the file snapshot, when the control-plane is down', async () => {
      const redis = new FakeRedis();
      cp = await startControlPlane(db, [tenantTransports.redis()], redis);
      await cp.runtime.admin!.turnOn('new_player', { id: 'alice' });
      await cp.runtime.manager.refresh();
      tenant = await startTenant(
        { transport: tenantTransports.redis(), snapshotPath: join(dir, 'ruleset.json') },
        { redis },
      );
      expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);
      await tenant.close();
      await cp.plane.close();

      // Control-plane gone, the key is still in Redis.
      tenant = await startTenant({ transport: tenantTransports.redis() }, { redis });
      expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);
      await tenant.close();

      // Redis gone too: the file snapshot.
      await vi.waitFor(() => readFileSync(join(dir, 'ruleset.json'), 'utf8'));
      redis.state.down = true;
      tenant = await startTenant(
        { transport: tenantTransports.redis(), snapshotPath: join(dir, 'ruleset.json') },
        { redis },
      );
      expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);
      expect(tenant.source.status().lastError).not.toBeNull();
      redis.state.down = false;
    });

    it('dead-letters poison messages into the dead stream and acks them', async () => {
      const redis = new FakeRedis();
      const letters: DeadLetter[] = [];
      cp = await startControlPlane(db, [tenantTransports.redis()], redis, {
        onDeadLetter: (l) => void letters.push(l),
      });
      const keys = redisKeys();
      await redis.xadd(keys.inbox, '*', 'm', 'not json');
      await redis.xadd(
        keys.inbox,
        '*',
        'm',
        JSON.stringify(createMessage('events', 'shop', 'wrong', { events: [] })),
      );
      await until(() => letters.length === 2);
      expect(letters.map((l) => l.reason).sort()).toEqual(['invalid', 'unauthorized']);
      expect(redis.stream(keys.dead)).toHaveLength(2);
      expect(redis.state.groups.get(`${keys.inbox}|${keys.group}`)!.pending.size).toBe(0);
      // Never the token.
      expect(JSON.stringify(letters)).not.toContain('wrong');
    });
  });

  describe('queue', () => {
    it('sends events as jobs while the ruleset and browsers stay on HTTP', async () => {
      const queue = fakeQueue();
      const transport = queueTransport({}, async () => queue.peer);
      cp = await startControlPlane(db, [transport]);
      await cp.runtime.admin!.turnOn('new_player', { id: 'alice' });
      await cp.runtime.manager.refresh();
      tenant = await startTenant(
        { url: `${cp.origin}/_flags`, transport, stream: false },
        { browser: true },
      );
      expect(tenant.tenantLinks!.push.driver).toBe('queue');
      expect(tenant.tenantLinks!.watch.driver).toBe('http');
      expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);

      await tenant.manager.track('u1', 'signup');
      await tenant.buffer!.flush();
      await queue.settle();
      await cp.runtime.relay!.drain('mem');
      expect(tracks(cp.runtime)[0]).toMatchObject({ app: 'shop', name: 'signup' });
      expect(queue.failed).toEqual([]);

      appServer = await tenantServer(tenant);
      await browserEvaluates(urlOf(appServer), `${cp.origin}/_flags`);
    });

    it('completes poison jobs without retrying them', async () => {
      const queue = fakeQueue();
      const transport = queueTransport({}, async () => queue.peer);
      const letters: DeadLetter[] = [];
      cp = await startControlPlane(db, [transport], undefined, {
        onDeadLetter: (l) => void letters.push(l),
      });
      const link = await transport.push({
        partition: 'shop',
        token: { get: async () => 'r-wrong' },
        redis: async () => undefined,
      });
      await link.send('events', { events: [] });
      await queue.settle();
      expect(letters).toHaveLength(1);
      expect(queue.completed).toHaveLength(1);
    });
  });

  describe('bullmq', () => {
    it('delivers events and fails poison jobs as unrecoverable', async () => {
      const bull = fakeBullMQ();
      const transport = bullmqTransport({ connection: {} }, async () => bull.peer);
      const letters: DeadLetter[] = [];
      cp = await startControlPlane(db, [transport], undefined, {
        onDeadLetter: (l) => void letters.push(l),
      });
      tenant = await startTenant({ url: `${cp.origin}/_flags`, transport, stream: false });
      await tenant.manager.track('u1', 'signup');
      await tenant.buffer!.flush();
      await bull.settle();
      await cp.runtime.relay!.drain('mem');
      expect(tracks(cp.runtime)).toHaveLength(1);
      expect(bull.added[0]!.options).toMatchObject({ jobId: expect.any(String), attempts: 6 });

      // The reader partition may only read the ruleset.
      const reader = await transport.push({
        partition: 'reader',
        token: { get: async () => 'r' },
        redis: async () => undefined,
      });
      await reader.send('events', { events: [] });
      await bull.settle();
      expect(letters.map((l) => l.reason)).toEqual(['forbidden']);
      expect(bull.failed).toMatchObject([{ unrecoverable: true }]);
    });
  });

  describe('durable', () => {
    it('sends events as runs and fetches the ruleset by a run, with changes on the control plane', async () => {
      const durable = fakeDurable();
      const transport = durableTransport({
        engine: durable.engine,
        controlPlane: durable.broadcast,
      });
      cp = await startControlPlane(db, [transport]);
      await cp.runtime.admin!.turnOn('new_player', { id: 'alice' });
      await cp.runtime.manager.refresh();
      tenant = await startTenant({ transport });
      expect(tenant.tenantLinks!.watch.driver).toBe('durable');
      expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);

      await cp.runtime.admin!.turnOff('new_player', { id: 'alice' });
      await cp.runtime.manager.refresh();
      await until(async () => !(await tenant!.manager.for('u2').enabled('new_player')));
      expect(durable.broadcast.published.length).toBeGreaterThan(0);
      // Broadcasts carry a version only, never a ruleset.
      expect(JSON.stringify(durable.broadcast.published)).not.toContain('new_player');

      await tenant.manager.track('u1', 'signup');
      await tenant.buffer!.flush();
      await durable.settle();
      await cp.runtime.relay!.drain('mem');
      expect(tracks(cp.runtime)).toHaveLength(1);
    });

    it('fails the run of a poison message', async () => {
      const durable = fakeDurable();
      const transport = durableTransport({ engine: durable.engine, controlPlane: false });
      const letters: DeadLetter[] = [];
      cp = await startControlPlane(db, [transport], undefined, {
        onDeadLetter: (l) => void letters.push(l),
      });
      const link = await transport.push({
        partition: 'shop',
        token: { get: async () => 'nope' },
        redis: async () => undefined,
      });
      await link.send('declarations', { declarations: {} });
      const [run] = await durable.settle();
      expect(run).toMatchObject({ status: 'failed', error: { message: 'dead-lettered' } });
      expect(letters).toHaveLength(1);
    });
  });

  describe('control-plane message handling', () => {
    it('takes the partition from the token, dedupes per partition and bounds sizes', async () => {
      // An authkit-style verifier: the token alone decides the partition.
      cp = await startControlPlane(db, [], undefined, {
        verifyTenant: (async ({ token }: { token?: string }) =>
          token === 'shop-token'
            ? { partition: 'shop', environment: 'staging', capabilities: ['flags:events:write'] }
            : null) as never,
      });
      const event = {
        id: 'e1',
        type: 'track',
        name: 'x',
        subject: 'u',
        subjectType: 'user',
        ts: Date.now(),
        app: 'billing', // a lie: ignored
        environment: 'production', // a lie: ignored
      };
      const message = createMessage('events', 'billing', 'shop-token', { events: [event] });
      const dedupe = new MemoryDedupe();
      const first = await cp.plane.handle(message, 'test', { dedupe });
      expect(first).toMatchObject({ status: 'ok', environment: 'staging' });
      expect(first.verified.partition).toBe('shop');
      expect((await cp.plane.handle(message, 'test', { dedupe })).status).toBe('duplicate');
      await cp.runtime.relay!.drain('mem');
      expect(tracks(cp.runtime)).toEqual([
        expect.objectContaining({ app: 'shop', environment: 'staging' }),
      ]);

      const big = createMessage('events', 'shop', 'shop-token', { pad: 'x'.repeat(2_000_000) });
      await expect(cp.plane.handle(big, 'test')).rejects.toMatchObject({ reason: 'too_large' });
      await expect(
        cp.plane.handle(createMessage('ruleset', 'shop', 'shop-token', {}), 'test'),
      ).rejects.toMatchObject({ reason: 'forbidden' });
      await expect(
        cp.plane.handle(createMessage('events', 'shop', 'shop-token', { events: 'x' }), 'test'),
      ).rejects.toMatchObject({ reason: 'invalid' });
    });

    it('answers ruleset messages with null when the tenant is current', async () => {
      cp = await startControlPlane(db, []);
      const current = await cp.plane.handle(createMessage('ruleset', 'shop', 's3cret', {}), 'test');
      const version = current.ruleset!.version;
      const again = await cp.plane.handle(
        createMessage('ruleset', 'shop', 's3cret', { version }),
        'test',
      );
      expect(again.ruleset).toBeNull();
    });

    it('accepts wildcard capabilities on bus messages and refuses unrelated ones', async () => {
      const grants: Record<string, string[]> = {
        'flags-wildcard': ['flags:*'],
        everything: ['*'],
        unrelated: ['config:*'],
      };
      cp = await startControlPlane(db, [], undefined, {
        verifyTenant: (async ({ token }: { token?: string }) =>
          token && grants[token]
            ? { partition: 'shop', capabilities: grants[token] }
            : null) as never,
      });
      for (const token of ['flags-wildcard', 'everything']) {
        expect(
          (await cp.plane.handle(createMessage('ruleset', 'shop', token, {}), 'test')).status,
        ).toBe('ok');
        expect(
          (
            await cp.plane.handle(
              createMessage('declarations', 'shop', token, { declarations: {} }),
              'test',
            )
          ).status,
        ).toBe('ok');
      }
      await expect(
        cp.plane.handle(createMessage('ruleset', 'shop', 'unrelated', {}), 'test'),
      ).rejects.toMatchObject({ reason: 'forbidden' });
    });
  });

  describe('http', () => {
    it('uses the injected fetch for both channels', async () => {
      cp = await startControlPlane(db, []);
      const calls: string[] = [];
      const spy: typeof fetch = (input, init) => {
        calls.push(new URL(String(input)).pathname);
        return fetch(input, init);
      };
      tenant = await startTenant({
        url: `${cp.origin}/_flags`,
        transport: tenantTransports.http({ fetch: spy, timeoutMs: 5000 }),
        stream: false,
      });
      await tenant.manager.track('u1', 'signup');
      await tenant.buffer!.flush();
      await until(() => calls.includes('/_flags/v1/declarations'));
      expect(calls).toEqual(
        expect.arrayContaining([
          '/_flags/v1/ruleset',
          '/_flags/v1/events',
          '/_flags/v1/declarations',
        ]),
      );
    });
  });

  describe('config', () => {
    const tenantConfig =
      (tenant: Record<string, unknown>, browser = false) =>
      () =>
        defineConfig({
          topology: 'tenant',
          flags: {},
          tenant: { auto: false, token: 't', partition: 'shop', ...tenant } as never,
          ...(browser ? { browser: {} } : {}),
        });

    it('refuses a push-only driver for the ruleset', () => {
      expect(
        tenantConfig({
          url: 'http://x',
          // @ts-expect-error queue cannot carry the ruleset
          watch: tenantTransports.queue(),
        }),
      ).toThrow(/cannot carry the ruleset/);
    });

    it('needs tenant.url only where HTTP is used', () => {
      expect(tenantConfig({ transport: tenantTransports.redis() })).not.toThrow();
      expect(tenantConfig({ transport: tenantTransports.durable() })).not.toThrow();
      expect(tenantConfig({})).toThrow(/tenant.url/);
      // queue pushes; the ruleset falls back to HTTP.
      expect(tenantConfig({ transport: tenantTransports.queue() })).toThrow(/tenant.url/);
      expect(
        tenantConfig({ transport: tenantTransports.queue(), watch: tenantTransports.redis() }),
      ).not.toThrow();
      // Browsers always reach the control-plane over HTTP.
      expect(tenantConfig({ transport: tenantTransports.redis() }, true)).toThrow(/tenant.url/);
    });
  });
});

describe('agora doctor', () => {
  const appWith = (runtime: unknown) =>
    ({
      container: {
        hasBinding: (name: string) => name === 'flags.runtime' && runtime !== undefined,
        make: async () => runtime,
      },
    }) as never;

  it('reports an unreachable broker on a tenant', async () => {
    const [check] = agoraDoctorChecks;
    const redis = new FakeRedis();
    const transport = tenantTransports.redis({ client: redis });
    const linkCtx = {
      partition: 'shop',
      token: { get: async () => 't' },
      redis: async () => redis,
    };
    const push = await transport.push(linkCtx);
    const ok = (await check!.run(
      appWith({ topology: 'tenant', tenantLinks: { push, watch: push } }),
    )) as Array<{ status: string }>;
    expect(ok.map((r) => r.status)).toEqual(['ok']);
    redis.state.down = true;
    const down = (await check!.run(
      appWith({ topology: 'tenant', tenantLinks: { push, watch: push } }),
    )) as Array<{ status: string; message: string }>;
    expect(down[0]).toMatchObject({ status: 'error' });
    expect(down[0]!.message).toContain('ECONNREFUSED');
  });

  it('checks the control-plane brokers, and skips without flags', async () => {
    const [check] = agoraDoctorChecks;
    expect(await check!.run(appWith(undefined))).toMatchObject({ status: 'skip' });
    expect(
      await check!.run(appWith({ topology: 'control-plane', controlPlane: { links: [] } })),
    ).toMatchObject({ status: 'ok', message: 'tenants connect over HTTP only' });
    const failing = await check!.run(
      appWith({
        topology: 'control-plane',
        controlPlane: {
          links: [{ driver: 'redis', check: async () => Promise.reject(new Error('down')) }],
        },
      }),
    );
    expect(failing).toEqual([expect.objectContaining({ status: 'error' })]);
  });
});

describe('serving in ace commands', () => {
  it('starts only passive drivers (queue) when asked', async () => {
    const served: string[] = [];
    const fake = (driver: 'redis' | 'queue', passive: boolean) =>
      ({
        driver,
        canWatch: false,
        passive,
        push: async () => ({}) as never,
        serve: async () => {
          served.push(driver);
          return { driver };
        },
      }) as never;
    const plane = new ControlPlane({ manager: { environment: 'production' } } as never, {
      verifyTenant: async () => null,
      transports: [fake('redis', false), fake('queue', true)],
    });
    await plane.serveTransports({ redis: async () => undefined, passiveOnly: true });
    expect(served).toEqual(['queue']);
    await plane.close();
  });
});
