import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { metric } from '../../src/analytics/metrics.js';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { exposureId } from '../../src/events/event.js';
import { Relay } from '../../src/relay/relay.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import {
  createFlagsTables,
  ensureEventPartitions,
  eventsArePartitioned,
  pruneEvents,
} from '../../src/schema.js';
import { MemorySink } from '../../src/sinks/sink.js';
import { inSchema, query } from '../../src/sql.js';
import { DbTransport } from '../../src/transports/db_transport.js';
import { postgresDb, quietLogger, type TestDb } from '../helpers.js';

const event = (i: number) => ({
  id: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
  schemaVersion: 1,
  app: 'shop',
  environment: 'production',
  type: 'track' as const,
  name: 'purchase',
  subject: `u${i}`,
  subjectType: 'user',
  value: i,
  ts: Date.now(),
});

describe('Postgres', () => {
  let db: TestDb;
  let runtime: FlagsRuntime | undefined;

  beforeEach(async (context) => {
    db = await postgresDb(`flags_${context.task.id.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`);
  });

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
    await db.close();
  });

  it('creates the schema idempotently, even from concurrent boots', async () => {
    await Promise.all([
      createFlagsTables(db.db),
      createFlagsTables(db.db),
      createFlagsTables(db.db),
    ]);
    await createFlagsTables(db.db);
    const tables = await query<{ n: string }>(
      db.db,
      "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'flags_%'",
    );
    expect(Number(tables[0]!.n)).toBe(12);
  });

  it('keeps every table in the configured schema, with no search_path involved', async () => {
    const own = `${db.schema}_own`;
    const count = async (schema: string) =>
      Number(
        (
          await query<{ n: string }>(
            db.db,
            "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name LIKE 'flags_%'",
            [schema],
          )
        )[0]!.n,
      );
    const config = defineConfig({
      app: 'shop',
      flags: { new_player: flag.boolean({ default: false }) },
      sinks: { warehouse: sinks.lucid() },
      refresh: { intervalMs: 60_000 },
      schema: own,
    });
    try {
      runtime = await createRuntime(config, lucidContext(db.database as never), {
        logger: quietLogger,
      });
      expect(await count(own)).toBe(12);
      // The connection's own schema (its search_path) stays empty.
      expect(await count(db.schema)).toBe(0);

      const other = await createRuntime(config, lucidContext(db.database as never), {
        logger: quietLogger,
      });
      try {
        expect(other.source.status().mode).toBe('notify');
        await runtime.admin!.turnOn('new_player', { id: 'alice' });
        await vi.waitFor(async () =>
          expect(await other.manager.for('u1').enabled('new_player')).toBe(true),
        );
      } finally {
        await other.close();
      }

      // An event written inside the app's own transaction lands in the schema too.
      await db.database.transaction(async (trx) => {
        await runtime!.manager.track('u1', 'purchase', { value: 10, client: trx as never });
      });
      await runtime.buffer!.flush();
      await runtime.relay!.drain('warehouse', 100);
      const tracks = await query<{ n: string }>(
        db.db,
        `SELECT COUNT(*) AS n FROM "${own}".flags_tracks`,
      );
      expect(Number(tracks[0]!.n)).toBe(1);
      const audit = await runtime.store!.audit({ key: 'new_player' });
      expect(audit).toHaveLength(1);
    } finally {
      await runtime?.close();
      runtime = undefined;
      await db.db.rawQuery(`DROP SCHEMA IF EXISTS "${own}" CASCADE`);
    }
  });

  it('partitions and prunes the event log inside the configured schema', async () => {
    const own = `${db.schema}_own`;
    try {
      await createFlagsTables(db.db, { partitionEvents: true, schema: own });
      const client = inSchema(db.db, own);
      expect(await eventsArePartitioned(client)).toBe(true);
      const transport = new DbTransport(client, { autoCreateSchema: false });
      const old = Date.UTC(2020, 0, 15);
      await ensureEventPartitions(client, old);
      await transport.publish([{ ...event(1), ts: old }]);
      await transport.publish([event(2)]);
      const parts = await query<{ n: string }>(
        db.db,
        "SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = ? AND tablename LIKE 'flags_events_%'",
        [own],
      );
      expect(Number(parts[0]!.n)).toBeGreaterThanOrEqual(4);
      const all = await query<{ id: string }>(client, 'SELECT id FROM flags_events ORDER BY id');
      const result = await pruneEvents(client, Date.UTC(2021, 0, 1), Number(all.at(-1)!.id));
      expect(result.partitions).toBeGreaterThanOrEqual(1);
      const left = await query<{ subject: string }>(client, 'SELECT subject FROM flags_events');
      expect(left.map((r) => r.subject)).toEqual(['u2']);
    } finally {
      await db.db.rawQuery(`DROP SCHEMA IF EXISTS "${own}" CASCADE`);
    }
  });

  it('propagates changes to another process through LISTEN/NOTIFY, faster than the poll', async () => {
    const config = defineConfig({
      flags: { new_player: flag.boolean({ default: false }) },
      refresh: { intervalMs: 60_000 },
    });
    runtime = await createRuntime(config, lucidContext(db.database as never), {
      logger: quietLogger,
    });
    const other = await createRuntime(config, lucidContext(db.database as never), {
      logger: quietLogger,
    });
    try {
      expect(other.source.status().mode).toBe('notify');
      await runtime.admin!.turnOn('new_player', { id: 'alice' });
      const deadline = Date.now() + 5000;
      while (
        Date.now() < deadline &&
        !(await other.manager.for(`u${Date.now()}`).enabled('new_player'))
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await other.manager.for('u1').enabled('new_player')).toBe(true);
    } finally {
      await other.close();
    }
  });

  it('holds no LISTEN connection in ace commands, so Lucid can close its pool', async () => {
    runtime = await createRuntime(
      defineConfig({ flags: { new_player: flag.boolean({ default: false }) } }),
      lucidContext(db.database as never),
      { logger: quietLogger, listen: false },
    );
    expect(runtime.source.status().mode).toBe('poll');
    const knex = (
      db.database as unknown as {
        connection(): { getWriteClient(): { client: { pool: { numUsed(): number } } } };
      }
    )
      .connection()
      .getWriteClient();
    // `node ace migration:run` ends with db.manager.closeAll(), which waits for every used
    // connection: with a LISTEN held here it never returned.
    expect(knex.client.pool.numUsed()).toBe(0);
  });

  it('never skips an event committed late by a slow transaction', async () => {
    await createFlagsTables(db.db);
    const transport = new DbTransport(db.db, { autoCreateSchema: false });
    const sink = new MemorySink();
    const relay = new Relay(transport, new Map([['s', sink]]), { batchSize: 100 });

    // A transaction takes an id and stays open…
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = db.database.transaction(async (trx) => {
      await transport.publish([event(1)], { client: trx as never });
      await held;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // …while later ones commit and get relayed.
    await transport.publish([event(2), event(3)]);
    await relay.drain('s');
    expect(sink.events.map((e) => e.subject)).toEqual([]);

    release();
    await slow;
    await relay.drain('s');
    expect(sink.events.map((e) => e.subject).sort()).toEqual(['u1', 'u2', 'u3']);
  });

  it('lets one relay per sink deliver at a time, and every event exactly once into the sink', async () => {
    await createFlagsTables(db.db);
    const transport = new DbTransport(db.db, { autoCreateSchema: false });
    await transport.publish(Array.from({ length: 2000 }, (_, i) => event(i)));
    const sink = new MemorySink();
    const sinks = new Map([['s', sink]]);
    const relays = Array.from({ length: 4 }, () => new Relay(transport, sinks, { batchSize: 250 }));
    for (let round = 0; round < 10; round++) await Promise.all(relays.map((r) => r.drain('s')));
    expect(sink.events).toHaveLength(2000);
    const status = await transport.status(['s']);
    expect(status[0]).toMatchObject({ delivered: 2000, lastError: null });
  });

  it('partitions the event log by month and prunes whole partitions', async () => {
    await createFlagsTables(db.db, { partitionEvents: true });
    expect(await eventsArePartitioned(db.db)).toBe(true);
    const transport = new DbTransport(db.db, { autoCreateSchema: false });
    const old = Date.UTC(2020, 0, 15);
    await ensureEventPartitions(db.db, old);
    await transport.publish([{ ...event(1), ts: old }]);
    await transport.publish([event(2)]);
    const all = await query<{ id: string }>(db.db, 'SELECT id FROM flags_events ORDER BY id');
    const result = await pruneEvents(db.db, Date.UTC(2021, 0, 1), Number(all.at(-1)!.id));
    expect(result.partitions).toBeGreaterThanOrEqual(1);
    const left = await query<{ subject: string }>(db.db, 'SELECT subject FROM flags_events');
    expect(left.map((r) => r.subject)).toEqual(['u2']);
  });

  it('runs a whole experiment: exposures, tracks inside business transactions, CUPED results', async () => {
    runtime = await createRuntime(
      defineConfig({
        app: 'shop',
        environment: 'production',
        flags: { checkout: flag.string({ default: 'control', variants: ['control', 'b'] }) },
        sinks: { warehouse: sinks.lucid() },
        metrics: { revenue: metric.sum('purchase', { cupedMs: 30 * 86_400_000 }) },
        experiments: { checkout: { metrics: ['revenue'] } },
        sticky: true,
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
            { variant: 'control', weight: 50 },
            { variant: 'b', weight: 50 },
          ],
        },
        experiment: {},
      },
      { id: 'alice' },
    );
    await runtime.manager.refresh();
    // Pre-period purchases (CUPED covariate): heavy buyers stay heavy buyers.
    for (let i = 0; i < 300; i++) {
      await runtime.manager.track(`u${i}`, 'purchase', { value: (i % 7) * 10 });
    }
    await runtime.buffer!.flush();
    await runtime.relay!.drain('warehouse', 100);
    // Backdate them so they fall before exposure.
    await db.database.rawQuery('UPDATE flags_tracks SET ts = ts - 86400000');
    for (let i = 0; i < 300; i++) {
      const variant = await runtime.manager.for(`u${i}`).variant('checkout');
      await db.database.transaction(async (trx) => {
        await runtime!.manager.track(`u${i}`, 'purchase', {
          value: (i % 7) * 10 + (variant === 'b' ? 5 : 0),
          client: trx as never,
        });
      });
    }
    await runtime.buffer!.flush();
    await runtime.relay!.drain('warehouse', 100);
    const results = (await runtime.worker!.computeResults('checkout'))!;
    const comparison = results.metrics[0]!.comparisons[0]!;
    expect(comparison.test).toBe('cuped');
    expect(comparison.varianceReduction).toBeGreaterThan(0.9);
    expect(comparison.verdict).toBe('better');

    // Sticky: the subject keeps the variant recorded at first exposure after weights change.
    const before = await runtime.manager.for('u7').variant('checkout');
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
          bucketBy: 'other',
        },
        experiment: {},
      },
      { id: 'alice' },
    );
    await runtime.manager.refresh();
    const after = await runtime.manager.for('u7', { other: 'reshuffled' }).details('checkout');
    expect(after.variant).toBe(before);
    expect(after.flagMetadata.sticky).toBe(true);
    const exposures = await query<{ n: string }>(
      db.db,
      'SELECT COUNT(*) AS n FROM flags_exposures WHERE experiment = ?',
      ['checkout'],
    );
    expect(Number(exposures[0]!.n)).toBe(300);
    expect(exposureId('shop', 'production', 'checkout', 'u7')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
