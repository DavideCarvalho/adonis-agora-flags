import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, stores, transports } from '../../src/define_config.js';
import FlagMiddleware from '../../src/http/flag_middleware.js';
import FlagsMiddleware from '../../src/http/flags_middleware.js';
import type { FlagsManager } from '../../src/manager.js';
import type { FlagsRuntime } from '../../src/runtime.js';
import { hasRuntime } from '../../src/services/accessor.js';

const BASE_URL = new URL('./tmp/', import.meta.url);

async function bootApp() {
  const ignitor = new IgnitorFactory()
    .merge({
      rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
      config: {
        flags: defineConfig({
          app: 'shop',
          flags: {
            new_player: flag.boolean({ default: false, client: true }),
            beta_page: flag.boolean({ default: false }),
          },
          store: stores.memory({ production: { flags: {} } }),
          transport: transports.memory(),
          dispatcher: 'in-process',
        }),
      },
    })
    .withCoreConfig()
    .withCoreProviders()
    .create(BASE_URL);
  const app = ignitor.createApp('web');
  await app.init();
  await app.boot();
  return app as ApplicationService;
}

function fakeCtx(user?: { id: string }) {
  let status = 200;
  let body: unknown;
  const shared: Record<string, unknown> = {};
  const ctx = {
    auth: user ? { user } : undefined,
    view: { share: (data: Record<string, unknown>) => Object.assign(shared, data) },
    response: {
      status(code: number) {
        status = code;
        return ctx.response;
      },
      send(value: unknown) {
        body = value;
      },
    },
  } as Record<string, unknown>;
  return { ctx, shared, result: () => ({ status, body }) };
}

describe('provider', () => {
  let app: ApplicationService | undefined;

  afterEach(async () => {
    await app?.terminate();
    app = undefined;
  });

  it('boots the runtime, binds it and serves ctx.flags', async () => {
    app = await bootApp();
    const manager = (await app.container.make('flags.manager')) as FlagsManager;
    const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
    expect(runtime.manager).toBe(manager);
    expect(hasRuntime()).toBe(true);

    await runtime.admin!.turnOn('new_player', { id: 'test' });
    await manager.refresh();

    const { ctx, shared } = fakeCtx({ id: 'u1' });
    await new FlagsMiddleware().handle(ctx as never, async () => {});
    const flags = (
      ctx as { flags: { enabled(key: string): Promise<boolean>; all(): Promise<unknown> } }
    ).flags;
    expect(await flags.enabled('new_player')).toBe(true);
    expect(await flags.all()).toEqual({ new_player: true });
    expect(shared.flags).toBe(flags);
  });

  it('guards routes with the flag middleware (404 when off)', async () => {
    app = await bootApp();
    const blocked = fakeCtx({ id: 'u1' });
    let reached = false;
    await new FlagMiddleware().handle(
      blocked.ctx as never,
      async () => {
        reached = true;
      },
      { flag: 'beta_page' },
    );
    expect(reached).toBe(false);
    expect(blocked.result().status).toBe(404);

    const runtime = (await app.container.make('flags.runtime')) as FlagsRuntime;
    await runtime.admin!.turnOn('beta_page', { id: 'test' });
    await runtime.manager.refresh();
    const open = fakeCtx({ id: 'u1' });
    await new FlagMiddleware().handle(
      open.ctx as never,
      async () => {
        reached = true;
      },
      { flag: 'beta_page' },
    );
    expect(reached).toBe(true);
  });

  it('closes the runtime on shutdown', async () => {
    app = await bootApp();
    await app.container.make('flags.manager');
    await app.terminate();
    app = undefined;
    expect(hasRuntime()).toBe(false);
  });
});
