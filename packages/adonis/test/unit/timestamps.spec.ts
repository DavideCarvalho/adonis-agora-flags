import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as h from '../../src/dashboard/handlers.js';
import { flag } from '../../src/declare.js';
import { defineConfig } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { createFlagsTables, missingFlagsColumns } from '../../src/schema.js';
import { setRuntime } from '../../src/services/accessor.js';
import { query, toOptionalDate } from '../../src/sql.js';
import { LucidStore } from '../../src/stores/lucid_store.js';
import { MemoryStore } from '../../src/stores/memory_store.js';
import type { FlagsStore } from '../../src/stores/store.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const actor = { id: 'alice' };
const onOff = (enabled: boolean) => ({
  variants: { on: true, off: false },
  enabled,
  offVariant: 'off',
  fallthrough: { variant: 'on' },
});

const stores: Array<[string, () => Promise<{ store: FlagsStore; close(): Promise<void> }>]> = [
  ['MemoryStore', async () => ({ store: new MemoryStore(), close: async () => {} })],
  [
    'LucidStore (SQLite)',
    async () => {
      const testDb = await sqliteDb();
      const store = new LucidStore(testDb.db);
      await store.setup();
      return { store, close: () => testDb.close() };
    },
  ],
];

describe.each(stores)('timestamps in %s', (_name, open) => {
  let store: FlagsStore;
  let close: () => Promise<void>;

  beforeEach(async () => {
    ({ store, close } = await open());
  });

  afterEach(async () => {
    vi.useRealTimers();
    await close();
  });

  it('stamps entities: created once, updated on every change, kept across a ruleset replace', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await store.apply(
      'production',
      { entity: 'flag', key: 'a', value: onOff(true) as never },
      actor,
    );
    await store.apply('production', { entity: 'segment', key: 'beta', value: {} }, actor);

    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    await store.apply(
      'production',
      { entity: 'flag', key: 'a', value: onOff(false) as never },
      actor,
    );

    const byKey = async () =>
      new Map(
        (await store.entityTimestamps!('production')).map((s) => [`${s.entity}:${s.key}`, s]),
      );
    let stamps = await byKey();
    expect(stamps.get('flag:a')?.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(stamps.get('flag:a')?.updatedAt?.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(stamps.get('segment:beta')?.updatedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-03-01T00:00:00Z'));
    const ruleset = await store.readRuleset('production');
    await store.apply(
      'production',
      {
        entity: 'ruleset',
        value: { ...ruleset, flags: { ...ruleset.flags, b: onOff(true) as never } },
      },
      actor,
    );
    stamps = await byKey();
    expect(stamps.get('flag:a')?.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(stamps.get('flag:b')?.createdAt?.toISOString()).toBe('2026-03-01T00:00:00.000Z');

    await store.apply('production', { entity: 'flag', key: 'a', value: null }, actor);
    expect((await byKey()).has('flag:a')).toBe(false);
  });

  it('stamps change requests and schedules, and moves updatedAt on each write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const request = await store.createChangeRequest({
      environment: 'production',
      change: { entity: 'flag', key: 'a', value: null },
      requestedBy: actor,
      baseVersion: '0',
    });
    expect(request.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(request.updatedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    const schedule = await store.createSchedule({
      environment: 'production',
      flag: 'a',
      kind: 'enable',
      payload: {},
      runAt: new Date('2026-06-01T00:00:00Z'),
      createdBy: actor,
    });
    expect(schedule.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    const reviewed = await store.updateChangeRequest(request.id, { status: 'cancelled' });
    expect(reviewed.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(reviewed.updatedAt?.toISOString()).toBe('2026-01-02T00:00:00.000Z');

    expect(await store.claimSchedule(schedule.id)).toBe(true);
    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    const done = await store.updateSchedule(schedule.id, { status: 'done' });
    expect(done.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(done.updatedAt?.toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });

  it('stamps declarations: updatedAt moves only when the declaration changes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const declaration = { type: 'boolean', default: false } as never;
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await store.saveDeclarations('shop', { a: declaration });
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    await store.saveDeclarations('shop', { a: declaration });
    let [row] = await store.declarations('shop');
    expect(row?.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.updatedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.lastSeenAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
    await store.saveDeclarations('shop', { a: { type: 'boolean', default: true } as never });
    [row] = await store.declarations('shop');
    expect(row?.createdAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(row?.updatedAt?.toISOString()).toBe('2026-01-03T00:00:00.000Z');
  });
});

describe('timestamp columns on an existing schema', () => {
  let testDb: TestDb;
  beforeEach(async () => {
    testDb = await sqliteDb();
  });
  afterEach(() => testDb.close());

  it('adds the missing columns as NULL-able, leaving older rows unknown', async () => {
    // A table as an older version created it, with a row in it.
    await testDb.db.rawQuery(`CREATE TABLE flags_entities (
      environment VARCHAR(191) NOT NULL, entity VARCHAR(16) NOT NULL, entity_key VARCHAR(191) NOT NULL,
      definition TEXT NOT NULL, updated_at BIGINT NOT NULL, updated_by VARCHAR(191) NOT NULL,
      PRIMARY KEY (environment, entity, entity_key))`);
    await testDb.db.rawQuery(
      "INSERT INTO flags_entities VALUES ('production', 'segment', 'old', '{}', 1000, 'cli')",
    );
    expect(await missingFlagsColumns(testDb.db)).toEqual(['flags_entities.created_at']);

    await createFlagsTables(testDb.db);
    expect(await missingFlagsColumns(testDb.db)).toEqual([]);
    const [row] = await query<{ created_at: unknown }>(
      testDb.db,
      'SELECT created_at FROM flags_entities',
    );
    expect(row?.created_at).toBeNull();

    // Updating the old row does not invent a creation time.
    const store = new LucidStore(testDb.db, { autoCreateSchema: false });
    await store.apply(
      'production',
      { entity: 'segment', key: 'old', value: { included: ['x'] } },
      actor,
    );
    const [stamps] = await store.entityTimestamps('production');
    expect(stamps?.createdAt).toBeUndefined();
    expect(stamps?.updatedAt).toBeInstanceOf(Date);

    await createFlagsTables(testDb.db); // idempotent
  });
});

describe('toOptionalDate', () => {
  it('normalises epoch numbers, numeric and ISO strings, Date and Luxon-like values', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    const ms = Date.parse(iso);
    expect(toOptionalDate(ms)?.toISOString()).toBe(iso);
    expect(toOptionalDate(String(ms))?.toISOString()).toBe(iso);
    expect(toOptionalDate(iso)?.toISOString()).toBe(iso);
    expect(toOptionalDate(new Date(iso))?.toISOString()).toBe(iso);
    expect(toOptionalDate({ toJSDate: () => new Date(iso) })?.toISOString()).toBe(iso);
    expect(toOptionalDate(null)).toBeUndefined();
    expect(toOptionalDate('nope')).toBeUndefined();
  });
});

describe('console DTOs carry createdAt / updatedAt', () => {
  let testDb: TestDb;
  let runtime: FlagsRuntime;
  const deps = { actor };
  const req = (parts: Partial<h.ApiRequest> = {}): h.ApiRequest => ({
    params: {},
    query: {},
    body: undefined,
    ...parts,
  });

  beforeEach(async () => {
    testDb = await sqliteDb();
    runtime = await createRuntime(
      defineConfig({
        app: 'shop',
        flags: {
          coded: flag.boolean({ default: false }),
          untouched: flag.boolean({ default: false }),
        },
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
  });

  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  it('on flags, segments, layers, change requests and schedules', async () => {
    await runtime.admin!.turnOn('coded', actor);
    await runtime.store!.apply('production', { entity: 'segment', key: 'beta', value: {} }, actor);
    await runtime.store!.apply(
      'production',
      { entity: 'layer', key: 'checkout', value: { allocations: {} } },
      actor,
    );

    const flags = (await h.listFlags(deps, req())).body as { data: Array<Record<string, unknown>> };
    const stored = flags.data.find((f) => f.key === 'coded')!;
    expect(stored.createdAt).toMatch(ISO);
    expect(stored.updatedAt).toMatch(ISO);
    // Never stored: when the app first declared it in code.
    const untouched = flags.data.find((f) => f.key === 'untouched')!;
    const [declared] = await runtime.store!.declarations('shop');
    expect(untouched.createdAt).toBe(declared?.createdAt?.toISOString() ?? null);

    const detail = (await h.flagDetail(deps, req({ params: { key: 'coded' } }))).body as Record<
      string,
      unknown
    >;
    expect(detail.createdAt).toBe(stored.createdAt);
    expect(detail.updatedAt).toBe(stored.updatedAt);

    const segments = (await h.listSegments(deps, req())).body as {
      data: Array<Record<string, unknown>>;
    };
    expect(segments.data[0]).toMatchObject({ key: 'beta', createdAt: expect.stringMatching(ISO) });
    const layers = (await h.listLayers(deps, req())).body as {
      data: Array<Record<string, unknown>>;
      holdoutStamps: h.Stamps;
    };
    expect(layers.data[0]).toMatchObject({
      key: 'checkout',
      updatedAt: expect.stringMatching(ISO),
    });
    expect(layers.holdoutStamps).toEqual({ createdAt: null, updatedAt: null });

    await runtime.store!.createChangeRequest({
      environment: 'production',
      change: { entity: 'flag', key: 'coded', value: null },
      requestedBy: { id: 'bob' },
      baseVersion: '1',
    });
    const requests = (await h.listChangeRequests(deps, req())).body as {
      data: Array<Record<string, unknown>>;
    };
    expect(requests.data[0]).toMatchObject({
      createdAt: expect.stringMatching(ISO),
      updatedAt: expect.stringMatching(ISO),
    });

    await runtime.store!.createSchedule({
      environment: 'production',
      flag: 'coded',
      kind: 'disable',
      payload: {},
      runAt: new Date(Date.now() + 3_600_000),
      createdBy: actor,
    });
    const schedules = (await h.listSchedules(deps, req())).body as {
      data: Array<Record<string, unknown>>;
    };
    expect(schedules.data[0]).toMatchObject({ createdAt: expect.stringMatching(ISO) });
  });

  it('answers null, not a missing field, when a store cannot tell', async () => {
    const store = runtime.store!;
    const original = store.entityTimestamps;
    store.entityTimestamps = undefined;
    try {
      await runtime.store!.apply(
        'production',
        { entity: 'segment', key: 'beta', value: {} },
        actor,
      );
      const segments = (await h.listSegments(deps, req())).body as {
        data: Array<Record<string, unknown>>;
      };
      expect(segments.data[0]).toMatchObject({ createdAt: null, updatedAt: null });
    } finally {
      store.entityTimestamps = original;
    }
  });
});
