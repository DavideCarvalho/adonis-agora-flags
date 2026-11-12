import { AppFactory } from '@adonisjs/core/factories/app';
import { drivers, fixedBackoff, QueueManager, Worker } from '@adonisjs/queue';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import type { FlagEvent } from '../../src/events/event.js';
import { defineConfig, sinks, stores, transports } from '../../src/index.js';
import { createRuntime, lucidContext } from '../../src/runtime.js';
import { MemorySink } from '../../src/sinks/sink.js';
import { quietLogger } from '../helpers.js';

describe('queue transport on @adonisjs/queue with Redis', () => {
  let redis: Redis;
  let app: ReturnType<AppFactory['create']>;

  beforeAll(async () => {
    redis = new Redis(process.env.FLAGS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
    app = new AppFactory().create(new URL('./', import.meta.url), () => {});
    await app.init();
    // What @adonisjs/redis binds: `drivers.redis()` takes its connection from here.
    app.container.singleton(
      'redis' as never,
      async () => ({ connection: () => ({ ioConnection: redis }) }) as never,
    );
    app.container.singleton('queue.manager' as never, async () => QueueManager as never);
  });

  afterAll(async () => {
    await QueueManager.destroy();
    await redis.quit().catch(() => {});
  });

  it('stores one job per sink, and a queue worker delivers them with independent retries', async () => {
    const config = {
      default: 'redis',
      adapters: { redis: await drivers.redis().resolver(app as never) },
      jobFactory: (JobClass: unknown) => app.container.make(JobClass as never),
    };
    await QueueManager.init(config);
    const warehouse = new MemorySink();
    const flaky: FlagEvent[] = [];
    let flakyCalls = 0;
    const runtime = await createRuntime(
      defineConfig({
        app: 'shop',
        flags: { checkout: flag.boolean({ default: false }) },
        store: stores.memory(),
        transport: transports.queue({ queue: 'flags-it', backoff: fixedBackoff(1) }),
        sinks: {
          warehouse: () => warehouse,
          flaky: sinks.callback(async (events) => {
            flakyCalls++;
            if (flakyCalls === 1) throw new Error('down');
            flaky.push(...events);
          }),
        },
      }),
      lucidContext(undefined, { app: app as never }),
      { logger: quietLogger, runWorker: false, start: false },
    );

    await runtime.manager.track('u1', 'purchase');
    await runtime.manager.track('u2', 'purchase');
    await runtime.buffer!.flush();
    // Published, not delivered: the jobs wait in Redis for a worker.
    expect(warehouse.events).toHaveLength(0);
    expect(await QueueManager.use().sizeOf('flags-it')).toBe(2);

    const worker = new Worker(config);
    const deadline = Date.now() + 10_000;
    while ((warehouse.events.length < 2 || flaky.length < 2) && Date.now() < deadline) {
      await worker.processCycle(['flags-it']);
    }
    await worker.stop();
    await runtime.close();

    expect(warehouse.events.map((e) => e.subject).sort()).toEqual(['u1', 'u2']);
    expect(flaky.map((e) => e.subject).sort()).toEqual(['u1', 'u2']);
    expect(flakyCalls).toBe(2);
  });
});
