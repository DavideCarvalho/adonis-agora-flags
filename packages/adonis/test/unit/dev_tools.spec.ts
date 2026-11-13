import { IgnitorFactory } from '@adonisjs/core/factories';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpActor } from '../../providers/dashboard_provider.js';
import { anyAuthorize, authorizeByToken } from '../../src/dashboard/console_authorize.js';
import { defineConfig as defineDashboardConfig } from '../../src/dashboard/define_config.js';
import {
  type DevTool,
  type DevToolsLib,
  registerFlagsDevTools,
} from '../../src/dashboard/dev_tools.js';
import { flag } from '../../src/declare.js';
import { defineConfig, stores, transports } from '../../src/define_config.js';

const limits = { maxRows: 100, maxBytes: 48 * 1024 };
const tokenCall = { caller: { id: 'token:3f9a1c2b7d10', via: 'token' as const }, limits };

function tool(lib: DevToolsLib, name: string): DevTool {
  const found = lib.tools.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

describe('flags dev tools (MCP)', () => {
  let app: ApplicationService;
  let lib: DevToolsLib;
  const ctx = {} as HttpContext;
  const run = (name: string, input: Record<string, unknown> = {}) =>
    tool(lib, name).run(input, { ctx, ...tokenCall });

  beforeAll(async () => {
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: {
          providers: [
            () => import('../../providers/flags_provider.js'),
            () => import('../../providers/dashboard_provider.js'),
          ],
        },
        config: {
          flags: defineConfig({
            flags: {
              new_player: flag.boolean({ default: false, owner: 'video', tags: ['player'] }),
              checkout: flag.string({ default: 'control', variants: ['control', 'one_page'] }),
            },
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            dispatcher: 'in-process',
          }),
          flags_dashboard: defineDashboardConfig({ authorize: () => true }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('web') as ApplicationService;
    await app.init();
    // What `@adonis-agora/agent/mcp_provider` binds in its register().
    app.container.singleton('agora.devTools' as never, () => ({
      version: 1,
      register: (registered: DevToolsLib) => {
        lib = registered;
      },
    }));
    await app.boot();
  });

  afterAll(async () => {
    await app.terminate();
  });

  it('registers prefixed read and action tools with the console gate', async () => {
    expect(lib.lib).toBe('flags');
    expect(lib.tools.every((t) => t.name.startsWith('flags_'))).toBe(true);
    expect(lib.tools.filter((t) => t.kind === 'read').map((t) => t.name)).toEqual([
      'flags_get_overview',
      'flags_list_flags',
      'flags_get_flag',
      'flags_evaluate',
      'flags_list_segments',
      'flags_list_metrics',
      'flags_list_experiments',
      'flags_get_experiment',
      'flags_list_change_requests',
      'flags_list_audit',
      'flags_list_stale',
      'flags_get_ops',
    ]);
    expect(tool(lib, 'flags_set_enabled').destructive).toBe(true);
    expect(tool(lib, 'flags_save_flag').destructive).toBe(true);
    for (const t of lib.tools) {
      for (const property of Object.values(t.input.properties)) {
        expect(['string', 'number', 'integer', 'boolean', 'array']).toContain(property.type);
      }
    }
    expect(await lib.authorize(ctx)).toEqual({ allowed: true });
  });

  it('lists flags with filters and paging', async () => {
    const all = (await run('flags_list_flags')) as { items: Array<{ key: string }>; next: unknown };
    expect(all.items.map((f) => f.key)).toEqual(['checkout', 'new_player']);
    expect(all.next).toBeNull();
    const tagged = (await run('flags_list_flags', { tag: 'player' })) as {
      items: Array<{ key: string }>;
    };
    expect(tagged.items.map((f) => f.key)).toEqual(['new_player']);
    const paged = (await run('flags_list_flags', { limit: 1 })) as {
      items: unknown[];
      next: unknown;
    };
    expect(paged).toMatchObject({ next: 2 });
    expect(paged.items).toHaveLength(1);
  });

  it('changes a flag as the MCP caller and evaluates the result', async () => {
    const applied = (await run('flags_set_rollout', {
      key: 'new_player',
      percent: 100,
      note: 'ship it',
    })) as { status: string };
    expect(applied.status).toBe('applied');
    const evaluated = (await run('flags_evaluate', {
      key: 'new_player',
      targetingKey: 'u1',
      attributes: '{"plan":"pro"}',
    })) as { result: { value: unknown } };
    expect(evaluated.result.value).toBe(true);

    const history = (await run('flags_list_audit', { key: 'new_player' })) as {
      items: Array<{ actor: { id: string } }>;
      next: unknown;
    };
    expect(history.items[0]?.actor.id).toBe('mcp:token:3f9a1c2b7d10');
    expect(history.next).toBeNull();

    const detail = (await run('flags_get_flag', { key: 'new_player' })) as Record<string, unknown>;
    expect(detail.flags).toBeUndefined();
    expect((detail.audit as unknown[]).length).toBeLessThanOrEqual(10);
  });

  it('creates console metrics and reports console errors as tool errors', async () => {
    await run('flags_save_metric', {
      key: 'signup',
      kind: 'conversion',
      event: 'signup',
      windowDays: 7,
    });
    const metrics = (await run('flags_list_metrics')) as {
      items: Array<{ name: string; metric: unknown; source: string }>;
      next: unknown;
    };
    expect(metrics.next).toBeNull();
    expect(metrics.items).toEqual([
      expect.objectContaining({
        name: 'signup',
        metric: { kind: 'conversion', event: 'signup', windowMs: 7 * 86_400_000 },
        source: 'console',
      }),
    ]);

    await expect(
      run('flags_save_flag', { key: 'checkout', definition: 'not json' }),
    ).rejects.toThrow('definition must be a JSON object');
    await expect(
      run('flags_save_flag', {
        key: 'checkout',
        definition: JSON.stringify({
          variants: { control: 'control' },
          enabled: true,
          offVariant: 'nope',
          fallthrough: { variant: 'control' },
        }),
      }),
    ).rejects.toThrow(/422: .*offVariant/);
    await expect(run('flags_get_flag', { key: 'missing' })).rejects.toThrow(/^404: /);
  });

  it('pages every list tool with page and limit, like the filter dev tools', async () => {
    for (const key of ['a_metric', 'b_metric', 'c_metric']) {
      await run('flags_save_metric', { key, kind: 'count', event: key });
    }
    const first = (await run('flags_list_metrics', { limit: 2 })) as {
      environment: string;
      items: Array<{ name: string }>;
      next: unknown;
    };
    expect(first.environment).toBe('production');
    expect(first.items).toHaveLength(2);
    expect(first.next).toBe(2);
    const second = (await run('flags_list_metrics', { limit: 2, page: 2 })) as {
      items: Array<{ name: string }>;
      next: unknown;
    };
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
    expect([...first.items, ...second.items].map((m) => m.name)).toEqual(
      expect.arrayContaining(['signup', 'a_metric', 'b_metric', 'c_metric']),
    );

    const audit = (await run('flags_list_audit', { entity: 'metric', limit: 2 })) as {
      items: unknown[];
      next: unknown;
      limit?: unknown;
    };
    expect(audit.items).toHaveLength(2);
    expect(audit.next).toBe(2);
    expect(audit.limit).toBeUndefined();
    const older = (await run('flags_list_audit', { entity: 'metric', limit: 2, page: 2 })) as {
      items: unknown[];
      next: unknown;
    };
    expect(older.items.length).toBeGreaterThanOrEqual(1);

    for (const name of [
      'flags_list_segments',
      'flags_list_experiments',
      'flags_list_change_requests',
      'flags_list_stale',
    ]) {
      const out = (await run(name, { limit: 1 })) as Record<string, unknown>;
      expect(Array.isArray(out.items), name).toBe(true);
      expect(out, name).toHaveProperty('next');
      for (const property of ['page', 'limit']) {
        expect(tool(lib, name).input.properties, name).toHaveProperty(property);
      }
    }
  });
});

describe('registerFlagsDevTools', () => {
  it('skips registration without a hub or with another contract version', async () => {
    const options = {
      authorize: async () => ({ allowed: true }) as const,
      serve: async () => ({ status: 200, body: {} }),
    };
    expect(
      await registerFlagsDevTools(
        { hasBinding: () => false, make: async () => undefined },
        options,
      ),
    ).toBe(false);
    expect(
      await registerFlagsDevTools(
        { hasBinding: () => true, make: async () => ({ version: 2, register() {} }) },
        options,
      ),
    ).toBe(false);
  });
});

describe('mcpActor', () => {
  it('keeps an identified person and names anonymous callers after their token', () => {
    expect(mcpActor({ id: 'u1', name: 'Ana' }, tokenCall.caller)).toEqual({
      id: 'u1',
      name: 'Ana',
    });
    expect(mcpActor({ id: 'dashboard', anonymous: true }, tokenCall.caller)).toEqual({
      id: 'mcp:token:3f9a1c2b7d10',
      name: 'MCP',
    });
    expect(
      mcpActor({ id: 'dashboard', anonymous: true }, { id: 'dev-open', via: 'open' }),
    ).toMatchObject({ anonymous: true });
  });
});

describe('anyAuthorize', () => {
  const ctxWith = (authorization?: string) =>
    ({ request: { header: () => authorization } }) as unknown as HttpContext;

  it('allows when any check allows, else the strongest refusal', async () => {
    const byToken = authorizeByToken({ token: 's3cret' });
    const either = anyAuthorize(byToken, () => false);
    expect(await either(ctxWith('Bearer s3cret'))).toEqual({ allowed: true });
    expect(await either(ctxWith())).toEqual({ allowed: false, reason: 'unauthenticated' });
    expect(await anyAuthorize(() => false)(ctxWith())).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(await anyAuthorize(() => ({ redirectTo: '/login' }), byToken)(ctxWith())).toEqual({
      redirectTo: '/login',
    });
  });
});
