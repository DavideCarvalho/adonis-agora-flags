import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Relay } from '../../src/relay/relay.js';
import { MemorySink } from '../../src/sinks/sink.js';
import { type RedisStreamClient, RedisTransport } from '../../src/transports/redis_transport.js';

const event = (i: number) => ({
  id: `e${i}`,
  schemaVersion: 1,
  app: 'shop',
  type: 'track' as const,
  name: 'purchase',
  subject: `u${i}`,
  subjectType: 'user',
  ts: Date.now(),
});

describe('Redis Streams transport', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(process.env.FLAGS_TEST_REDIS_URL!);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('gives each sink its own consumer group, from the start of the stream', async () => {
    const transport = new RedisTransport(redis as unknown as RedisStreamClient, {
      stream: 'flags:t1',
    });
    await transport.publish([event(1), event(2), event(3)]);
    const a = new MemorySink();
    const b = new MemorySink();
    const relay = new Relay(
      transport,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      { batchSize: 2, leaseMs: 60_000 },
    );
    await relay.drainAll();
    expect(a.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(b.events.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    const status = await transport.status(['a']);
    expect(status[0]!.lag).toBe(0);
  });

  it('reclaims a batch a crashed consumer left pending', async () => {
    const transport = new RedisTransport(redis as unknown as RedisStreamClient, {
      stream: 'flags:t2',
    });
    await transport.publish([event(1), event(2)]);
    // Consumer 1 leases and dies (never acks).
    const lost = await transport.consume('s', { batchSize: 10, leaseMs: 50, owner: 'dead' });
    expect(lost!.events).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const sink = new MemorySink();
    await new Relay(transport, new Map([['s', sink]]), { leaseMs: 50 }, 'alive').drain('s');
    expect(sink.events.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });
});
