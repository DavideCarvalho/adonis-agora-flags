import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig as defineDashboardConfig } from '../../src/dashboard/define_config.js';
import { flag } from '../../src/declare.js';
import { defineConfig, stores, transports } from '../../src/define_config.js';

/**
 * The console mounted in a real AdonisJS HTTP server, from the built package: routes, the SPA shell with its JSON config
 * block, and the JSON API end to end (no handler stubs).
 */
describe('console over HTTP', () => {
  let app: ApplicationService;
  let http: Server;
  let base: string;

  beforeAll(async () => {
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: {
          providers: [
            // The built package: the SPA lives in dist/assets/spa (copied by the build), exactly
            // where a published install finds it. `pnpm test` builds first.
            () => import('../../dist/providers/flags_provider.js'),
            () => import('../../dist/providers/dashboard_provider.js'),
          ],
        },
        config: {
          flags: defineConfig({
            flags: { new_player: flag.boolean({ default: false, owner: 'video' }) },
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            dispatcher: 'in-process',
          }),
          flags_dashboard: defineDashboardConfig({ authorize: () => true }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('web') as ApplicationService;
    await app.init();
    await app.boot();
    const server = await app.container.make('server');
    server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
    await server.boot();
    http = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => http.close(resolve));
    await app.terminate();
  });

  it('serves the SPA shell with its config in a JSON data block (no inline script)', async () => {
    const response = await fetch(`${base}/flags`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('type="application/json"');
    expect(html).not.toMatch(/<script>(?!\s*<\/script>)[^<]+<\/script>/);
    const asset = /src="([^"]+\.js)"/.exec(html)?.[1];
    expect(asset).toBeDefined();
    expect((await fetch(new URL(asset!, `${base}/flags/`))).status).toBe(200);
  });

  it('lists declared flags and applies a change through the API', async () => {
    const list = await fetch(`${base}/flags/api/flags`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { data: Array<{ key: string }> };
    expect(body.data.map((f) => f.key)).toContain('new_player');

    const change = await fetch(`${base}/flags/api/flags/new_player/rollout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ percent: 100 }),
    });
    expect(change.status).toBeLessThan(300);
    const runtime = (await app.container.make('flags.runtime')) as {
      manager: {
        refresh(): Promise<boolean>;
        for(id: string): { enabled(k: string): Promise<boolean> };
      };
    };
    await runtime.manager.refresh();
    expect(await runtime.manager.for('u1').enabled('new_player')).toBe(true);
  });

  it('creates a flag without code and serves its default right away', async () => {
    const created = await fetch(`${base}/flags/api/flags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'promo_banner',
        declaration: { type: 'string', default: 'off', variants: ['off', 'blue'], client: true },
      }),
    });
    expect(created.status).toBe(201);
    const list = (await (await fetch(`${base}/flags/api/flags`)).json()) as {
      data: Array<{ key: string; declaration: { source: string } | null }>;
    };
    expect(list.data.find((f) => f.key === 'promo_banner')?.declaration?.source).toBe('console');
    const runtime = (await app.container.make('flags.runtime')) as {
      manager: { refresh(): Promise<boolean>; for(id: string): { all(): Promise<unknown> } };
    };
    await runtime.manager.refresh();
    expect(await runtime.manager.for('u1').all()).toEqual({ promo_banner: 'off' });

    const details = await fetch(`${base}/flags/api/flags/promo_banner/declaration`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ declaration: { owner: 'growth' } }),
    });
    expect(details.status).toBe(200);
    const bad = await fetch(`${base}/flags/api/flags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'x', declaration: { type: 'number', default: 'nope' } }),
    });
    expect(bad.status).toBe(422);
  });
});
