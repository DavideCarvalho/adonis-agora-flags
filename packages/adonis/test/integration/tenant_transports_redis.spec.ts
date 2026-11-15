import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import type { MemorySink } from '../../src/sinks/sink.js';
import { tenantTransports } from '../../src/tenant_transports/index.js';
import { createMessage, type DeadLetter } from '../../src/tenant_transports/message.js';
import { redisKeys } from '../../src/tenant_transports/redis.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const declarations = { new_player: flag.boolean({ default: false }) };

async function until(check: () => Promise<boolean> | boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

describe('tenant transport over a real Redis', () => {
  let redis: Redis;
  let db: TestDb;
  let cp: FlagsRuntime;
  let plane: ControlPlane;
  let tenant: FlagsRuntime;
  const prefix = `flags-it-${Date.now()}`;
  const letters: DeadLetter[] = [];

  beforeAll(async () => {
    redis = new Redis(process.env.FLAGS_TEST_REDIS_URL!);
    db = await sqliteDb();
    cp = await createRuntime(
      defineConfig({
        topology: 'control-plane',
        flags: declarations,
        sinks: { mem: sinks.memory() },
        verifyTenant: sharedSecretVerifier({ partitions: { shop: 's3cret' } }),
      }),
      lucidContext(db.database as never),
      { logger: quietLogger },
    );
    plane = new ControlPlane(cp, {
      verifyTenant: (cp.config as { verifyTenant: never }).verifyTenant,
      transports: [tenantTransports.redis({ client: redis, prefix })],
      onDeadLetter: (letter) => void letters.push(letter),
    });
    await plane.serveTransports({ redis: async () => redis });
    await cp.admin!.turnOn('new_player', { id: 'alice' });
    await cp.manager.refresh();
    tenant = await createRuntime(
      defineConfig({
        topology: 'tenant',
        flags: declarations,
        tenant: {
          token: 's3cret',
          partition: 'shop',
          transport: tenantTransports.redis({ client: redis, prefix }),
          intervalMs: 60_000,
        },
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );
  });

  afterAll(async () => {
    await tenant?.close();
    await plane?.close();
    await cp?.close();
    await db?.close();
    await redis.quit();
  });

  it('serves the ruleset and pushes changes over pub/sub', async () => {
    expect(await tenant.manager.for('u1').enabled('new_player')).toBe(true);
    await until(() => tenant.source.status().mode === 'stream');
    await cp.admin!.turnOff('new_player', { id: 'alice' });
    await cp.manager.refresh();
    await until(async () => !(await tenant.manager.for('u2').enabled('new_player')));
  });

  it('ingests events through the stream with the app from the token', async () => {
    await tenant.manager.track('u1', 'purchase');
    await tenant.buffer!.flush();
    await until(async () => {
      await cp.relay!.drain('mem');
      return (cp.sinks.get('mem') as MemorySink).events.some((e) => e.type === 'track');
    });
    const track = (cp.sinks.get('mem') as MemorySink).events.find((e) => e.type === 'track');
    expect(track).toMatchObject({ app: 'shop', name: 'purchase' });
  });

  it('dead-letters a forged message', async () => {
    const keys = redisKeys(prefix);
    await redis.xadd(
      keys.inbox,
      '*',
      'm',
      JSON.stringify(createMessage('events', 'shop', 'forged', { events: [] })),
    );
    await until(() => letters.length === 1);
    expect(letters[0]!.reason).toBe('unauthorized');
    expect(await redis.xlen(keys.dead)).toBe(1);
  });
});
