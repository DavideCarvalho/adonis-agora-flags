import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as h from '../../src/dashboard/handlers.js';
import { flag } from '../../src/declare.js';
import {
  answerConsoleCommands,
  consoleHandlerName,
  type FederatedFlagsApp,
  FederatedFlagsConsole,
  readOnlyStore,
  resolveConsoleCommands,
  validateFederatedApp,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { defineConfig, metric, stores } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import type { SqlDatabase } from '../../src/sql.js';
import { FakePubSubRedis } from '../fake_pubsub_redis.js';
import { quietLogger } from '../helpers.js';

/**
 * Two apps in one process: "hub" runs the console, "et" keeps its own flags in its own database and
 * evaluates locally. They share a (fake) Redis; the hub reads et's tables through a Lucid
 * connection of its own and sends every change to et, which runs it.
 */

const req = (
  parts: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {},
): h.ApiRequest => ({ params: parts.params ?? {}, query: parts.query ?? {}, body: parts.body });

const body = <T = Record<string, any>>(response: h.ApiResponse) => response.body as T;

const etConfig = (extra: Record<string, unknown> = {}) =>
  defineConfig({
    app: 'entre-textos',
    flags: {
      new_editor: flag.boolean({ default: false, owner: 'editor-team' }),
      plan: flag.string({ default: 'basic', variants: ['basic', 'pro'] }),
    },
    metrics: { signup: metric.conversion('signup') },
    experiments: { plan: { metrics: ['signup'] } },
    store: stores.lucid({ connection: 'et' }),
    dispatcher: 'in-process',
    ...extra,
  } as never);

const ops = { id: 'ops-1', name: 'ops@hub.example' };
/** The secret the hub and et share (shared-secret mode of the console channel). */
const SECRET = 'hub-and-et-share-this-0123456789';

describe('federated console (two apps, one Redis)', () => {
  let dir: string;
  let database: Database;
  let et: FlagsRuntime;
  let redis: FakePubSubRedis;
  const answering: RedisConsoleChannel[] = [];
  let federation: FederatedFlagsConsole;
  const logs: string[] = [];

  async function bootEt(extra: Record<string, unknown> = {}) {
    et = await createRuntime(
      etConfig(extra),
      lucidContext({ connection: (name) => database.connection(name) as unknown as SqlDatabase }),
      { logger: quietLogger, runWorker: false, listen: false },
    );
  }

  async function answer(actions = true) {
    // A separate connection per instance, as two processes of the app would have.
    answering.push(
      await answerConsoleCommands({
        client: redis.duplicate(),
        prefix: 'entretextos',
        actions,
        secret: SECRET,
        runtime: () => et,
        log: (line) => logs.push(line),
      }),
    );
  }

  function console_(entry: Partial<FederatedFlagsApp> = {}) {
    federation = new FederatedFlagsConsole(
      {
        et: {
          label: 'Entre Textos',
          store: { connection: 'et' },
          controlPlane: { prefix: 'entretextos', secret: SECRET },
          timeoutMs: 1000,
          ...entry,
        },
      },
      {
        db: async (name) => database.connection(name) as unknown as SqlDatabase,
        redis: async () => redis,
      },
    );
    return federation;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'flags-federated-'));
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    const sqlite = (file: string) => ({
      client: 'better-sqlite3' as const,
      connection: { filename: join(dir, file) },
      useNullAsDefault: true,
    });
    database = new Database(
      { connection: 'hub', connections: { hub: sqlite('hub.sqlite'), et: sqlite('et.sqlite') } },
      new LoggerFactory().create(),
      new Emitter(app),
    );
    redis = new FakePubSubRedis();
    logs.length = 0;
    await bootEt();
  });

  afterEach(async () => {
    await federation?.close();
    for (const channel of answering.splice(0)) await channel.close();
    await et?.close();
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the app flags from its tables, with the declarations only the app knows', async () => {
    await answer();
    await et.admin!.setRollout('new_editor', 25, { id: 'et-dev' });
    const hub = console_();
    const list = await hub.dispatch('et', 'listFlags', { actor: ops }, req());
    expect(list.status).toBe(200);
    const flags = body(list).data as Array<{ key: string; serving: unknown; declaration: any }>;
    expect(flags.map((f) => f.key)).toEqual(['new_editor', 'plan']);
    expect(flags[0]).toMatchObject({
      serving: { kind: 'rollout', percent: 25 },
      declaration: { owner: 'editor-team', apps: ['entre-textos'], source: 'code' },
    });
    const meta = body(await hub.dispatch('et', 'meta', { actor: ops }, req()));
    expect(meta).toMatchObject({
      app: 'entre-textos',
      environment: 'production',
      federated: {
        id: 'et',
        label: 'Entre Textos',
        mode: 'federated',
        actions: 'app',
        reachable: true,
      },
    });
    const audit = body(await hub.dispatch('et', 'audit', { actor: ops }, req({ query: {} })));
    expect(audit.data[0]).toMatchObject({ key: 'new_editor', actor: { id: 'et-dev' } });
  });

  it('sends a change to the app, which applies it with its own admin and audit', async () => {
    await answer();
    const hub = console_();
    const res = await hub.dispatch(
      'et',
      'setEnabled',
      { actor: ops },
      req({ params: { key: 'new_editor' }, body: { enabled: false, note: 'incident' } }),
    );
    expect(res.status).toBe(200);
    expect(body(res).status).toBe('applied');
    const [entry] = await et.store!.audit({ entity: 'flag', key: 'new_editor' });
    expect(entry).toMatchObject({ actor: { id: 'ops-1', name: 'ops@hub.example' } });
    expect(logs).toEqual([
      '[flags] federated console: setEnabled new_editor by ops-1 (ops@hub.example)',
    ]);
    // The app evaluates locally from its own store.
    await et.manager.refresh();
    expect((await et.store!.readRuleset('production')).flags.new_editor?.enabled).toBe(false);
  });

  it('runs each change once however many instances of the app listen', async () => {
    await answer();
    await answer();
    await answer();
    const hub = console_();
    const res = await hub.dispatch(
      'et',
      'setRollout',
      { actor: ops },
      req({ params: { key: 'new_editor' }, body: { percent: 50 } }),
    );
    expect(res.status).toBe(200);
    expect(await et.store!.audit({ entity: 'flag', key: 'new_editor' })).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("follows the app's approvals: a change becomes a request, anonymous people are refused", async () => {
    await et.close();
    await bootEt({ approvals: { environments: ['production'] } });
    await answer();
    const hub = console_();
    const change = req({ params: { key: 'plan' }, body: { variant: 'pro' } });
    const pending = await hub.dispatch('et', 'setVariant', { actor: ops }, change);
    expect(pending.status).toBe(202);
    expect(await et.store!.listChangeRequests({ status: 'pending' })).toHaveLength(1);
    // The pending request is visible from the hub, read from the app's tables.
    const requests = await hub.dispatch('et', 'listChangeRequests', { actor: ops }, req());
    expect(body(requests).data).toHaveLength(1);
    const anonymous = await hub.dispatch(
      'et',
      'setVariant',
      { actor: { id: 'dashboard', anonymous: true } },
      change,
    );
    expect(anonymous.status).toBe(403);
  });

  it('asks the app for experiment results and ops', async () => {
    await answer();
    const hub = console_();
    const experiments = await hub.dispatch('et', 'listExperiments', { actor: ops }, req());
    expect(experiments.status).toBe(200);
    expect(body(experiments).data.map((e: { key: string }) => e.key)).toEqual(['plan']);
    const status = await hub.dispatch('et', 'ops', { actor: ops }, req());
    expect(body(status)).toMatchObject({ app: 'entre-textos', topology: 'standalone' });
  });

  it('answers 503 at once when no instance listens, and keeps reading the tables', async () => {
    const hub = console_({ timeoutMs: 60_000 });
    const started = Date.now();
    const res = await hub.dispatch(
      'et',
      'setEnabled',
      { actor: ops },
      req({ params: { key: 'new_editor' }, body: { enabled: true } }),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(res.status).toBe(503);
    expect(body(res)).toMatchObject({ code: 'federated-app-unreachable' });
    expect(body(res).error).toMatch(/Entre Textos did not answer/);
    const meta = await hub.dispatch('et', 'meta', { actor: ops }, req());
    expect(body(meta).federated.reachable).toBe(false);
    // Without the app, its tables still read; code declarations are unknown.
    await et.admin!.turnOn('new_editor', { id: 'et-dev' });
    const flags = body(await hub.dispatch('et', 'listFlags', { actor: ops }, req())).data;
    expect(flags.map((f: { key: string }) => f.key)).toEqual(['new_editor']);
  });

  it('refuses changes when the entry is browse-only or the app takes reads only', async () => {
    await answer(false);
    const change = req({ params: { key: 'new_editor' }, body: { enabled: true } });
    const browse = console_({ actions: false });
    expect(browse.list()).toEqual([
      { id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'none' },
    ]);
    const refused = await browse.dispatch('et', 'setEnabled', { actor: ops }, change);
    expect(refused.status).toBe(403);
    expect(body(refused).error).toMatch(/read-only in this console/);
    await browse.close();
    const hub = console_();
    const byApp = await hub.dispatch('et', 'setEnabled', { actor: ops }, change);
    expect(byApp.status).toBe(403);
    expect(body(byApp).error).toMatch(/consoleCommands.actions is off/);
    // Reads the app answers still work.
    expect((await hub.dispatch('et', 'ops', { actor: ops }, req())).status).toBe(200);
  });

  it('relays the app validation errors', async () => {
    await answer();
    const hub = console_();
    const res = await hub.dispatch(
      'et',
      'setRollout',
      { actor: ops },
      req({ params: { key: 'new_editor' }, body: { percent: 'lots' } }),
    );
    expect(res.status).toBe(400);
    const unknown = await hub.dispatch('nope', 'listFlags', { actor: ops }, req());
    expect(unknown.status).toBe(404);
  });

  it('never writes the app tables itself', async () => {
    const store = readOnlyStore(et.store!);
    await expect(store.readRuleset('production')).resolves.toBeTruthy();
    expect(() => store.apply('production', { entity: 'holdout', value: null }, ops)).toThrow(
      /read-only/,
    );
  });
});

describe('federation config', () => {
  const plane = { prefix: 'et' };
  it('validates an apps entry', () => {
    expect(() => validateFederatedApp('et', { store: {}, controlPlane: plane })).not.toThrow();
    expect(() => validateFederatedApp('bad key!', { store: {}, controlPlane: plane })).toThrow(
      /key/,
    );
    expect(() => validateFederatedApp('et', { store: {}, controlPlane: { prefix: '' } })).toThrow(
      /prefix/,
    );
    expect(() =>
      validateFederatedApp('et', { store: { schema: 'a;b' }, controlPlane: plane }),
    ).toThrow(/schema/);
    expect(() =>
      validateFederatedApp('et', { store: {}, controlPlane: plane, timeoutMs: 0 }),
    ).toThrow(/timeoutMs/);
    expect(() =>
      validateFederatedApp('et', { store: undefined as never, controlPlane: plane }),
    ).toThrow(/store/);
  });

  it('resolves consoleCommands', () => {
    expect(resolveConsoleCommands(undefined, 'shop')).toBeUndefined();
    // Changes from another console are opt-in.
    expect(resolveConsoleCommands(true, 'shop')).toEqual({
      prefix: 'shop',
      connection: undefined,
      actions: false,
    });
    expect(resolveConsoleCommands({ actions: true, secret: SECRET }, 'shop')).toMatchObject({
      actions: true,
      secret: SECRET,
    });
    expect(resolveConsoleCommands({ prefix: 'et', actions: false }, 'shop')).toMatchObject({
      prefix: 'et',
      actions: false,
    });
  });

  it('refuses consoleCommands on a tenant and malformed ones', () => {
    expect(() =>
      defineConfig({
        topology: 'tenant',
        flags: {},
        tenant: { url: 'http://cp', token: 't', partition: 'shop' },
        consoleCommands: true,
      } as never),
    ).toThrow(/tenant/);
    expect(() => defineConfig({ flags: {}, consoleCommands: { prefix: '' } })).toThrow(/prefix/);
    expect(() => defineConfig({ flags: {}, consoleCommands: true })).not.toThrow();
    expect(() => defineConfig({ flags: {}, consoleCommands: { secret: 'short' } })).toThrow(
      /16 characters/,
    );
    expect(() => defineConfig({ flags: {}, consoleCommands: { crypto: {} } } as never)).toThrow(
      /cipher/,
    );
  });

  it('checks the authentication of an apps entry', () => {
    // A token without publicKey may be sealed to the key in authkit's directory: decided at boot.
    expect(() =>
      validateFederatedApp('et', { store: {}, controlPlane: { ...plane, token: 't' } }),
    ).not.toThrow();
    expect(() =>
      validateFederatedApp('et', {
        store: {},
        controlPlane: { ...plane, token: 't', publicKey: '{"kty":"OKP"}' },
      }),
    ).toThrow(/X25519/);
    expect(() =>
      validateFederatedApp('et', {
        store: {},
        controlPlane: {
          ...plane,
          token: 't',
          publicKey: { kty: 'OKP', crv: 'X25519', x: 'x', kid: 'k', d: 'secret' },
        },
      }),
    ).toThrow(/private key/);
  });

  it('names every routed console handler', () => {
    expect(consoleHandlerName(h.listFlags)).toBe('listFlags');
    expect(consoleHandlerName(h.setRollout)).toBe('setRollout');
    expect(consoleHandlerName(h.listApps)).toBeUndefined();
  });
});

describe('GET /api/apps (listApps)', () => {
  it('lists the federated apps besides this one, filtered by the viewer scope', async () => {
    const runtime = await createRuntime(
      defineConfig({ app: 'hub', flags: {}, store: stores.memory() }),
      lucidContext(undefined),
      { logger: quietLogger, start: false },
    );
    const federated = [
      { id: 'et', label: 'Entre Textos', mode: 'federated' as const, actions: 'app' as const },
      { id: 'el', label: 'EduLiberta', mode: 'federated' as const, actions: 'none' as const },
    ];
    const all = body(
      await h.listApps({ runtime, actor: ops }, req({ query: { app: 'et' } }), {
        federated,
        label: 'Hub',
      }),
    );
    expect(all).toEqual({
      local: { id: 'hub', label: 'Hub' },
      topology: 'standalone',
      appScope: '*',
      apps: federated,
      selected: 'et',
    });
    const limited = body(
      await h.listApps({ runtime, actor: ops, apps: ['el'] }, req({ query: { app: 'et' } }), {
        federated,
      }),
    );
    expect(limited.apps.map((a: { id: string }) => a.id)).toEqual(['el']);
    expect(limited.selected).toBeNull();
    await runtime.close();
  });
});
