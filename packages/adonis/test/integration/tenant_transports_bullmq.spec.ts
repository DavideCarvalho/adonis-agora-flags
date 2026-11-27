import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bullmqTransport } from '../../src/tenant_transports/bullmq.js';
import {
  createMessage,
  type DeadLetter,
  decodeMessage,
  PoisonMessageError,
} from '../../src/tenant_transports/message.js';
import type { HandledMessage } from '../../src/tenant_transports/types.js';

async function until(check: () => Promise<boolean> | boolean, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

/**
 * The bullmq tenant transport against the real `bullmq` package (the version installed here: the
 * peer range covers 5 and 6) and a real Redis: jobs a tenant pushes reach the control plane's worker,
 * and a refused one is failed for good (unrecoverable) instead of being retried.
 */
describe('tenant transport over real BullMQ', () => {
  let redis: Redis;
  const queue = `flags-bullmq-it-${Date.now()}`;
  const received: unknown[] = [];
  const letters: DeadLetter[] = [];
  let serving: { close(): Promise<void> } | undefined;

  beforeAll(async () => {
    redis = new Redis(process.env.FLAGS_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await serving?.close();
    await redis.quit();
  });

  it('delivers jobs and fails a refused one as unrecoverable', async () => {
    const transport = bullmqTransport({ connection: redis, queue, attempts: 3 });
    serving = await transport.serve({
      handler: {
        async handle(raw: unknown) {
          const message = decodeMessage(raw);
          if (message.token !== 's3cret') throw new PoisonMessageError('bad token', 'unauthorized');
          received.push(message.body);
          return { message } as unknown as HandledMessage;
        },
        async deadLetter(letter: DeadLetter) {
          letters.push(letter);
        },
      },
    } as never);

    const link = await transport.push({
      partition: 'shop',
      token: { get: async () => 's3cret' },
      redis: async () => redis,
    } as never);
    await link.check?.();
    await link.send('events', { events: [{ type: 'track' }] });
    await until(() => received.length === 1);
    expect(received[0]).toEqual({ events: [{ type: 'track' }] });

    const forged = await transport.push({
      partition: 'shop',
      token: { get: async () => 'forged' },
      redis: async () => redis,
    } as never);
    await forged.send('events', { events: [] });
    await until(() => letters.length === 1);
    expect(letters[0]!.reason).toBe('unauthorized');

    const inspect = new Queue(queue, { connection: redis });
    await until(async () => (await inspect.getFailedCount()) === 1);
    const [failed] = await inspect.getFailed();
    // Unrecoverable: one attempt, no retries left.
    expect(failed!.attemptsMade).toBe(1);
    await inspect.close();
    await link.close();
    await forged.close();
    expect(createMessage('events', 'shop', 't', {}).v).toBe(1);
  });
});
