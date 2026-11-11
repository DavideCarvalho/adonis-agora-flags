import { describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks, stores, transports } from '../../src/define_config.js';
import { type DurableEngineLike, registerDurableWorkflows, WORKFLOWS } from '../../src/durable.js';
import { createRuntime, lucidContext } from '../../src/runtime.js';
import type { MemorySink } from '../../src/sinks/sink.js';
import { quietLogger } from '../helpers.js';

describe('durable dispatcher', () => {
  it('registers one relay schedule per sink plus schedules, results and maintenance, and runs them', async () => {
    const runtime = await createRuntime(
      defineConfig({
        flags: { f: flag.boolean({ default: false }) },
        store: stores.memory(),
        transport: transports.memory(),
        sinks: { a: sinks.memory(), b: sinks.memory() },
        relay: { intervalMs: 2000 },
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );
    const workflows = new Map<string, (ctx: unknown, input: never) => Promise<void>>();
    const schedules: Array<{
      key: string;
      workflow: string;
      input?: unknown;
      everyMs: number;
      overlap?: string;
    }> = [];
    const engine: DurableEngineLike = {
      register: (name, _version, fn, opts) => {
        expect(opts?.origin).toBe('@adonis-agora/flags');
        workflows.set(name, fn);
      },
      registerSchedules: (list) => schedules.push(...list),
    };
    expect(registerDurableWorkflows(engine, runtime)).toBe(true);
    expect([...workflows.keys()].sort()).toEqual(Object.values(WORKFLOWS).sort());
    expect(schedules.map((s) => s.key).sort()).toEqual(
      [
        'flags.maintenance',
        'flags.relay.a',
        'flags.relay.b',
        'flags.results',
        'flags.schedules',
      ].sort(),
    );
    expect(schedules.every((s) => s.overlap === 'skip')).toBe(true);
    expect(schedules.find((s) => s.key === 'flags.relay.a')).toMatchObject({
      everyMs: 2000,
      input: { sink: 'a' },
    });

    await runtime.manager.track('u1', 'purchase');
    await runtime.buffer!.flush();
    await workflows.get(WORKFLOWS.relay)!({}, { sink: 'a' } as never);
    expect((runtime.sinks.get('a') as MemorySink).events).toHaveLength(1);
    expect((runtime.sinks.get('b') as MemorySink).events).toHaveLength(0);
    await runtime.close();
  });

  it('runs the relay through a real durable engine schedule', async () => {
    const durable = (await import('@adonis-agora/durable')) as unknown as {
      WorkflowEngine: new (deps: {
        store: unknown;
      }) => DurableEngineLike & {
        triggerSchedule(key: string): Promise<{ status?: string } | null>;
        getRun(id: string): Promise<{ status: string; error?: unknown } | null>;
      };
      InMemoryStateStore: new () => unknown;
    };
    const engine = new durable.WorkflowEngine({ store: new durable.InMemoryStateStore() });
    const runtime = await createRuntime(
      defineConfig({
        flags: {},
        store: stores.memory(),
        transport: transports.memory(),
        sinks: { a: sinks.memory() },
      }),
      lucidContext(undefined),
      { logger: quietLogger },
    );
    expect(registerDurableWorkflows(engine, runtime)).toBe(true);
    await runtime.manager.track('u1', 'purchase');
    await runtime.buffer!.flush();
    const result = (await engine.triggerSchedule('flags.relay.a')) as {
      runId?: string;
      status?: string;
    } | null;
    expect(result).not.toBeNull();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (runtime.sinks.get('a') as MemorySink).events.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((runtime.sinks.get('a') as MemorySink).events).toHaveLength(1);
    await runtime.close();
  });

  it('falls back (returns false) on an engine without registerSchedules', async () => {
    const runtime = await createRuntime(
      defineConfig({ flags: {}, store: stores.memory(), transport: transports.memory() }),
      lucidContext(undefined),
      { logger: quietLogger, start: false },
    );
    expect(registerDurableWorkflows({ register: () => {} }, runtime)).toBe(false);
    await runtime.close();
  });
});
