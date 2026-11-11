import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, metric, sinks } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const config = defineConfig({
  app: 'shop',
  flags: {
    new_player: flag.boolean({ default: false, client: true, owner: 'video-team' }),
    checkout: flag.string({ default: 'control', variants: ['control', 'one_page'] }),
    max_items: flag.number({ default: 10 }),
  },
  metrics: {
    purchase: metric.conversion('purchase'),
    revenue: metric.sum('purchase'),
  },
  experiments: { checkout: { metrics: ['purchase', 'revenue'] } },
  sinks: { warehouse: sinks.lucid() },
});

describe('standalone runtime on SQLite', () => {
  let testDb: TestDb;
  let runtime: FlagsRuntime;
  const admin = { id: 'alice' };

  beforeEach(async () => {
    testDb = await sqliteDb();
    runtime = await createRuntime(config, lucidContext(testDb.database as never), {
      logger: quietLogger,
      runWorker: false,
    });
  });

  afterEach(async () => {
    await runtime.close();
    await testDb.close();
  });

  it('serves code defaults before anything is configured', async () => {
    const flags = runtime.manager.for('u1');
    expect(await flags.enabled('new_player')).toBe(false);
    expect(await flags.value('checkout')).toBe('control');
    expect(await flags.value('max_items')).toBe(10);
    expect((await flags.details('new_player')).errorCode).toBe('FLAG_NOT_FOUND');
  });

  it('applies admin changes, bumps the version and audits them', async () => {
    const result = await runtime.admin!.turnOn('new_player', admin);
    expect(result).toMatchObject({ status: 'applied' });
    await runtime.manager.refresh();
    expect(await runtime.manager.for('u1').enabled('new_player')).toBe(true);
    // The kill switch wins over everything.
    await runtime.admin!.setEnabled('new_player', false, admin);
    await runtime.manager.refresh();
    expect(await runtime.manager.for('u1').details('new_player')).toMatchObject({
      value: false,
      reason: 'DISABLED',
    });
    const audit = await runtime.store!.audit({ key: 'new_player' });
    expect(audit.map((entry) => entry.action)).toEqual(['update', 'create']);
    expect(audit[1]).toMatchObject({ actor: { id: 'alice' }, entity: 'flag', version: '1' });
    expect(audit[0]?.version).toBe('2');
  });

  it('rejects changes that contradict the declared types', async () => {
    await expect(
      runtime.admin!.saveFlag(
        'max_items',
        {
          variants: { default: 'ten' },
          enabled: true,
          offVariant: 'default',
          fallthrough: { variant: 'default' },
        },
        admin,
      ),
    ).rejects.toMatchObject({ code: 'E_FLAGS_INVALID' });
    await expect(
      runtime.admin!.saveFlag(
        'checkout',
        {
          variants: { control: 'control', x: 'surprise' },
          enabled: true,
          offVariant: 'control',
          fallthrough: { variant: 'x' },
        },
        admin,
      ),
    ).rejects.toThrow(/not one of the declared variants/);
  });

  it('rolls out by percentage and only ever adds people', async () => {
    await runtime.admin!.setRollout('new_player', 20, admin);
    await runtime.manager.refresh();
    const on20 = new Set<string>();
    for (let i = 0; i < 2000; i++)
      if (await runtime.manager.for(`u${i}`).enabled('new_player')) on20.add(`u${i}`);
    expect(Math.abs(on20.size - 400)).toBeLessThan(80);
    await runtime.admin!.setRollout('new_player', 50, admin);
    await runtime.manager.refresh();
    for (const id of on20) expect(await runtime.manager.for(id).enabled('new_player')).toBe(true);
  });

  it('records exposures once, relays them, and computes experiment results', async () => {
    await runtime.admin!.saveFlag(
      'checkout',
      {
        variants: { control: 'control', one_page: 'one_page' },
        enabled: true,
        offVariant: 'control',
        fallthrough: {
          split: [
            { variant: 'control', weight: 50 },
            { variant: 'one_page', weight: 50 },
          ],
        },
        experiment: {},
      },
      admin,
    );
    await runtime.manager.refresh();
    for (let i = 0; i < 400; i++) {
      const flags = runtime.manager.for(`u${i}`);
      const variant = await flags.variant('checkout');
      await flags.variant('checkout'); // memoized: no second exposure
      // one_page converts more
      if (variant === 'one_page' ? i % 2 === 0 : i % 5 === 0)
        await flags.track('purchase', { value: 100 });
    }
    // A second request for the same subject does not produce a second exposure.
    await runtime.manager.for('u1').variant('checkout');
    await runtime.buffer!.flush();
    const drained = await runtime.relay!.drain('warehouse', 100);
    expect(drained.delivered).toBeGreaterThan(400);

    const results = await runtime.worker!.computeResults('checkout');
    expect(results).not.toBeNull();
    const total = Object.values(results!.exposures).reduce((a, b) => a + b, 0);
    expect(total).toBe(400);
    expect(results!.srm?.mismatch).toBe(false);
    const purchase = results!.metrics.find((m) => m.name === 'purchase')!;
    expect(purchase.comparisons[0]).toMatchObject({
      variant: 'one_page',
      test: 'proportion',
      verdict: 'better',
    });
    expect(purchase.comparisons[0]!.difference).toBeGreaterThan(0.2);
    const revenue = results!.metrics.find((m) => m.name === 'revenue')!;
    expect(revenue.comparisons[0]!.test).toBe('welch');
    expect(await runtime.manager.results('checkout')).toMatchObject({ experiment: 'checkout' });
  });

  it('keeps tracked events inside the caller transaction', async () => {
    await testDb.database
      .transaction(async (trx) => {
        await runtime.manager.track('u9', 'purchase', { value: 5, client: trx as never });
        throw new Error('rollback');
      })
      .catch(() => {});
    const rows = await testDb.database.rawQuery('SELECT COUNT(*) AS n FROM flags_events');
    expect(Number((rows as Array<{ n: number }>)[0]!.n)).toBe(0);
  });

  it('requires a second person when approvals are on', async () => {
    const strict = await createRuntime(
      { ...config, approvals: { environments: ['production'] } },
      lucidContext(testDb.database as never),
      { logger: quietLogger, start: false },
    );
    const pending = await strict.admin!.turnOn('new_player', admin);
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') return;
    await expect(strict.admin!.approve(pending.request.id, admin)).rejects.toThrow(/requested it/);
    const approved = await strict.admin!.approve(pending.request.id, { id: 'bob' });
    expect(approved.request.status).toBe('applied');
    const audit = await strict.store!.audit({ key: 'new_player' });
    expect(audit[0]?.changeRequestId).toBe(pending.request.id);
    await strict.close();
  });

  it('runs scheduled rollouts once', async () => {
    const past = new Date(Date.now() - 1000);
    await runtime.admin!.scheduleRollout('new_player', [{ at: past, percent: 100 }], admin);
    const [first, second] = await Promise.all([
      runtime.admin!.runDueSchedules(),
      runtime.admin!.runDueSchedules(),
    ]);
    expect([...first!, ...second!].filter((r) => r.ok)).toHaveLength(1);
    await runtime.manager.refresh();
    expect(await runtime.manager.for('anyone').enabled('new_player')).toBe(true);
  });

  it('exports, imports and promotes between environments', async () => {
    await runtime.admin!.turnOn('new_player', admin, { environment: 'staging' });
    const promoted = await runtime.admin!.promote('staging', 'production', admin);
    expect(promoted.status).toBe('applied');
    const production = await runtime.admin!.exportRuleset('production');
    expect(production.flags.new_player?.fallthrough).toEqual({ variant: 'on' });
    expect(await runtime.store!.environments()).toEqual(['production', 'staging']);
  });

  it('reports stale flags', async () => {
    await runtime.admin!.setEnabled('new_player', true, admin);
    const stale = await runtime.admin!.stale({ now: new Date(Date.now() + 40 * 86_400_000) });
    const entry = stale.find((s) => s.key === 'new_player');
    expect(entry?.reasons).toEqual(expect.arrayContaining(['unused', 'static']));
  });

  it('fakes values in tests', async () => {
    const restore = runtime.manager.fake({ new_player: true, checkout: 'one_page' });
    expect(await runtime.manager.for('u1').enabled('new_player')).toBe(true);
    expect(await runtime.manager.for('u1').value('checkout')).toBe('one_page');
    restore();
    expect(await runtime.manager.for('u2').enabled('new_player')).toBe(false);
  });

  it('only sends client-declared flags to the browser', async () => {
    expect(Object.keys(await runtime.manager.for('u1').all())).toEqual(['new_player']);
  });

  it('forgets a subject everywhere', async () => {
    await runtime.manager.track('gone', 'purchase', { value: 1 });
    await runtime.buffer!.flush();
    await runtime.relay!.drain('warehouse');
    await runtime.manager.forget('gone');
    const tracks = (await testDb.database.rawQuery(
      "SELECT COUNT(*) AS n FROM flags_tracks WHERE subject = 'gone'",
    )) as Array<{ n: number }>;
    const events = (await testDb.database.rawQuery(
      "SELECT COUNT(*) AS n FROM flags_events WHERE subject = 'gone'",
    )) as Array<{ n: number }>;
    expect(Number(tracks[0]!.n) + Number(events[0]!.n)).toBe(0);
  });
});
