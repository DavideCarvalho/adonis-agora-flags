import { AppFactory } from '@adonisjs/core/factories/app';
import { drivers, fixedBackoff, QueueManager } from '@adonisjs/queue';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as h from '../../src/dashboard/handlers.js';
import { flag } from '../../src/declare.js';
import type { FlagEvent } from '../../src/events/event.js';
import { defineConfig, sinks, stores, transports } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { setRuntime } from '../../src/services/accessor.js';
import { MemorySink } from '../../src/sinks/sink.js';
import { type DeliveryPayload, QueueTransport } from '../../src/transports/queue_transport.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const event = (i: number): FlagEvent => ({
  id: `e${i}`,
  schemaVersion: 1,
  app: 'shop',
  environment: 'production',
  type: 'track',
  name: 'purchase',
  subject: `u${i}`,
  subjectType: 'user',
  ts: Date.now(),
});

/** The sync adapter (jobs run inline, retries too), as `drivers.sync()` in config/queue.ts. */
const sync = () => drivers.sync().resolver(undefined as never);

const declarations = { checkout: flag.boolean({ default: false }) };

describe('queue transport (@adonisjs/queue)', () => {
  afterEach(async () => {
    QueueManager.restore();
    await QueueManager.destroy();
  });

  it('dispatches one job per batch per sink', async () => {
    await QueueManager.init({ default: 'sync', adapters: { sync: await sync() } });
    using fake = QueueManager.fake();
    const transport = new QueueTransport({ queue: 'flags', batchSize: 2 });
    await transport.setup();
    transport.attachSinks(
      new Map([
        ['warehouse', new MemorySink()],
        ['posthog', new MemorySink()],
      ]),
    );
    await transport.publish([event(1), event(2), event(3)]);

    fake.assertPushedCount(4);
    const pushed = fake.getPushedJobs().map((record) => {
      const payload = record.job.payload as DeliveryPayload;
      return [record.job.name, record.queue, payload.sink, payload.events.map((e) => e.id)];
    });
    expect(pushed).toEqual([
      ['agora_flags_deliver', 'flags', 'warehouse', ['e1', 'e2']],
      ['agora_flags_deliver', 'flags', 'warehouse', ['e3']],
      ['agora_flags_deliver', 'flags', 'posthog', ['e1', 'e2']],
      ['agora_flags_deliver', 'flags', 'posthog', ['e3']],
    ]);
  });

  it('delivers through the worker: each sink retries on its own', async () => {
    let calls = 0;
    const flaky: FlagEvent[] = [];
    const warehouse = new MemorySink();
    // As @adonisjs/queue wires it: jobs are built by the app container, and the transport finds
    // the queue manager there. The sync adapter runs jobs (and their retries) inline.
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    const built: string[] = [];
    await QueueManager.init({
      default: 'sync',
      adapters: { sync: await sync() },
      jobFactory: (JobClass) => {
        built.push((JobClass as { options?: { name?: string } }).options?.name ?? '');
        return app.container.make(JobClass as never);
      },
    });
    app.container.singleton('queue.manager' as never, async () => QueueManager as never);
    const runtime = await createRuntime(
      defineConfig({
        app: 'shop',
        flags: declarations,
        store: stores.memory(),
        transport: transports.queue({ backoff: fixedBackoff(1) }),
        sinks: {
          warehouse: () => warehouse,
          flaky: sinks.callback(async (events) => {
            calls++;
            if (calls === 1) throw new Error('flaky is down');
            flaky.push(...events);
          }),
        },
      }),
      lucidContext(undefined, { app: app as never }),
      { logger: quietLogger, runWorker: false, start: false },
    );
    try {
      expect(runtime.relay).toBeUndefined();
      expect(runtime.transport?.capabilities).toEqual({ transactional: false, durable: true });
      expect(runtime.transport?.rewind).toBeUndefined();

      await runtime.manager.track('u1', 'purchase');
      await runtime.buffer!.flush();

      expect(warehouse.events.map((e) => e.name)).toEqual(['purchase']);
      expect(calls).toBe(2);
      expect(flaky.map((e) => e.name)).toEqual(['purchase']);
      expect(built).toEqual(['agora_flags_deliver', 'agora_flags_deliver', 'agora_flags_deliver']);
    } finally {
      await runtime.close();
    }
  });

  it('refuses to boot when @adonisjs/queue is not configured in the app', async () => {
    const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    await expect(
      transports.queue()(lucidContext(undefined, { app: app as never })),
    ).rejects.toThrow(/needs @adonisjs\/queue configured/);
  });

  it('gives up after maxRetries and reports it', async () => {
    await QueueManager.init({ default: 'sync', adapters: { sync: await sync() } });
    const errors: string[] = [];
    let calls = 0;
    const transport = new QueueTransport(
      { maxRetries: 2, backoff: fixedBackoff(1), jobName: 'flags_give_up' },
      { warn: () => {}, error: (message) => errors.push(message) },
    );
    await transport.setup();
    transport.attachSinks(
      new Map([
        [
          'down',
          {
            kind: 'test',
            write: async () => {
              calls++;
              throw new Error('nope');
            },
          },
        ],
      ]),
    );
    await transport.publish([event(1)]).catch(() => {});
    expect(calls).toBe(3);
    expect(errors).toEqual([expect.stringMatching(/gave up delivering 1 events to sink "down"/)]);
  });

  it('drops batches for a removed sink, and retries while the runtime is not up', async () => {
    const warnings: string[] = [];
    const transport = new QueueTransport({}, { warn: (m) => warnings.push(m), error: () => {} });
    await expect(transport.deliver({ sink: 'warehouse', events: [event(1)] })).rejects.toThrow(
      /not running/,
    );
    transport.attachSinks(new Map());
    await transport.deliver({ sink: 'gone', events: [event(1)] });
    expect(warnings).toEqual([expect.stringMatching(/sink "gone": it is no longer configured/)]);
    await transport.close();
    await expect(transport.deliver({ sink: 'gone', events: [] })).rejects.toThrow(/not running/);
  });
});

describe('queue transport on the console ops page', () => {
  let testDb: TestDb;
  let runtime: FlagsRuntime;

  beforeEach(async () => {
    await QueueManager.init({ default: 'sync', adapters: { sync: await sync() } });
    testDb = await sqliteDb();
    runtime = await createRuntime(
      defineConfig({
        app: 'shop',
        flags: declarations,
        transport: transports.queue(),
        sinks: { warehouse: sinks.memory() },
      }),
      lucidContext(testDb.database as never),
      { logger: quietLogger, runWorker: false },
    );
    setRuntime(runtime);
  });

  afterEach(async () => {
    setRuntime(undefined);
    await runtime.close();
    await testDb.close();
    await QueueManager.destroy();
  });

  it('shows the transport delivering itself, with no relay and no per-sink status', async () => {
    const res = (await h.ops({ actor: { id: 'alice' } }, { params: {}, query: {} })).body as Record<
      string,
      unknown
    >;
    expect(res).toMatchObject({
      transport: { name: 'queue', transactional: false, durable: true },
      relay: false,
      delivery: 'transport',
      sinks: [{ sink: 'warehouse' }],
      sinkError: null,
    });
  });
});
