import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { verifiers } from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';

const declarations = {
  new_player: flag.boolean({ default: false }),
  checkout: flag.string({ default: 'control', variants: ['control', 'b'] }),
};

describe('control-plane and tenant', () => {
  let db: TestDb;
  let cp: FlagsRuntime;
  let tenant: FlagsRuntime;
  let server: Server;
  let base: string;
  let snapshotDir: string;

  beforeEach(async () => {
    db = await sqliteDb();
    cp = await createRuntime(
      defineConfig({
        topology: 'control-plane',
        flags: declarations,
        sinks: { warehouse: sinks.lucid() },
        controlPlane: {
          verifyTenant: verifiers.sharedSecret({
            shop: 's3cret',
            reader: { secret: 'r', capabilities: ['flags:ruleset:read'] },
          }),
        },
      }),
      lucidContext(db.database as never),
      { logger: quietLogger },
    );
    const plane = new ControlPlane(cp, (cp.config as { controlPlane: never }).controlPlane);
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
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    snapshotDir = mkdtempSync(join(tmpdir(), 'flags-snap-'));
  });

  afterEach(async () => {
    await tenant?.close();
    await cp.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
    rmSync(snapshotDir, { recursive: true, force: true });
  });

  const startTenant = (token = 's3cret', url = `${base}/_flags`) =>
    createRuntime(
      defineConfig({
        topology: 'tenant',
        flags: declarations,
        tenant: {
          url,
          token,
          partition: 'shop',
          snapshotPath: join(snapshotDir, 'ruleset.json'),
          intervalMs: 60_000,
        },
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );

  it('serves the ruleset, pushes changes over SSE and ingests events', async () => {
    await cp.admin!.turnOn('new_player', { id: 'alice' });
    await cp.manager.refresh();
    tenant = await startTenant();
    expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);

    // A change on the control-plane reaches the tenant through the stream, without polling.
    await new Promise((resolve) => setTimeout(resolve, 150));
    await cp.admin!.turnOff('new_player', { id: 'alice' });
    await cp.manager.refresh();
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      (await tenant.manager.for(`u${Date.now()}`).enabled('new_player'))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await tenant.manager.for('u2').enabled('new_player')).toBe(false);
    expect(tenant.source.status().mode).toBe('stream');

    // Snapshot written for cold starts.
    expect(
      JSON.parse(readFileSync(join(snapshotDir, 'ruleset.json'), 'utf8')).flags.new_player,
    ).toBeDefined();

    // Events: the tenant's app name comes from its token, and they reach the control-plane's sinks.
    await tenant.manager.track('u1', 'purchase', { value: 10 });
    await tenant.buffer!.flush();
    await cp.relay!.drain('warehouse');
    const rows = (await db.database.rawQuery(
      'SELECT app, environment, name FROM flags_tracks',
    )) as Array<{
      app: string;
      name: string;
    }>;
    expect(rows).toEqual([{ app: 'shop', environment: 'production', name: 'purchase' }]);

    // Declarations were pushed at boot.
    const declared = await cp.store!.declarations('shop');
    expect(declared.map((d) => d.key).sort()).toEqual(['checkout', 'new_player']);
  });

  it('rejects bad tokens and missing scopes', async () => {
    const ruleset = await fetch(`${base}/_flags/v1/ruleset`, {
      headers: { authorization: 'Bearer nope', 'x-flags-tenant': 'shop' },
    });
    expect(ruleset.status).toBe(401);
    const events = await fetch(`${base}/_flags/v1/events`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer r',
        'x-flags-tenant': 'reader',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: [] }),
    });
    expect(events.status).toBe(403);
  });

  it('answers 304 for an unchanged ruleset', async () => {
    const headers = { authorization: 'Bearer s3cret', 'x-flags-tenant': 'shop' };
    const first = await fetch(`${base}/_flags/v1/ruleset`, { headers });
    const etag = first.headers.get('etag')!;
    const second = await fetch(`${base}/_flags/v1/ruleset`, {
      headers: { ...headers, 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('boots from the snapshot when the control-plane is down', async () => {
    await cp.admin!.turnOn('new_player', { id: 'alice' });
    await cp.manager.refresh();
    tenant = await startTenant();
    // The snapshot is written asynchronously after the first fetch: wait for it, not for a fixed time.
    const snapshot = join(snapshotDir, 'ruleset.json');
    const deadline = Date.now() + 5000;
    while (!existsSync(snapshot) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await tenant.close();
    tenant = await startTenant('s3cret', 'http://127.0.0.1:1/_flags');
    expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);
    expect(tenant.source.status().lastError).not.toBeNull();
  });

  it('speaks OFREP', async () => {
    await cp.admin!.turnOn('new_player', { id: 'alice' });
    await cp.manager.refresh();
    const headers = {
      authorization: 'Bearer s3cret',
      'x-flags-tenant': 'shop',
      'content-type': 'application/json',
    };
    const one = await fetch(`${base}/ofrep/v1/evaluate/flags/new_player`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: { targetingKey: 'u1' } }),
    });
    expect(await one.json()).toMatchObject({
      key: 'new_player',
      value: true,
      variant: 'on',
      reason: 'STATIC',
    });
    const missing = await fetch(`${base}/ofrep/v1/evaluate/flags/ghost`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ key: 'ghost', errorCode: 'FLAG_NOT_FOUND' });
    const bulk = await fetch(`${base}/ofrep/v1/evaluate/flags`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ context: { targetingKey: 'u1' } }),
    });
    const etag = bulk.headers.get('etag')!;
    expect((await bulk.json()).flags).toEqual([
      expect.objectContaining({ key: 'new_player', value: true }),
    ]);
    const again = await fetch(`${base}/ofrep/v1/evaluate/flags`, {
      method: 'POST',
      headers: { ...headers, 'if-none-match': etag },
      body: JSON.stringify({ context: { targetingKey: 'u1' } }),
    });
    expect(again.status).toBe(304);
  });
});
