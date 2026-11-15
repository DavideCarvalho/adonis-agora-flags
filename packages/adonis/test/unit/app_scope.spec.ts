import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anyAuthorize,
  normalizeConsoleAuthorizeResult,
} from '../../src/dashboard/console_authorize.js';
import * as h from '../../src/dashboard/handlers.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { defineConfig, metric, sinks } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { sharedSecretVerifier } from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';

const req = (
  parts: { params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown } = {},
): h.ApiRequest => ({ params: parts.params ?? {}, query: parts.query ?? {}, body: parts.body });

const body = (response: h.ApiResponse) => response.body as Record<string, any>;

const checkout = {
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

describe('seeing one app on a central server', () => {
  let db: TestDb;
  let cp: FlagsRuntime;
  let server: Server;
  let base: string;
  let everyone: h.Deps;
  let shopOnly: h.Deps;

  beforeEach(async () => {
    db = await sqliteDb();
    cp = await createRuntime(
      defineConfig({
        topology: 'control-plane',
        flags: {},
        metrics: { purchase: metric.conversion('purchase') },
        experiments: { checkout: { metrics: ['purchase'] } },
        sinks: { warehouse: sinks.lucid() },
        verifyTenant: sharedSecretVerifier({
          partitions: { shop: 'shop-secret', blog: 'blog-secret' },
        }),
      }),
      lucidContext(db.database as never),
      { logger: quietLogger, runWorker: false },
    );
    const plane = new ControlPlane(cp, {
      verifyTenant: (cp.config as { verifyTenant: never }).verifyTenant,
    });
    const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
    plane.register({
      get: (pattern, handler) => {
        routes.push({ method: 'GET', pattern, handler: handler as Handler });
        return { as: () => {} };
      },
      post: (pattern, handler) => {
        routes.push({ method: 'POST', pattern, handler: handler as Handler });
        return { as: () => {} };
      },
    });
    server = await serve(routes);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/_flags`;
    everyone = { runtime: cp, actor: { id: 'alice' } };
    shopOnly = { runtime: cp, actor: { id: 'sam' }, apps: ['shop'] };
    await cp.admin!.saveFlag('checkout', checkout, everyone.actor);
    await cp.manager.refresh();
  });

  afterEach(async () => {
    await cp.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

  const post = (app: 'shop' | 'blog', path: string, payload: unknown, claimed: string = app) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${app}-secret`,
        'x-flags-tenant': claimed,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  /** `n` subjects of `app` exposed to checkout, alternating variants; every other one purchases. */
  const traffic = (app: 'shop' | 'blog', n: number, extra: Record<string, unknown> = {}) => {
    const now = Date.now();
    const events = [];
    for (let i = 0; i < n; i++) {
      const subject = `${app}-${i}`;
      events.push({
        id: `${app}-x-${i}`,
        type: 'exposure',
        flag: 'checkout',
        experiment: 'checkout',
        variant: i % 2 === 0 ? 'control' : 'one_page',
        subject,
        ts: now - 1000,
        ...extra,
      });
      if (i % 2 === 1)
        events.push({
          id: `${app}-t-${i}`,
          type: 'track',
          name: 'purchase',
          subject,
          ts: now,
          ...extra,
        });
    }
    return post(app, '/v1/events', { events });
  };

  const ingest = async () => {
    expect((await traffic('shop', 10)).status).toBe(202);
    expect((await traffic('blog', 6)).status).toBe(202);
    await cp.relay!.drain('warehouse', 1000);
  };

  it('stores the partition and environment of the verified token, never the request', async () => {
    // A blog token claiming to be shop is refused outright.
    expect((await post('blog', '/v1/events', { events: [] }, 'shop')).status).toBe(401);

    // Claims in the payload are ignored.
    expect(
      (await traffic('blog', 2, { app: 'shop', environment: 'staging', partition: 'shop' })).status,
    ).toBe(202);
    await cp.relay!.drain('warehouse', 1000);
    const exposures = (await db.database.rawQuery(
      'SELECT DISTINCT app, environment FROM flags_exposures',
    )) as Array<{ app: string; environment: string }>;
    expect(exposures).toEqual([{ app: 'blog', environment: 'production' }]);
    const events = (await db.database.rawQuery(
      'SELECT DISTINCT app, environment FROM flags_events',
    )) as Array<{ app: string; environment: string }>;
    expect(events).toEqual([{ app: 'blog', environment: 'production' }]);

    // Evaluation counts too.
    const today = new Date().toISOString().slice(0, 10);
    const usage = await post('blog', '/v1/usage', {
      rows: [{ flag: 'checkout', day: today, evaluations: 3, app: 'shop' }],
    });
    expect(usage.status).toBe(204);
    const since = '2000-01-01';
    expect(await cp.store!.usage({ environment: 'production', since, apps: ['blog'] })).toEqual([
      { environment: 'production', app: 'blog', flag: 'checkout', day: today, evaluations: 3 },
    ]);
    expect(await cp.store!.usage({ environment: 'production', since, apps: ['shop'] })).toEqual([]);
    expect(await cp.store!.usage({ environment: 'production', since })).toEqual([
      { environment: 'production', flag: 'checkout', day: today, evaluations: 3 },
    ]);
  });

  it("filters experiment results by app; without one, every app's", async () => {
    await ingest();
    const exposures = async (deps: h.Deps, app?: string) => {
      const res = await h.experimentDetail(
        deps,
        req({ params: { key: 'checkout' }, query: app ? { app } : {} }),
      );
      expect(res.status).toBe(200);
      const results = body(res).results;
      return results
        ? Object.values(results.exposures as Record<string, number>).reduce((a, b) => a + b, 0)
        : null;
    };
    expect(await exposures(everyone, 'shop')).toBe(10);
    expect(await exposures(everyone, 'blog')).toBe(6);
    // Every app: the worker's cached results, once computed.
    expect(await exposures(everyone)).toBeNull();
    expect(
      (await h.recomputeExperiment(everyone, req({ params: { key: 'checkout' } }))).status,
    ).toBe(200);
    expect(await exposures(everyone)).toBe(16);

    const scoped = body(
      await h.experimentDetail(
        everyone,
        req({ params: { key: 'checkout' }, query: { app: 'blog' } }),
      ),
    );
    expect(scoped.apps).toEqual(['blog']);
    expect(scoped.results.apps).toEqual(['blog']);
    expect(
      scoped.results.metrics[0].variants.map((v: { variant: string; n: number }) => [
        v.variant,
        v.n,
      ]),
    ).toEqual([
      ['control', 3],
      ['one_page', 3],
    ]);

    const list = body(await h.listExperiments(everyone, req({ query: { app: 'shop' } })));
    expect(list.data[0].exposures).toBe(10);

    const recomputed = body(
      await h.recomputeExperiment(
        everyone,
        req({ params: { key: 'checkout' }, body: { app: 'shop' } }),
      ),
    );
    expect(recomputed.apps).toEqual(['shop']);
    // A scoped recompute leaves the every-app cache alone.
    expect(await exposures(everyone)).toBe(16);
  });

  it('judges unused flags by the chosen app', async () => {
    await cp.admin!.saveFlag(
      'banner',
      {
        variants: { on: true, off: false },
        enabled: true,
        offVariant: 'off',
        fallthrough: { variant: 'on' },
      },
      everyone.actor,
    );
    const today = new Date().toISOString().slice(0, 10);
    await post('shop', '/v1/usage', { rows: [{ flag: 'banner', day: today, evaluations: 5 }] });
    const unused = async (app?: string) =>
      body(await h.stale(everyone, req({ query: app ? { app } : {} })))
        .data.filter((f: { reasons: string[] }) => f.reasons.includes('unused'))
        .map((f: { key: string }) => f.key);
    expect(await unused('shop')).not.toContain('banner');
    expect(await unused('blog')).toContain('banner');
    expect(await unused()).not.toContain('banner');
  });

  it('lists the apps in meta and the connected tenants in ops', async () => {
    await ingest();
    const meta = body(await h.meta(everyone, req()));
    expect(meta.apps).toEqual(['blog', 'shop']);
    expect(meta.appScope).toBe('*');
    const tenants = (deps: h.Deps, app?: string) =>
      h
        .ops(deps, req({ query: app ? { app } : {} }))
        .then((r) => body(r).tenants.map((t: { partition: string }) => t.partition));
    expect(await tenants(everyone)).toEqual(expect.arrayContaining(['blog', 'shop']));
    expect(await tenants(everyone, 'blog')).toEqual(['blog']);
  });

  it('never shows a viewer limited to one app anything of another', async () => {
    await ingest();
    expect(
      (
        await post('blog', '/v1/declarations', {
          declarations: { blog_banner: { type: 'boolean', default: false } },
        })
      ).status,
    ).toBe(204);

    const meta = body(await h.meta(shopOnly, req()));
    expect(meta.apps).toEqual(['shop']);
    expect(meta.appScope).toEqual(['shop']);

    // Without `app`: only shop's numbers.
    const list = body(await h.listExperiments(shopOnly, req()));
    expect(list.apps).toEqual(['shop']);
    expect(list.data[0].exposures).toBe(10);
    const detail = body(await h.experimentDetail(shopOnly, req({ params: { key: 'checkout' } })));
    expect(detail.results.apps).toEqual(['shop']);

    // Asking for blog, through every route that reads app data: 403.
    const blog = { query: { app: 'blog' } };
    const refused = [
      await h.listExperiments(shopOnly, req(blog)),
      await h.experimentDetail(shopOnly, req({ ...blog, params: { key: 'checkout' } })),
      await h.recomputeExperiment(
        shopOnly,
        req({ params: { key: 'checkout' }, body: { app: 'blog' } }),
      ),
      await h.stale(shopOnly, req(blog)),
      await h.ops(shopOnly, req(blog)),
      await h.listFlags(shopOnly, req(blog)),
    ];
    for (const res of refused) expect(res.status).toBe(403);

    // The connected apps and the apps declaring a flag leave blog out.
    const tenants = body(await h.ops(shopOnly, req())).tenants.map(
      (t: { partition: string }) => t.partition,
    );
    expect(tenants).toEqual(['shop']);
    const flags = body(await h.listFlags(shopOnly, req())).data;
    const banner = flags.find((f: { key: string }) => f.key === 'blog_banner');
    expect(banner.declaration.apps).toEqual([]);
    const all = body(await h.listFlags(everyone, req())).data;
    expect(all.find((f: { key: string }) => f.key === 'blog_banner').declaration.apps).toEqual([
      'blog',
    ]);

    // A viewer allowed no app sees no numbers at all.
    const none = body(
      await h.experimentDetail(
        { runtime: cp, actor: { id: 'nobody' }, apps: [] },
        req({ params: { key: 'checkout' } }),
      ),
    );
    expect(Object.values(none.results.exposures)).toEqual([]);
  });
});

describe('console authorize apps', () => {
  it('keeps apps from the answer, and never widens a malformed one', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true })).toEqual({ allowed: true });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: '*' })).toEqual({
      allowed: true,
      apps: '*',
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: ['shop', 'shop', ''] })).toEqual({
      allowed: true,
      apps: ['shop'],
    });
    expect(normalizeConsoleAuthorizeResult({ allowed: true, apps: 'shop' })).toEqual({
      allowed: true,
      apps: [],
    });
    expect(normalizeConsoleAuthorizeResult(true)).toEqual({ allowed: true });
  });

  it('anyAuthorize passes on the apps of the check that allowed', async () => {
    const authorize = anyAuthorize(
      () => ({ allowed: false }),
      () => ({ allowed: true, apps: ['blog'] }),
    );
    expect(await authorize({} as never)).toEqual({ allowed: true, apps: ['blog'] });
  });
});
