import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig } from '../../src/define_config.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { quietLogger } from '../helpers.js';

/**
 * A tenant that boots before its control plane answers still declares its flags: the publish is
 * retried until it lands (its browsers' client flags depend on it).
 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('tenant declarations', () => {
  it('are published again until the control plane takes them', async () => {
    let refusals = 2;
    const received: unknown[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        if (req.url?.endsWith('/v1/declarations')) {
          if (refusals > 0) {
            refusals -= 1;
            res.writeHead(503).end();
            return;
          }
          received.push(JSON.parse(body));
          res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        if (req.url?.endsWith('/v1/ruleset')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version: '1', flags: {} }));
          return;
        }
        res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_flags`;
    const runtime: FlagsRuntime = await createRuntime(
      defineConfig({
        topology: 'tenant',
        flags: { new_checkout: flag.boolean({ default: false, client: true }) },
        tenant: { url: base, token: 's3cret', partition: 'shop', stream: false },
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );
    cleanups.push(() => runtime.close());
    const until = Date.now() + 10_000;
    while (received.length === 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).toContain('new_checkout');
  }, 15_000);
});
