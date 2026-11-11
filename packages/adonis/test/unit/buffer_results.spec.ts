import { describe, expect, it } from 'vitest';
import type { AnalyticsBackend } from '../../src/analytics/backend.js';
import { metric } from '../../src/analytics/metrics.js';
import { computeResults, HOLDOUT_VARIANT } from '../../src/analytics/results.js';
import { EventBuffer } from '../../src/events/buffer.js';
import type { FlagEvent } from '../../src/events/event.js';
import type { Transport } from '../../src/transports/transport.js';

const track = (i: number): FlagEvent => ({
  id: `e${i}`,
  schemaVersion: 1,
  app: 'a',
  type: 'track',
  name: 'n',
  subject: `u${i}`,
  subjectType: 'user',
  ts: i,
});

describe('EventBuffer', () => {
  it('keeps the right events when overflow drops some during a publish', async () => {
    const published: string[] = [];
    let release!: () => void;
    let first = true;
    const transport: Transport = {
      name: 'slow',
      capabilities: { transactional: false, durable: false },
      async publish(events) {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        published.push(...events.map((e) => e.id));
      },
    };
    const buffer = new EventBuffer(transport, { maxSize: 3, maxQueue: 4 });
    for (let i = 1; i <= 3; i++) buffer.push(track(i));
    const flushing = buffer.flush();
    // While e1–e3 are in flight, overflow pushes e1 and e2 out of the queue.
    for (let i = 4; i <= 6; i++) buffer.push(track(i));
    expect(buffer.dropped).toBe(2);
    release();
    await flushing;
    await buffer.flush();
    expect(published).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
    expect(buffer.pending).toBe(0);
  });

  it('sends one exposure per id per process', () => {
    const buffer = new EventBuffer({
      name: 'x',
      capabilities: { transactional: false, durable: false },
      publish: async () => {},
    });
    const exposure = { ...track(1), type: 'exposure' as const, experiment: 'x', variant: 'a' };
    expect(buffer.push(exposure)).toBe(true);
    expect(buffer.push(exposure)).toBe(false);
    expect(buffer.pending).toBe(1);
  });
});

describe('results and the global holdout', () => {
  it('reports holdout subjects apart and never compares them', async () => {
    const stats = (n: number, conversions: number) => ({
      n,
      sumY: conversions,
      sumY2: conversions,
      sumX: 0,
      sumX2: 0,
      sumXY: 0,
    });
    const backend: AnalyticsBackend = {
      kind: 'fake',
      exposures: async () => ({ control: 500, b: 500, [HOLDOUT_VARIANT]: 50 }),
      metric: async () => ({
        control: stats(500, 50),
        b: stats(500, 80),
        [HOLDOUT_VARIANT]: stats(50, 1),
      }),
    };
    const results = await computeResults(
      backend,
      { key: 'exp', flag: 'exp', metrics: { conversion: metric.conversion('buy') } },
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
      },
    );
    expect(results.holdout).toBe(50);
    expect(results.exposures).toEqual({ control: 500, b: 500 });
    expect(results.metrics[0]!.comparisons.map((c) => c.variant)).toEqual(['b']);
    expect(results.metrics[0]!.variants.map((v) => v.variant)).toEqual(['control', 'b']);
    expect(results.srm?.mismatch).toBe(false);
  });
});
