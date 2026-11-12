import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySetValue } from '../../commands/flags_set.js';
import { flag } from '../../src/declare.js';
import { defineConfig } from '../../src/define_config.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

describe('flags:set values', () => {
  let db: TestDb;
  let runtime: FlagsRuntime;
  const cli = { id: 'cli:test' };

  beforeEach(async () => {
    db = await sqliteDb();
    runtime = await createRuntime(
      defineConfig({
        flags: {
          max_uploads: flag.number({ default: 10 }),
          greeting: flag.string({ default: 'hi' }),
          checkout: flag.string({ default: 'classic', variants: ['classic', 'one_page'] }),
          limits: flag.json({ default: { daily: 1 } }),
        },
      }),
      lucidContext(db.database as never),
      { logger: quietLogger },
    );
  });

  afterEach(async () => {
    await runtime.close();
    await db.close();
  });

  const value = async (key: string) => {
    await runtime.manager.refresh();
    return runtime.manager.for('u1').value(key as never);
  };

  it('sets a number flag to a number, reusing the variant next time', async () => {
    await applySetValue(runtime.admin!, 'max_uploads', '25', cli, {});
    expect(await value('max_uploads')).toBe(25);
    await applySetValue(runtime.admin!, 'max_uploads', '10', cli, {});
    await applySetValue(runtime.admin!, 'max_uploads', '25', cli, {});
    expect(await value('max_uploads')).toBe(25);
    const definition = await runtime.admin!.definition('max_uploads');
    expect(Object.values(definition.variants).filter((v) => v === 25)).toHaveLength(1);
  });

  it('sets free strings and JSON, and keeps declared variants strict', async () => {
    await applySetValue(runtime.admin!, 'greeting', 'olá', cli, {});
    expect(await value('greeting')).toBe('olá');
    await applySetValue(runtime.admin!, 'limits', '{"daily":5}', cli, {});
    expect(await value('limits')).toEqual({ daily: 5 });
    await applySetValue(runtime.admin!, 'checkout', 'one_page', cli, {});
    expect(await value('checkout')).toBe('one_page');
    await expect(applySetValue(runtime.admin!, 'checkout', 'nope', cli, {})).rejects.toThrow(
      /no variant "nope" \(variants: classic, one_page\)/,
    );
    await expect(applySetValue(runtime.admin!, 'max_uploads', 'lots', cli, {})).rejects.toThrow(
      /not a number/,
    );
  });
});
