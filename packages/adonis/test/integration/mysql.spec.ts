import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { metric } from '../../src/analytics/metrics.js';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { Relay } from '../../src/relay/relay.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { createFlagsTables } from '../../src/schema.js';
import { MemorySink } from '../../src/sinks/sink.js';
import { query } from '../../src/sql.js';
import { DbTransport } from '../../src/transports/db_transport.js';
import { mysqlDb, quietLogger, type TestDb } from '../helpers.js';

describe('MySQL', () => {
  let db: TestDb;
  let runtime: FlagsRuntime | undefined;

  beforeEach(async (context) => {
    db = await mysqlDb(`flags_${context.task.id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await db.close();
  });

  it('creates the schema idempotently, even from concurrent boots', async () => {
    await Promise.all([createFlagsTables(db.db), createFlagsTables(db.db)]);
    await createFlagsTables(db.db);
    const tables = await query<{ n: number }>(
      db.db,
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'flags\\_%'",
    );
    expect(Number(tables[0]!.n)).toBe(12);
  });

  it('relays every event exactly once with concurrent relays', async () => {
    await createFlagsTables(db.db);
    const transport = new DbTransport(db.db, { autoCreateSchema: false, mysqlSafetyMs: 0 });
    const ts = Date.now() - 1000;
    await transport.publish(
      Array.from({ length: 600 }, (_, i) => ({
        id: `e${i}`,
        schemaVersion: 1,
        app: 'a',
        environment: 'production',
        type: 'track' as const,
        name: 'n',
        subject: `u${i}`,
        subjectType: 'user',
        ts,
      })),
    );
    const sink = new MemorySink();
    const relays = Array.from(
      { length: 3 },
      () => new Relay(transport, new Map([['s', sink]]), { batchSize: 100 }),
    );
    for (let round = 0; round < 10; round++) await Promise.all(relays.map((r) => r.drain('s')));
    expect(sink.events).toHaveLength(600);
  });

  it('holds back events younger than the safety window', async () => {
    await createFlagsTables(db.db);
    const transport = new DbTransport(db.db, { autoCreateSchema: false, mysqlSafetyMs: 60_000 });
    await transport.publish([
      {
        id: 'fresh',
        schemaVersion: 1,
        app: 'a',
        environment: 'production',
        type: 'track',
        name: 'n',
        subject: 'u',
        subjectType: 'user',
        ts: Date.now(),
      },
    ]);
    const sink = new MemorySink();
    await new Relay(transport, new Map([['s', sink]])).drain('s');
    expect(sink.events).toHaveLength(0);
  });

  it('runs the standalone flow: admin, audit, usage, exposures and results', async () => {
    runtime = await createRuntime(
      defineConfig({
        flags: { checkout: flag.string({ default: 'control', variants: ['control', 'b'] }) },
        sinks: { warehouse: sinks.lucid() },
        metrics: { purchase: metric.conversion('purchase') },
        experiments: { checkout: { metrics: ['purchase'] } },
        transport: async (ctx) => new DbTransport(await ctx.db(), { mysqlSafetyMs: 0 }),
      }),
      lucidContext(db.database as never),
      { logger: quietLogger },
    );
    await runtime.admin!.saveFlag(
      'checkout',
      {
        variants: { control: 'control', b: 'b' },
        enabled: true,
        offVariant: 'control',
        fallthrough: {
          split: [
            { variant: 'control', weight: 1 },
            { variant: 'b', weight: 1 },
          ],
        },
        experiment: {},
      },
      { id: 'alice' },
    );
    await runtime.manager.refresh();
    for (let i = 0; i < 100; i++) {
      const variant = await runtime.manager.for(`u${i}`).variant('checkout');
      if (variant === 'b' || i % 4 === 0) await runtime.manager.track(`u${i}`, 'purchase');
    }
    await runtime.buffer!.flush();
    await runtime.usage!.flush();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.relay!.drain('warehouse', 50);
    const results = (await runtime.worker!.computeResults('checkout'))!;
    expect(Object.values(results.exposures).reduce((a, b) => a + b, 0)).toBe(100);
    const audit = await runtime.store!.audit({ key: 'checkout' });
    expect(audit[0]).toMatchObject({ action: 'create', version: '1' });
    const usage = await runtime.store!.usage({ environment: 'production', since: '2000-01-01' });
    expect(usage.find((u) => u.flag === 'checkout')!.evaluations).toBe(100);
    await runtime.usage!.flush();
  });
});
