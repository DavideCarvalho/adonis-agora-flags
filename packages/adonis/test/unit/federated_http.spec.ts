import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig as defineDashboardConfig } from '../../src/dashboard/define_config.js';
import { flag } from '../../src/declare.js';
import { defineConfig, stores, transports } from '../../src/define_config.js';
import { answerConsoleCommands, consoleCommandKeys } from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { appKeyOf, releaseSecret } from '../../src/http/browser.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { FakePubSubRedis } from '../fake_pubsub_redis.js';
import { quietLogger } from '../helpers.js';

const SECRET = 'hub-and-et-share-this-0123456789';

/**
 * The federated console over HTTP: a real AdonisJS app ("hub") whose flags console lists another
 * app ("et") and serves `?app=et` from et's store and et's answers over a shared (fake) Redis.
 */
describe('federated console over HTTP', () => {
  let hub: ApplicationService;
  let http: Server;
  let base: string;
  let et: FlagsRuntime;
  let answering: RedisConsoleChannel;
  let viewerApps: '*' | string[] = '*';

  beforeAll(async () => {
    const redis = new FakePubSubRedis();
    et = await createRuntime(
      defineConfig({
        app: 'entre-textos',
        flags: { new_editor: flag.boolean({ default: false }) },
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    answering = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'entretextos',
      actions: true,
      secret: SECRET,
      runtime: () => et,
    });

    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: {
          providers: [
            () => import('../../providers/flags_provider.js'),
            () => import('../../providers/dashboard_provider.js'),
          ],
        },
        config: {
          flags: defineConfig({
            app: 'hub',
            flags: { hub_only: flag.boolean({ default: true }) },
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            dispatcher: 'in-process',
          }),
          flags_dashboard: defineDashboardConfig({
            authorize: () => ({ allowed: true, apps: viewerApps }),
            actor: () => ({ id: 'ops-1', name: 'Ops' }),
            appLabel: 'Hub',
            apps: {
              et: {
                label: 'Entre Textos',
                // A store instance and a channel: no Lucid or Redis binding needed here.
                store: et.store!,
                controlPlane: new RedisConsoleChannel({
                  client: redis,
                  prefix: 'entretextos',
                  secret: SECRET,
                }),
                timeoutMs: 2000,
              },
            },
          }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    hub = ignitor.createApp('web') as ApplicationService;
    await hub.init();
    await hub.boot();
    const server = await hub.container.make('server');
    server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
    await server.boot();
    http = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/flags/api`;
  });

  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
    await hub.terminate();
    await answering.close();
    await et.close();
  });

  it('lists this app and the federated one on GET /api/apps', async () => {
    const res = await fetch(`${base}/apps?app=et`);
    expect(await res.json()).toEqual({
      local: { id: 'hub', label: 'Hub' },
      topology: 'standalone',
      appScope: '*',
      apps: [{ id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
      selected: 'et',
    });
  });

  it("reads the federated app's flags with ?app= and this app's without", async () => {
    const theirs = (await (await fetch(`${base}/flags?app=et`)).json()) as {
      data: Array<{ key: string }>;
    };
    expect(theirs.data.map((f) => f.key)).toEqual(['new_editor']);
    const ours = (await (await fetch(`${base}/flags`)).json()) as { data: Array<{ key: string }> };
    expect(ours.data.map((f) => f.key)).toEqual(['hub_only']);
  });

  it('sends a change to the app, attributed to the console viewer', async () => {
    const res = await fetch(`${base}/flags/new_editor/rollout?app=et`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ percent: 30 }),
    });
    expect(res.status).toBe(200);
    const [entry] = await et.store!.audit({ entity: 'flag', key: 'new_editor' });
    expect(entry?.actor).toEqual({ id: 'ops-1', name: 'Ops' });
    // Not written in the hub's own store.
    const hubRuntime = (await hub.container.make('flags.runtime')) as FlagsRuntime;
    expect((await hubRuntime.store!.readRuleset('production')).flags.new_editor).toBeUndefined();
  });

  it('hides a federated app the viewer may not see', async () => {
    viewerApps = ['someone-else'];
    try {
      const apps = (await (await fetch(`${base}/apps`)).json()) as { apps: unknown[] };
      expect(apps.apps).toEqual([]);
      expect((await fetch(`${base}/flags?app=et`)).status).toBe(403);
    } finally {
      viewerApps = '*';
    }
  });
});

describe('consoleCommands in config/flags.ts', () => {
  it('makes the app answer another console over its Redis connection', async () => {
    const redis = new FakePubSubRedis();
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: {
          flags: defineConfig({
            app: 'entre-textos',
            flags: { new_editor: flag.boolean({ default: false }) },
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            dispatcher: 'in-process',
            consoleCommands: { prefix: 'entretextos', secret: SECRET },
          }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    const app = ignitor.createApp('web') as ApplicationService;
    await app.init();
    // An `@adonisjs/redis` manager: the provider takes the connection's ioredis client.
    app.container.singleton(
      'redis' as never,
      () => ({ connection: () => ({ ioConnection: redis }) }) as never,
    );
    await app.boot();
    await app.start(() => {});
    const channel = new RedisConsoleChannel({
      client: redis,
      prefix: 'entretextos',
      secret: SECRET,
    });
    try {
      const reply = await channel.send(
        { id: 'c1', verb: 'profile', args: [], capabilities: ['flags:console:read'] },
        { timeoutMs: 2000 },
      );
      expect(reply).toMatchObject({
        ok: true,
        // Changes are opt-in (`actions: true`): this app only answers reads.
        data: { app: 'entre-textos', environment: 'production', actions: false },
      });
    } finally {
      await channel.close();
      await app.terminate();
    }
    // Once the app stopped, nobody answers: the command fails fast.
    const after = new RedisConsoleChannel({ client: redis, prefix: 'entretextos', secret: SECRET });
    await expect(
      after.send({ id: 'c2', verb: 'profile', args: [], capabilities: ['flags:console:read'] }),
    ).rejects.toThrow(/listens/);
    await after.close();
  });

  async function boot(consoleCommands: Record<string, unknown>, redis: FakePubSubRedis) {
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: {
          flags: defineConfig({
            app: 'entre-textos',
            flags: { new_editor: flag.boolean({ default: false }) },
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            dispatcher: 'in-process',
            consoleCommands: { prefix: 'entretextos', ...consoleCommands },
          } as never),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    const app = ignitor.createApp('web') as ApplicationService;
    await app.init();
    app.container.singleton(
      'redis' as never,
      () => ({ connection: () => ({ ioConnection: redis }) }) as never,
    );
    await app.boot();
    await app.start(() => {});
    return app;
  }

  it('fails the boot without authentication (no crypto, verifyTenant or secret)', async () => {
    await expect(boot({ actions: true }, new FakePubSubRedis())).rejects.toThrow(
      /consoleCommands needs authentication: install and boot @adonis-agora\/crypto.*consoleCommands\.secret.*consoleCommands\.verifyTenant/,
    );
  });

  it('token mode: the app seals to its APP_KEY-derived key, given to the console', async () => {
    const redis = new FakePubSubRedis();
    const previous = process.env.APP_KEY;
    // Unless config/app.ts or config/encryption.ts has one, the provider reads APP_KEY.
    if (!releaseSecret(previous)) process.env.APP_KEY = 'app-key-of-entre-textos-0123456789';
    const app = await boot(
      {
        actions: true,
        verifyTenant: ({ token }: { token?: string }) =>
          token === 'hub' ? { partition: 'entre-textos', capabilities: ['flags:console:*'] } : null,
      },
      redis,
    );
    // What `node ace flags:console-key` prints in that app.
    const appKey = releaseSecret(await appKeyOf(app))!;
    const publicKey = consoleCommandKeys(appKey, 'entretextos').publicKey;
    const channel = new RedisConsoleChannel({
      client: redis,
      prefix: 'entretextos',
      token: 'hub',
      recipient: async () => publicKey,
    });
    try {
      const reply = await channel.send(
        { id: 'c1', verb: 'profile', args: [], capabilities: ['flags:console:read'] },
        { timeoutMs: 2000 },
      );
      expect(reply).toMatchObject({ ok: true, data: { app: 'entre-textos', actions: true } });
    } finally {
      await channel.close();
      await app.terminate();
      if (previous === undefined) delete process.env.APP_KEY;
      else process.env.APP_KEY = previous;
    }
  });
});
