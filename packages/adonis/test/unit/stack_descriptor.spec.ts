import { afterEach, describe, expect, it, vi } from 'vitest';
import { analytics, defineConfig, sinks, stores, transports } from '../../src/define_config.js';
import { STACK_DESCRIPTOR } from '../../src/stack.js';
import { tenantTransports } from '../../src/tenant_transports/index.js';

const uses = (value: object) => (value as Record<symbol, unknown>)[STACK_DESCRIPTOR];

const appConfig = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('@adonisjs/core/services/app', () => ({
  default: { config: { get: (key: string) => appConfig.current[key] } },
}));

function fakeApp(config: Record<string, unknown>) {
  appConfig.current = config;
}

afterEach(() => {
  appConfig.current = {};
});

describe('stack descriptors', () => {
  it('is the shared global symbol, not enumerable', () => {
    const factory = stores.lucid({ connection: 'main' });
    expect(STACK_DESCRIPTOR).toBe(Symbol.for('@adonis-agora/stack'));
    expect(Object.getOwnPropertySymbols(factory)).toContain(STACK_DESCRIPTOR);
    expect(Object.keys(factory)).toEqual([]);
  });

  it('names the lucid connection and its client', () => {
    fakeApp({
      database: {
        connection: 'pg',
        connections: { pg: { client: 'pg' }, lite: { client: 'better-sqlite3' } },
      },
    });
    expect(uses(stores.lucid())).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'ruleset' },
    ]);
    expect(uses(transports.db({ connection: 'lite' }))).toEqual([
      { tech: 'sqlite', connection: 'lite', purpose: 'event log' },
    ]);
    expect(uses(sinks.lucid())).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'exposures' },
    ]);
    expect(uses(analytics.lucid())).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'experiments' },
    ]);
  });

  it('describes redis, clickhouse, posthog and parquet without credentials', () => {
    fakeApp({ redis: { connection: 'main' } });
    expect(uses(transports.redis())).toEqual([
      { tech: 'redis', connection: 'main', purpose: 'event log' },
    ]);
    expect(
      uses(sinks.clickhouse({ url: 'https://user:secret@ch.example.com:8443', database: 'flags' })),
    ).toEqual([
      { tech: 'clickhouse', label: 'flags', host: 'ch.example.com:8443', purpose: 'exposures' },
    ]);
    expect(uses(analytics.clickhouse({ url: 'http://localhost:8123' }))).toEqual([
      { tech: 'clickhouse', label: 'default', host: 'localhost:8123', purpose: 'experiments' },
    ]);
    expect(uses(sinks.posthog({ apiKey: 'phc_x' }))).toEqual([
      { tech: 'posthog', label: 'posthog', host: 'us.i.posthog.com', purpose: 'exposures' },
    ]);
    expect(uses(sinks.parquet({ path: 's3://bucket/flags/' }))).toEqual([
      { tech: 's3', label: 'bucket/flags', purpose: 'exposures' },
    ]);
    expect(uses(analytics.duckdb({ path: 'storage/flags' }))).toEqual([
      { tech: 'fs', label: 'storage/flags', purpose: 'experiments' },
    ]);
    expect(uses(sinks.memory())).toBeUndefined();
  });

  it('describes a tenant redis link', () => {
    expect(uses(tenantTransports.redis({ connection: 'bus' }))).toEqual([
      { tech: 'redis', connection: 'bus', purpose: 'tenant link' },
    ]);
    expect(uses(tenantTransports.redis({ client: {} as never }))).toBeUndefined();
  });

  it('describes the defaults on the defineConfig result', () => {
    fakeApp({ database: { connection: 'pg', connections: { pg: { client: 'pg' } } } });
    const config = defineConfig({ flags: {} });
    expect(uses(config)).toEqual([
      { tech: 'postgres', connection: 'pg', purpose: 'ruleset' },
      { tech: 'postgres', connection: 'pg', purpose: 'event log' },
      { tech: 'postgres', connection: 'pg', purpose: 'exposures' },
      { tech: 'postgres', connection: 'pg', purpose: 'experiments' },
    ]);
    expect(Object.keys(config)).toEqual(['flags']);
  });

  it('follows explicit lucid factories into the defaults they imply', () => {
    fakeApp({
      database: {
        connection: 'pg',
        connections: { pg: { client: 'pg' }, flags: { client: 'pg' } },
      },
    });
    const config = defineConfig({
      flags: {},
      store: stores.lucid({ connection: 'flags' }),
      sinks: { warehouse: sinks.lucid({ connection: 'flags' }) },
    });
    expect(uses(config)).toEqual([
      { tech: 'postgres', connection: 'flags', purpose: 'event log' },
      { tech: 'postgres', connection: 'flags', purpose: 'experiments' },
    ]);
  });

  it('describes no defaults without lucid, with a memory store, or on a tenant', () => {
    expect(uses(defineConfig({ flags: {} }))).toEqual([]);
    fakeApp({ database: { connection: 'pg', connections: { pg: { client: 'pg' } } } });
    expect(
      uses(defineConfig({ flags: {}, store: stores.memory(), transport: transports.memory() })),
    ).toEqual([]);
    expect(
      uses(
        defineConfig({
          flags: {},
          topology: 'tenant',
          tenant: { url: 'http://cp/_flags', token: 't', partition: 'shop' },
        }),
      ),
    ).toEqual([]);
  });
});
