import { channel } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, FLAGS_DIAGNOSTIC_EVENTS } from '../../src/index.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

/** Stands in for `@adonis-agora/diagnostics`: records every emit, publishes like it does. */
function installDiagnostics() {
  const calls: Array<{ lib: string; event: string; payload: unknown }> = [];
  (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
    lib: string,
    event: string,
    payload: unknown,
  ) => {
    calls.push({ lib, event, payload });
    const target = channel(`agora:${lib}:${event}`);
    if (target.hasSubscribers) target.publish({ lib, event, payload });
  };
  return calls;
}

const config = defineConfig({
  app: 'shop',
  flags: { new_player: flag.boolean({ default: false }) },
});

describe('diagnostics', () => {
  let testDb: TestDb;
  let runtime: FlagsRuntime;

  beforeEach(async () => {
    testDb = await sqliteDb();
  });

  afterEach(async () => {
    delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
    await runtime?.close();
    await testDb.close();
  });

  const start = async () => {
    runtime = await createRuntime(config, lucidContext(testDb.database as never), {
      logger: quietLogger,
      runWorker: false,
    });
  };

  it('does nothing without @adonis-agora/diagnostics', async () => {
    await start();
    expect(await runtime.manager.for('u1').enabled('new_player')).toBe(false);
  });

  it('registers each channel once, then builds payloads only for subscribers', async () => {
    const calls = installDiagnostics();
    await start();
    await runtime.manager.for('u1').enabled('new_player');
    await runtime.manager.for('u2').enabled('new_player');
    // The first call registers the channel (diagnostics' OTel bridge subscribes on registration).
    expect(calls.filter((c) => c.event === 'evaluation')).toHaveLength(1);

    const seen: unknown[] = [];
    const listener = (message: unknown) => seen.push(message);
    channel('agora:flags:evaluation').subscribe(listener);
    try {
      await runtime.manager.for('u3').enabled('new_player');
    } finally {
      channel('agora:flags:evaluation').unsubscribe(listener);
    }
    expect(seen).toEqual([
      {
        lib: 'flags',
        event: 'evaluation',
        payload: expect.objectContaining({ flag: 'new_player', subject: 'u3' }),
      },
    ]);
  });

  it('publishes applied ruleset changes with who made them', async () => {
    const calls = installDiagnostics();
    await start();
    const result = await runtime.admin!.turnOn('new_player', { id: 'alice' });
    expect(result).toMatchObject({ status: 'applied' });
    expect(calls.filter((c) => c.event === 'change')).toEqual([
      {
        lib: 'flags',
        event: 'change',
        payload: {
          environment: 'production',
          version: (result as { version: string }).version,
          entity: 'flag',
          key: 'new_player',
          deleted: false,
          actor: { id: 'alice' },
        },
      },
    ]);
  });

  it('lists every event it publishes', () => {
    expect(FLAGS_DIAGNOSTIC_EVENTS).toEqual(['evaluation', 'exposure', 'track', 'change']);
  });
});
