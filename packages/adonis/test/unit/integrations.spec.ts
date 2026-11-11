import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenFeature } from '@openfeature/server-sdk';
import { afterAll, describe, expect, it } from 'vitest';
import { findReferences } from '../../commands/flags_refs.js';
import { describeServing } from '../../commands/shared.js';
import { DuckDbBackend } from '../../src/analytics/duckdb.js';
import { metric } from '../../src/analytics/metrics.js';
import { computeResults } from '../../src/analytics/results.js';
import { flag } from '../../src/declare.js';
import {
  EVENT_SCHEMA_VERSION,
  exposureId,
  type FlagEvent,
  uuidv7,
} from '../../src/events/event.js';
import { AgoraFlagsProvider } from '../../src/openfeature/provider.js';
import { ParquetSink } from '../../src/sinks/parquet_sink.js';
import { PostHogSink } from '../../src/sinks/posthog_sink.js';
import { createTestFlags } from '../../src/testing/index.js';

const tmp = mkdtempSync(join(tmpdir(), 'flags-int-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('OpenFeature provider', () => {
  it('resolves through the same engine and records exposures', async () => {
    const test = createTestFlags({
      flags: { checkout: flag.string({ default: 'control', variants: ['control', 'b'] }) },
      ruleset: {
        flags: {
          checkout: {
            variants: { control: 'control', b: 'b' },
            enabled: true,
            offVariant: 'control',
            fallthrough: { split: [{ variant: 'b', weight: 1 }] },
            experiment: {},
          },
        },
      },
    });
    await OpenFeature.setProviderAndWait(new AgoraFlagsProvider(test.manager));
    const client = OpenFeature.getClient();
    const details = await client.getStringDetails('checkout', 'control', { targetingKey: 'u1' });
    expect(details).toMatchObject({ value: 'b', variant: 'b', reason: 'SPLIT' });
    const missing = await client.getBooleanDetails('ghost', true, { targetingKey: 'u1' });
    expect(missing).toMatchObject({ value: true, errorCode: 'FLAG_NOT_FOUND' });
    client.track('purchase', { targetingKey: 'u1' }, { value: 42, currency: 'BRL' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const events = await test.events();
    expect(events.map((e) => e.type).sort()).toEqual(['exposure', 'track']);
    expect(events.find((e) => e.type === 'track')).toMatchObject({
      value: 42,
      props: { currency: 'BRL' },
    });
    await OpenFeature.close();
  });
});

describe('PostHog sink', () => {
  it('sends exposures as $feature_flag_called with the event id as uuid', async () => {
    const calls: Array<{
      url: string;
      body: { api_key: string; batch: Array<Record<string, unknown>> };
    }> = [];
    const sink = new PostHogSink({
      apiKey: 'phc_test',
      host: 'https://ph.example',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });
    await sink.write([
      {
        id: 'e1',
        schemaVersion: 1,
        app: 'shop',
        type: 'exposure',
        flag: 'checkout',
        experiment: 'checkout',
        variant: 'b',
        subject: 'u1',
        subjectType: 'user',
        ts: 0,
      },
    ]);
    expect(calls[0]!.url).toBe('https://ph.example/batch/');
    expect(calls[0]!.body.batch[0]).toMatchObject({
      event: '$feature_flag_called',
      distinct_id: 'u1',
      uuid: 'e1',
      properties: { $feature_flag: 'checkout', $feature_flag_response: 'b' },
    });
  });

  it('fails the batch (so the relay retries) on a non-2xx answer', async () => {
    const sink = new PostHogSink({
      apiKey: 'k',
      fetch: (async () => new Response('down', { status: 503 })) as unknown as typeof fetch,
    });
    await expect(
      sink.write([
        {
          id: 'x',
          schemaVersion: 1,
          app: 'a',
          type: 'track',
          name: 'n',
          subject: 's',
          subjectType: 'user',
          ts: 0,
        },
      ]),
    ).rejects.toThrow(/503/);
  });
});

describe('Parquet sink + DuckDB backend', () => {
  it('writes partitioned Parquet that DuckDB analyses like the SQL backends', async () => {
    const path = join(tmp, 'parquet');
    const sink = new ParquetSink({ path });
    await sink.setup();
    const events: FlagEvent[] = [];
    const now = Date.now();
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
      const converts = variant === 'b' ? i % 4 === 1 : i % 10 === 0;
      if (converts) {
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
    }
    // Re-sending a batch must not change any number (at-least-once delivery).
    await sink.write(events);
    await sink.write(events.slice(0, 50));

    const backend = new DuckDbBackend({ path });
    expect(await backend.exposures('checkout')).toEqual({ control: 100, b: 100 });
    const stats = await backend.metric('checkout', metric.conversion('purchase'));
    expect(stats.control!.sumY).toBe(20);
    expect(stats.b!.sumY).toBe(50);
    const results = await computeResults(
      backend,
      {
        key: 'checkout',
        flag: 'checkout',
        metrics: { purchase: metric.conversion('purchase'), revenue: metric.sum('purchase') },
      },
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
      },
    );
    expect(results.srm?.mismatch).toBe(false);
    expect(results.metrics[0]!.comparisons[0]).toMatchObject({ variant: 'b', verdict: 'better' });
    expect(results.metrics[1]!.variants.find((v) => v.variant === 'b')!.mean).toBe(25);

    await sink.forget('u1');
    expect((await backend.exposures('checkout')).b).toBe(99);
    await backend.close();
    await sink.close();
  });

  it('reports no data, not an error, before the first file', async () => {
    const backend = new DuckDbBackend({ path: join(tmp, 'empty') });
    expect(await backend.exposures('x')).toEqual({});
    await backend.close();
  });
});

describe('command helpers', () => {
  it('describes what a flag serves', () => {
    expect(describeServing(undefined)).toMatch(/code default/);
    expect(
      describeServing({
        variants: { on: true, off: false },
        enabled: true,
        offVariant: 'off',
        fallthrough: {
          split: [
            { variant: 'on', weight: 2500 },
            { variant: 'off', weight: 7500 },
          ],
        },
        rules: [{ id: 'r', conditions: [], serve: { variant: 'on' } }],
      }),
    ).toBe('on 25% / off 75%, 1 rule(s)');
    expect(
      describeServing({
        variants: { off: false },
        enabled: false,
        offVariant: 'off',
        fallthrough: { variant: 'off' },
      }),
    ).toBe('killed → off');
  });

  it('finds flag references in code', async () => {
    const root = join(tmp, 'app');
    mkdirSync(join(root, 'app/controllers'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x'), { recursive: true });
    writeFileSync(
      join(root, 'app/controllers/a.ts'),
      "await ctx.flags.enabled('new_player')\nconst x = 'new_player_v2'\n",
    );
    writeFileSync(join(root, 'node_modules/x/i.js'), "'new_player'");
    const refs = await findReferences(root, ['new_player', 'unused']);
    expect(refs).toEqual([{ key: 'new_player', file: 'app/controllers/a.ts', line: 1 }]);
  });
});
