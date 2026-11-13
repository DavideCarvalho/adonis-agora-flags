import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FlagsRequestsApprove } from '../../commands/flags_activity.js';
import FlagsList from '../../commands/flags_list.js';
import { FlagsExport, FlagsImport, FlagsStale } from '../../commands/flags_ops.js';
import FlagsSet from '../../commands/flags_set.js';
import FlagsWork from '../../commands/flags_work.js';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks, stores, transports } from '../../src/define_config.js';
import type { FlagsRuntime } from '../../src/runtime.js';

/** The flags:* commands through the real ace kernel of a booted app. */
describe('commands', () => {
  let app: ApplicationService;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'flags-cmd-'));
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: {
          flags: defineConfig({
            flags: { new_player: flag.boolean({ default: false, owner: 'video' }) },
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            sinks: { mem: sinks.memory() },
            approvals: { environments: ['locked'] },
          }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('console') as ApplicationService;
    await app.init();
    await app.boot();
  });

  afterEach(async () => {
    await app.terminate();
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(command: never, args: string[]) {
    const ace = await app.container.make('ace');
    const instance = await ace.create(command, args);
    instance.ui.switchMode('raw');
    await instance.exec();
    return instance as {
      exitCode?: number;
      ui: { logger: { getLogs(): Array<{ message: string }> } };
      assertSucceeded(): void;
    };
  }
  const logs = (command: Awaited<ReturnType<typeof run>>) =>
    command.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  const runtime = async () => (await app.container.make('flags.runtime')) as FlagsRuntime;

  it('flags:set changes what a flag serves, and flags:list shows it', async () => {
    (await run(FlagsSet as never, ['new_player', '25%'])).assertSucceeded();
    await (await runtime()).manager.refresh();
    const list = await run(FlagsList as never, ['--json']);
    const rows = JSON.parse(logs(list));
    expect(rows).toEqual([
      expect.objectContaining({ key: 'new_player', serving: 'on 25% / off 75%', owner: 'video' }),
    ]);
    const audit = await (await runtime()).store!.audit({ key: 'new_player' });
    expect(audit[0]!.actor.id).toMatch(/^cli:/);
  });

  it('flags:list shows the type and default of flags created in the console', async () => {
    await (await runtime()).admin!.createFlag(
      'console_banner',
      { type: 'boolean', default: false },
      { id: 'ana' },
    );
    const rows = JSON.parse(logs(await run(FlagsList as never, ['--json'])));
    expect(rows).toContainEqual(
      expect.objectContaining({ key: 'console_banner', type: 'boolean', default: 'false' }),
    );
  });

  it('flags:set in an approval environment files a request; flags:requests:approve approves it', async () => {
    const set = await run(FlagsSet as never, ['new_player', 'on', '--env=locked', '--as=alice']);
    expect(logs(set)).toMatch(/approval required/);
    const pending = await (await runtime()).store!.listChangeRequests({ status: 'pending' });
    expect(pending).toHaveLength(1);
    const own = await run(FlagsRequestsApprove as never, [pending[0]!.id, '--as=alice']);
    expect(own.exitCode).toBe(1);
    (await run(FlagsRequestsApprove as never, [pending[0]!.id, '--as=bob'])).assertSucceeded();
    const ruleset = await (await runtime()).store!.readRuleset('locked');
    expect(ruleset.flags.new_player?.fallthrough).toEqual({ variant: 'on' });
  });

  it('flags:export and flags:import round-trip a ruleset', async () => {
    await run(FlagsSet as never, ['new_player', 'on']);
    const file = join(dir, 'flags.json');
    (await run(FlagsExport as never, [`--out=${file}`])).assertSucceeded();
    expect(JSON.parse(readFileSync(file, 'utf8')).flags.new_player).toBeDefined();
    (await run(FlagsImport as never, [file, '--env=staging', '--force'])).assertSucceeded();
    const staging = await (await runtime()).store!.readRuleset('staging');
    expect(staging.flags.new_player?.fallthrough).toEqual({ variant: 'on' });
  });

  it('flags:work --once relays pending events', async () => {
    const rt = await runtime();
    await rt.manager.track('u1', 'purchase');
    await rt.buffer!.flush();
    (await run(FlagsWork as never, ['--once'])).assertSucceeded();
    const sink = rt.sinks.get('mem') as unknown as { events: unknown[] };
    expect(sink.events).toHaveLength(1);
  });

  it('flags:stale lists a flag nobody evaluates', async () => {
    await run(FlagsSet as never, ['new_player', 'on']);
    const stale = await run(FlagsStale as never, ['--unused-days=1']);
    expect(logs(stale)).toMatch(/new_player/);
  });
});
