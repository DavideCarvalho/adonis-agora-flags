import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as h from '../../src/dashboard/handlers.js';
import { flag } from '../../src/declare.js';
import { defineConfig, metric, sinks } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { setRuntime } from '../../src/services/accessor.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const config = defineConfig({
  app: 'shop',
  flags: {
    new_player: flag.boolean({ default: false, owner: 'video-team', tags: ['player'] }),
    checkout: flag.string({ default: 'control', variants: ['control', 'one_page'] }),
    max_items: flag.number({ default: 10, expiresAt: '2020-01-01' }),
  },
  metrics: { purchase: metric.conversion('purchase') },
  experiments: { checkout: { metrics: ['purchase'] } },
  sinks: { warehouse: sinks.lucid() },
});

const alice = { actor: { id: 'alice' } };
const bob = { actor: { id: 'bob' } };

function req(
  parts: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {},
): h.ApiRequest {
  return { params: parts.params ?? {}, query: parts.query ?? {}, body: parts.body };
}

const body = <T = Record<string, any>>(response: h.ApiResponse) => response.body as T;

const checkoutExperiment = {
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
};

describe('dashboard API handlers', () => {
  let testDb: TestDb;
  let runtime: FlagsRuntime;

  beforeEach(async () => {
    testDb = await sqliteDb();
    runtime = await createRuntime(config, lucidContext(testDb.database as never), {
      logger: quietLogger,
      runWorker: false,
    });
    setRuntime(runtime);
  });

  afterEach(async () => {
    setRuntime(undefined);
    await runtime.close();
    await testDb.close();
  });

  it('reads the runtime from getRuntime() and answers 503 on a tenant', async () => {
    expect((await h.meta(alice, req())).status).toBe(200);
    setRuntime({ ...runtime, topology: 'tenant', admin: undefined, store: undefined });
    const res = await h.listFlags(alice, req());
    expect(res.status).toBe(503);
    expect(body(res).error).toMatch(/tenant/);
  });

  it('describes the deployment in meta', async () => {
    await runtime.admin!.turnOn('new_player', alice.actor, { environment: 'staging' });
    const res = body(await h.meta(alice, req()));
    expect(res).toMatchObject({
      app: 'shop',
      environment: 'production',
      environments: ['production', 'staging'],
      approvals: { production: false, staging: false },
      actor: { id: 'alice' },
      experiments: ['checkout'],
      analytics: true,
    });
    expect(res.operators).toContain('semverGte');
  });

  it('lists declared and stored flags with what each serves', async () => {
    await runtime.admin!.setRollout('new_player', 25, alice.actor);
    const res = await h.listFlags(alice, req());
    expect(res.status).toBe(200);
    const flags = body(res).flags as Array<Record<string, any>>;
    expect(flags.map((f) => f.key)).toEqual(['checkout', 'max_items', 'new_player']);
    const player = flags.find((f) => f.key === 'new_player')!;
    expect(player).toMatchObject({
      inRuleset: true,
      enabled: true,
      serving: { kind: 'rollout', percent: 25 },
      owner: 'video-team',
      tags: ['player'],
    });
    expect(player.declaration).toMatchObject({ type: 'boolean', default: false, apps: ['shop'] });
    const items = flags.find((f) => f.key === 'max_items')!;
    expect(items).toMatchObject({ inRuleset: false, serving: { kind: 'default', value: 10 } });
    expect(items.stale).toContain('expired');
  });

  it('reports the kill switch and splits in the serving summary', async () => {
    await runtime.admin!.saveFlag('checkout', checkoutExperiment, alice.actor);
    let flags = body(await h.listFlags(alice, req())).flags as Array<Record<string, any>>;
    expect(flags.find((f) => f.key === 'checkout')!.serving).toEqual({
      kind: 'split',
      arms: [
        { variant: 'control', percent: 50 },
        { variant: 'one_page', percent: 50 },
      ],
    });
    const off = await h.setEnabled(
      alice,
      req({ params: { key: 'checkout' }, body: { enabled: false } }),
    );
    expect(off.status).toBe(200);
    flags = body(await h.listFlags(alice, req())).flags as Array<Record<string, any>>;
    expect(flags.find((f) => f.key === 'checkout')!.serving).toEqual({
      kind: 'off',
      variant: 'control',
    });
  });

  it('shows a flag with its audit trail, and the declaration-implied definition before any edit', async () => {
    const fresh = body(await h.flagDetail(alice, req({ params: { key: 'new_player' } })));
    expect(fresh.stored).toBeNull();
    expect(fresh.definition).toMatchObject({
      variants: { on: true, off: false },
      offVariant: 'off',
    });

    await h.setVariant(alice, req({ params: { key: 'new_player' }, body: { variant: 'on' } }));
    const detail = body(await h.flagDetail(alice, req({ params: { key: 'new_player' } })));
    expect(detail.stored.fallthrough).toEqual({ variant: 'on' });
    expect(detail.audit).toHaveLength(1);
    expect(detail.audit[0]).toMatchObject({ action: 'create', actor: { id: 'alice' } });

    expect((await h.flagDetail(alice, req({ params: { key: 'nope' } }))).status).toBe(404);
  });

  it('saves a definition and maps validation errors to 422 with issues', async () => {
    const saved = await h.saveFlag(
      alice,
      req({
        params: { key: 'checkout' },
        body: { definition: checkoutExperiment, note: 'launch' },
      }),
    );
    expect(saved.status).toBe(200);
    expect(body(saved)).toMatchObject({ status: 'applied' });

    const wrongType = await h.saveFlag(
      alice,
      req({
        params: { key: 'max_items' },
        body: {
          definition: {
            variants: { default: 'ten' },
            enabled: true,
            offVariant: 'default',
            fallthrough: { variant: 'default' },
          },
        },
      }),
    );
    expect(wrongType.status).toBe(422);
    expect(body(wrongType).issues[0].path).toBe('flags.max_items.variants.default');

    // Garbage never reaches the engine: the shape check answers with a path.
    const garbage = await h.saveFlag(
      alice,
      req({ params: { key: 'checkout' }, body: { definition: { variants: {}, rules: 'x' } } }),
    );
    expect(garbage.status).toBe(422);
    expect(body(garbage).issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['definition.enabled', 'definition.rules']),
    );
  });

  it('previews a draft without saving it', async () => {
    const good = body(
      await h.preview(
        alice,
        req({ body: { change: { entity: 'flag', key: 'checkout', value: checkoutExperiment } } }),
      ),
    );
    expect(good).toMatchObject({ valid: true, issues: [], serving: { kind: 'split' } });

    const bad = body(
      await h.preview(
        alice,
        req({
          body: {
            change: {
              entity: 'flag',
              key: 'checkout',
              value: { ...checkoutExperiment, fallthrough: { variant: 'missing' } },
            },
          },
        }),
      ),
    );
    expect(bad.valid).toBe(false);
    expect(bad.issues[0].message).toMatch(/unknown variant "missing"/);
    expect(body(await h.listFlags(alice, req())).flags[0].inRuleset).toBe(false);
  });

  it('evaluates a context against the stored ruleset or a draft, without recording exposures', async () => {
    await runtime.admin!.saveFlag(
      'new_player',
      {
        variants: { on: true, off: false },
        enabled: true,
        offVariant: 'off',
        rules: [
          {
            id: 'staff',
            conditions: [{ attribute: 'email', op: 'endsWith', values: ['@shop.com'] }],
            serve: { variant: 'on' },
          },
        ],
        fallthrough: { variant: 'off' },
      },
      alice.actor,
    );
    const staff = body(
      await h.evaluateContext(
        alice,
        req({ body: { flag: 'new_player', context: { targetingKey: 'u1', email: 'a@shop.com' } } }),
      ),
    );
    expect(staff.result).toMatchObject({ value: true, reason: 'TARGETING_MATCH' });
    expect(staff.result.flagMetadata.ruleId).toBe('staff');

    const draft = body(
      await h.evaluateContext(
        alice,
        req({
          body: {
            flag: 'new_player',
            context: { targetingKey: 'u1' },
            definition: {
              variants: { on: true, off: false },
              enabled: true,
              offVariant: 'off',
              fallthrough: { variant: 'on' },
            },
          },
        }),
      ),
    );
    expect(draft.result.value).toBe(true);

    const all = body(
      await h.evaluateContext(alice, req({ body: { context: { targetingKey: 'u2' } } })),
    );
    expect(all.results.map((r: { flagKey: string }) => r.flagKey)).toEqual([
      'checkout',
      'max_items',
      'new_player',
    ]);
    expect(runtime.buffer!.pending).toBe(0);
  });

  it('applies the convenience edits and rejects bad input with 400', async () => {
    const key = { key: 'new_player' };
    expect((await h.setRollout(alice, req({ params: key, body: { percent: 40 } }))).status).toBe(
      200,
    );
    expect((await h.setRollout(alice, req({ params: key, body: { percent: 140 } }))).status).toBe(
      400,
    );
    expect((await h.setRollout(alice, req({ params: key, body: {} }))).status).toBe(400);
    expect(
      (await h.setRollout(alice, req({ params: { key: 'max_items' }, body: { percent: 10 } })))
        .status,
    ).toBe(400);
    expect((await h.setEnabled(alice, req({ params: key, body: { enabled: 'yes' } }))).status).toBe(
      400,
    );

    expect(
      (await h.setOverride(alice, req({ params: key, body: { subject: 'qa-1', variant: 'on' } })))
        .status,
    ).toBe(200);
    let def = body(await h.flagDetail(alice, req({ params: key }))).stored;
    expect(def.overrides).toEqual({ 'qa-1': 'on' });
    await h.setOverride(alice, req({ params: key, body: { subject: 'qa-1', variant: null } }));
    def = body(await h.flagDetail(alice, req({ params: key }))).stored;
    expect(def.overrides).toEqual({});

    expect((await h.deleteFlag(alice, req({ params: key }))).status).toBe(200);
    expect((await h.deleteFlag(alice, req({ params: key }))).status).toBe(404);
  });

  it('keeps edits to one environment', async () => {
    await h.setVariant(
      alice,
      req({ params: { key: 'new_player' }, body: { variant: 'on', environment: 'staging' } }),
    );
    const staging = body(await h.listFlags(alice, req({ query: { environment: 'staging' } })));
    const production = body(await h.listFlags(alice, req()));
    expect(staging.flags.find((f: { key: string }) => f.key === 'new_player').inRuleset).toBe(true);
    expect(production.flags.find((f: { key: string }) => f.key === 'new_player').inRuleset).toBe(
      false,
    );
    expect((await h.listFlags(alice, req({ query: { environment: 'bad env!' } }))).status).toBe(
      400,
    );
  });

  it('manages segments and refuses to delete one a rule still uses', async () => {
    const saved = await h.saveSegment(
      alice,
      req({
        params: { key: 'staff' },
        body: {
          segment: {
            included: ['u1'],
            conditions: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
          },
        },
      }),
    );
    expect(saved.status).toBe(200);
    await runtime.admin!.saveFlag(
      'new_player',
      {
        variants: { on: true, off: false },
        enabled: true,
        offVariant: 'off',
        rules: [{ id: 'r1', conditions: [{ segment: 'staff' }], serve: { variant: 'on' } }],
        fallthrough: { variant: 'off' },
      },
      alice.actor,
    );
    const list = body(await h.listSegments(alice, req()));
    expect(list.segments).toEqual([
      expect.objectContaining({ key: 'staff', usedBy: ['new_player'] }),
    ]);
    const refused = await h.deleteSegment(alice, req({ params: { key: 'staff' } }));
    expect(refused.status).toBe(422);
    const bad = await h.saveSegment(
      alice,
      req({ params: { key: 'x' }, body: { segment: { included: 'u1' } } }),
    );
    expect(bad.status).toBe(422);
  });

  it('manages layers with allocation ranges and the global holdout', async () => {
    await runtime.admin!.saveFlag(
      'checkout',
      { ...checkoutExperiment, experiment: {} },
      alice.actor,
    );
    // The flag must name the layer and the layer must exist: save both through import-like steps.
    const layer = await h.saveLayer(
      alice,
      req({ params: { key: 'checkout_layer' }, body: { layer: { allocations: {} } } }),
    );
    expect(layer.status).toBe(200);
    await runtime.admin!.saveFlag(
      'checkout',
      { ...checkoutExperiment, experiment: { layer: 'checkout_layer' } },
      alice.actor,
    );
    const allocated = await h.saveLayer(
      alice,
      req({
        params: { key: 'checkout_layer' },
        body: { layer: { allocations: { checkout: [0, 5000] } } },
      }),
    );
    expect(allocated.status).toBe(200);
    const overlapping = await h.saveLayer(
      alice,
      req({
        params: { key: 'checkout_layer' },
        body: { layer: { allocations: { checkout: [0, 20000] } } },
      }),
    );
    expect(overlapping.status).toBe(422);

    expect((await h.saveHoldout(alice, req({ body: { holdout: { percent: 5 } } }))).status).toBe(
      200,
    );
    expect((await h.saveHoldout(alice, req({ body: { holdout: { percent: 500 } } }))).status).toBe(
      422,
    );
    const listed = body(await h.listLayers(alice, req()));
    expect(listed.layers).toEqual([
      expect.objectContaining({ key: 'checkout_layer', allocatedPercent: 50 }),
    ]);
    expect(listed.holdout).toEqual({ percent: 5 });
    expect(listed.experiments).toEqual([
      { flag: 'checkout', experiment: 'checkout', layer: 'checkout_layer', holdout: true },
    ]);
    expect((await h.saveHoldout(alice, req({ body: { holdout: null } }))).status).toBe(200);
    expect(body(await h.listLayers(alice, req())).holdout).toBeNull();
  });

  it('lists experiments, recomputes results on demand, and 404s unknown ones', async () => {
    await runtime.admin!.saveFlag('checkout', checkoutExperiment, alice.actor);
    await runtime.manager.refresh();
    for (let i = 0; i < 60; i++) {
      const scope = runtime.manager.for(`u${i}`);
      const variant = await scope.variant('checkout');
      if (variant === 'one_page' || i % 4 === 0) await scope.track('purchase');
    }
    await runtime.buffer!.flush();
    await runtime.relay!.drain('warehouse', 1000);

    let list = body(await h.listExperiments(alice, req()));
    expect(list.experiments).toEqual([
      expect.objectContaining({
        key: 'checkout',
        configured: true,
        running: true,
        computedAt: null,
      }),
    ]);
    const recomputed = await h.recomputeExperiment(alice, req({ params: { key: 'checkout' } }));
    expect(recomputed.status).toBe(200);
    expect(body(recomputed).results.metrics[0].name).toBe('purchase');

    list = body(await h.listExperiments(alice, req()));
    expect(list.experiments[0].exposures).toBe(60);
    const detail = body(await h.experimentDetail(alice, req({ params: { key: 'checkout' } })));
    expect(detail.results.experiment).toBe('checkout');
    expect((await h.experimentDetail(alice, req({ params: { key: 'nope' } }))).status).toBe(404);
    expect((await h.recomputeExperiment(alice, req({ params: { key: 'nope' } }))).status).toBe(404);
  });

  describe('change requests', () => {
    let strict: FlagsRuntime;

    beforeEach(async () => {
      strict = await createRuntime(
        { ...config, approvals: { environments: ['production'] } },
        lucidContext(testDb.database as never),
        { logger: quietLogger, start: false },
      );
      setRuntime(strict);
    });

    afterEach(async () => {
      await strict.close();
    });

    it('files a request (202) and only a second person can approve it', async () => {
      const filed = await h.setVariant(
        alice,
        req({ params: { key: 'new_player' }, body: { variant: 'on', note: 'ship it' } }),
      );
      expect(filed.status).toBe(202);
      const id = body(filed).request.id as string;

      const pending = body(await h.listChangeRequests(alice, req()));
      expect(pending.requiresApproval).toBe(true);
      expect(pending.requests).toEqual([expect.objectContaining({ id, note: 'ship it' })]);

      const self = await h.approveChangeRequest(alice, req({ params: { id } }));
      expect(self.status).toBe(403);
      expect(body(self).error).toMatch(/requested it/);

      const approved = await h.approveChangeRequest(
        bob,
        req({ params: { id }, body: { note: 'lgtm' } }),
      );
      expect(approved.status).toBe(200);
      expect(body(approved).request.status).toBe('applied');

      expect((await h.approveChangeRequest(bob, req({ params: { id } }))).status).toBe(409);
      expect((await h.approveChangeRequest(bob, req({ params: { id: 'missing' } }))).status).toBe(
        404,
      );
      const all = body(await h.listChangeRequests(alice, req({ query: { status: 'all' } })));
      expect(all.requests).toHaveLength(1);
    });

    it('rejects, and lets only the requester cancel', async () => {
      const a = body(
        await h.setVariant(alice, req({ params: { key: 'new_player' }, body: { variant: 'on' } })),
      );
      const b = body(
        await h.setVariant(alice, req({ params: { key: 'new_player' }, body: { variant: 'off' } })),
      );
      const rejected = await h.rejectChangeRequest(
        bob,
        req({ params: { id: a.request.id }, body: { note: 'no' } }),
      );
      expect(body(rejected).request).toMatchObject({ status: 'rejected', reviewNote: 'no' });
      expect((await h.cancelChangeRequest(bob, req({ params: { id: b.request.id } }))).status).toBe(
        403,
      );
      const cancelled = await h.cancelChangeRequest(alice, req({ params: { id: b.request.id } }));
      expect(body(cancelled).request.status).toBe('cancelled');
      expect((await h.listChangeRequests(alice, req({ query: { status: 'bogus' } }))).status).toBe(
        400,
      );
    });
  });

  it('maps an authorize refusal from FlagsAdmin to 403', async () => {
    const locked = await createRuntime(
      { ...config, authorize: (actor) => actor.id === 'alice' },
      lucidContext(testDb.database as never),
      { logger: quietLogger, start: false },
    );
    setRuntime(locked);
    const res = await h.setVariant(
      bob,
      req({ params: { key: 'new_player' }, body: { variant: 'on' } }),
    );
    expect(res.status).toBe(403);
    expect(
      (await h.setVariant(alice, req({ params: { key: 'new_player' }, body: { variant: 'on' } })))
        .status,
    ).toBe(200);
    await locked.close();
  });

  it('schedules single changes and gradual rollouts, and cancels pending ones', async () => {
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const one = await h.createSchedule(
      alice,
      req({ params: { key: 'new_player' }, body: { kind: 'disable', runAt: at(1) } }),
    );
    expect(one.status).toBe(201);
    const steps = await h.createSchedule(
      alice,
      req({
        params: { key: 'new_player' },
        body: {
          steps: [
            { at: at(48), percent: 50 },
            { at: at(24), percent: 10 },
          ],
        },
      }),
    );
    expect(
      body(steps).schedules.map((s: { payload: { percent: number } }) => s.payload.percent),
    ).toEqual([10, 50]);

    expect(
      (
        await h.createSchedule(
          alice,
          req({
            params: { key: 'new_player' },
            body: { kind: 'rollout', runAt: at(1), percent: 101 },
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.createSchedule(
          alice,
          req({ params: { key: 'new_player' }, body: { kind: 'enable', runAt: 'soon' } }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await h.createSchedule(
          alice,
          req({ params: { key: 'ghost' }, body: { kind: 'enable', runAt: at(1) } }),
        )
      ).status,
    ).toBe(404);

    const listed = body(await h.listSchedules(alice, req({ query: { flag: 'new_player' } })));
    expect(listed.schedules).toHaveLength(3);
    const id = body(one).schedules[0].id as string;
    const cancelled = await h.cancelSchedule(alice, req({ params: { id } }));
    expect(body(cancelled).schedule.status).toBe('cancelled');
    expect((await h.cancelSchedule(alice, req({ params: { id } }))).status).toBe(409);
    expect((await h.cancelSchedule(alice, req({ params: { id: 'missing' } }))).status).toBe(404);
  });

  it('reads the audit trail with filters', async () => {
    await runtime.admin!.turnOn('new_player', alice.actor);
    await runtime.admin!.turnOff('new_player', bob.actor);
    await h.saveSegment(
      alice,
      req({ params: { key: 's' }, body: { segment: { included: ['x'] } } }),
    );
    const flagOnly = body(
      await h.audit(alice, req({ query: { entity: 'flag', key: 'new_player' } })),
    );
    expect(flagOnly.entries.map((e: { actor: { id: string } }) => e.actor.id)).toEqual([
      'bob',
      'alice',
    ]);
    const limited = body(await h.audit(alice, req({ query: { limit: '1' } })));
    expect(limited.entries).toHaveLength(1);
    expect((await h.audit(alice, req({ query: { entity: 'nope' } }))).status).toBe(400);
  });

  it('exports, imports and promotes', async () => {
    await runtime.admin!.turnOn('new_player', alice.actor, { environment: 'staging' });
    const exported = body(await h.exportRuleset(alice, req({ query: { environment: 'staging' } })));
    expect(exported.flags.new_player.fallthrough).toEqual({ variant: 'on' });

    const imported = await h.importRuleset(
      alice,
      req({ body: { environment: 'qa', ruleset: exported } }),
    );
    expect(imported.status).toBe(200);
    expect(
      body(await h.exportRuleset(alice, req({ query: { environment: 'qa' } }))).flags.new_player,
    ).toBeTruthy();
    expect((await h.importRuleset(alice, req({ body: { ruleset: { nope: 1 } } }))).status).toBe(
      422,
    );

    const promoted = await h.promote(alice, req({ body: { from: 'staging', to: 'production' } }));
    expect(promoted.status).toBe(200);
    expect(body(await h.exportRuleset(alice, req())).flags.new_player.fallthrough).toEqual({
      variant: 'on',
    });
    expect((await h.promote(alice, req({ body: { from: 'staging', to: 'staging' } }))).status).toBe(
      400,
    );
  });

  it('reports stale flags with configurable windows', async () => {
    await runtime.admin!.setEnabled('new_player', true, alice.actor);
    const later = { ...alice, now: () => new Date(Date.now() + 40 * 86_400_000) };
    const res = body(await h.stale(later, req({ query: { unusedDays: '7' } })));
    expect(res.unusedDays).toBe(7);
    const entry = res.flags.find((f: { key: string }) => f.key === 'new_player');
    expect(entry.reasons).toEqual(expect.arrayContaining(['unused', 'static']));
    expect((await h.stale(alice, req({ query: { unusedDays: '-1' } }))).status).toBe(400);
  });

  it('reports ops: source, buffer, transport and per-sink lag', async () => {
    await runtime.manager.track('u1', 'purchase');
    await runtime.buffer!.flush();
    const res = body(await h.ops(alice, req()));
    expect(res).toMatchObject({
      app: 'shop',
      topology: 'standalone',
      source: { mode: 'poll' },
      transport: { name: 'db', transactional: true, durable: true },
      relay: true,
      analytics: true,
    });
    expect(res.sinks).toEqual([expect.objectContaining({ sink: 'warehouse', lag: 1 })]);
  });
});

describe('error mapping', () => {
  it('maps admin errors to statuses', () => {
    expect(h.errorResponse(new RangeError('percent')).status).toBe(400);
    expect(h.errorResponse(new Error('change request x not found')).status).toBe(404);
    expect(h.errorResponse(new Error('change request x is applied')).status).toBe(409);
    expect(h.errorResponse(new Error('boom')).status).toBe(500);
  });

  it('summarizes serving', () => {
    expect(
      h.servingSummary({
        variants: { a: 1, b: 2, c: 3 },
        enabled: true,
        offVariant: 'a',
        fallthrough: {
          split: [
            { variant: 'a', weight: 1 },
            { variant: 'b', weight: 1 },
            { variant: 'c', weight: 2 },
          ],
          bucketBy: 'orgId',
        },
      }),
    ).toEqual({
      kind: 'split',
      bucketBy: 'orgId',
      arms: [
        { variant: 'a', percent: 25 },
        { variant: 'b', percent: 25 },
        { variant: 'c', percent: 50 },
      ],
    });
  });
});
