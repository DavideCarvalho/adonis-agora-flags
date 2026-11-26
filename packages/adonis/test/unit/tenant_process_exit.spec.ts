import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';

/**
 * §12: a tenant's long-lived connection to its control plane (the ruleset stream) is held only by
 * processes that serve. An ace command, the REPL or a console app fetches once and exits.
 */

interface FakeControlPlane {
  base: string;
  streams: ServerResponse[];
  fetches: number;
  close(): Promise<void>;
}

async function fakeControlPlane(): Promise<FakeControlPlane> {
  const state = { streams: [] as ServerResponse[], fetches: 0 };
  const server: Server = createServer((req, res) => {
    if (req.url?.endsWith('/v1/ruleset/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': hello\n\n');
      state.streams.push(res);
      return;
    }
    if (req.url?.endsWith('/v1/ruleset')) {
      state.fetches += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '1', flags: {} }));
      return;
    }
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/_flags`,
    get streams() {
      return state.streams;
    },
    get fetches() {
      return state.fetches;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function tenantApp(environment: 'console' | 'web', base: string) {
  const ignitor = new IgnitorFactory()
    .merge({
      rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
      config: {
        flags: defineConfig({
          topology: 'tenant',
          flags: {},
          tenant: { url: base, token: 's3cret', partition: 'shop' },
        }),
      },
    })
    .withCoreConfig()
    .withCoreProviders()
    .create(new URL('./tmp/', import.meta.url));
  const app = ignitor.createApp(environment) as ApplicationService;
  await app.init();
  await app.boot();
  return app;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

describe('§12 tenant clients never keep a process alive', () => {
  it('a console-environment tenant fetches the ruleset once, opens no stream, and terminates clean', async () => {
    const plane = await fakeControlPlane();
    cleanups.push(() => plane.close());
    const app = await tenantApp('console', plane.base);
    const runtime = (await app.container.make('flags.runtime')) as unknown as {
      source: { status(): { mode: string } };
    };
    await settle();
    expect(plane.fetches).toBe(1);
    expect(plane.streams).toHaveLength(0);
    await app.terminate();
    // The poll timer is unref'd and stopped: nothing from flags holds the event loop.
    await settle();
    expect(plane.streams).toHaveLength(0);
    expect(runtime.source.status().mode).toBe('poll');
  });

  it('a web server holds the stream, and terminating closes it', async () => {
    const plane = await fakeControlPlane();
    cleanups.push(() => plane.close());
    const app = await tenantApp('web', plane.base);
    await app.container.make('flags.runtime');
    await settle();
    expect(plane.streams).toHaveLength(1);
    const stream = plane.streams[0]!;
    const closed = new Promise<void>((resolve) => stream.on('close', () => resolve()));
    await app.terminate();
    await closed;
    expect(stream.destroyed || stream.writableEnded || stream.closed).toBe(true);
  });
});
