import { describe, expect, it } from 'vitest';
import { ClickHouseBackend } from '../../src/analytics/clickhouse_backend.js';
import { metric } from '../../src/analytics/metrics.js';
import { computeResults } from '../../src/analytics/results.js';
import {
  EVENT_SCHEMA_VERSION,
  exposureId,
  type FlagEvent,
  uuidv7,
} from '../../src/events/event.js';
import { ClickHouseSink } from '../../src/sinks/clickhouse.js';

const options = () => ({
  url: process.env.FLAGS_TEST_CLICKHOUSE_URL!,
  username: 'flags',
  password: 'flags',
  table: `flags_events_${Date.now()}`,
});

describe('ClickHouse sink + backend', () => {
  it('stores events and computes the same statistics as the SQL backends', async () => {
    const opts = options();
    const sink = new ClickHouseSink(opts);
    await sink.setup();
    const now = Date.now();
    const events: FlagEvent[] = [];
    for (let i = 0; i < 200; i++) {
      const subject = `u${i}`;
      const variant = i % 2 === 0 ? 'control' : 'b';
      events.push({
        id: exposureId('shop', 'checkout', subject),
        schemaVersion: EVENT_SCHEMA_VERSION,
        app: 'shop',
        type: 'exposure',
        flag: 'checkout',
        experiment: 'checkout',
        variant,
        subject,
        subjectType: 'user',
        ts: now,
      });
      if (variant === 'b' ? i % 4 === 1 : i % 10 === 0) {
        events.push({
          id: uuidv7(),
          schemaVersion: 1,
          app: 'shop',
          type: 'track',
          name: 'purchase',
          subject,
          subjectType: 'user',
          value: 50,
          ts: now + 1000,
        });
      }
      // An event outside the window must not count, but the subject must stay in the denominator.
      if (i === 2) {
        events.push({
          id: uuidv7(),
          schemaVersion: 1,
          app: 'shop',
          type: 'track',
          name: 'purchase',
          subject,
          subjectType: 'user',
          value: 999,
          ts: now - 5000,
        });
      }
    }
    await sink.write(events);
    await sink.write(events.slice(0, 80)); // at-least-once re-send

    const backend = new ClickHouseBackend(opts);
    expect(await backend.exposures('checkout')).toEqual({ control: 100, b: 100 });
    const conversion = await backend.metric('checkout', metric.conversion('purchase'));
    expect(conversion.control).toMatchObject({ n: 100, sumY: 20 });
    expect(conversion.b).toMatchObject({ n: 100, sumY: 50 });
    const cuped = await backend.metric('checkout', metric.sum('purchase', { cupedMs: 10_000 }));
    expect(cuped.control!.sumX).toBe(999);

    const results = await computeResults(
      backend,
      { key: 'checkout', flag: 'checkout', metrics: { purchase: metric.conversion('purchase') } },
      undefined,
    );
    expect(results.metrics[0]!.comparisons[0]).toMatchObject({ variant: 'b', verdict: 'better' });

    await sink.forget('u1');
    // Mutations are asynchronous in ClickHouse; wait for this one.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await backend.exposures('checkout')).b !== 99) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect((await backend.exposures('checkout')).b).toBe(99);
  });
});
