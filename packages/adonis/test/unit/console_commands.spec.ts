import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlagsAuditList,
  FlagsEnvironmentsList,
  FlagsExperimentsList,
  FlagsExperimentsRecompute,
  FlagsExperimentsShow,
  FlagsOpsStatus,
  FlagsRequestsApprove,
  FlagsRequestsCancel,
  FlagsRequestsList,
  FlagsRequestsReject,
  FlagsSchedulesCancel,
  FlagsSchedulesCreate,
  FlagsSchedulesList,
} from '../../commands/flags_activity.js';
import {
  FlagsFlagCreate,
  FlagsFlagDelete,
  FlagsFlagDisable,
  FlagsFlagEnable,
  FlagsFlagEvaluate,
  FlagsFlagOverride,
  FlagsFlagRollout,
  FlagsFlagSave,
  FlagsFlagShow,
  FlagsFlagUpdate,
  FlagsFlagVariant,
} from '../../commands/flags_flag.js';
import {
  FlagsExport,
  FlagsForget,
  FlagsImport,
  FlagsPromote,
  FlagsStale,
} from '../../commands/flags_ops.js';
import {
  FlagsHoldoutSave,
  FlagsLayersDelete,
  FlagsLayersList,
  FlagsLayersSave,
  FlagsMetricsDelete,
  FlagsMetricsList,
  FlagsMetricsSave,
  FlagsSegmentsDelete,
  FlagsSegmentsList,
  FlagsSegmentsSave,
} from '../../commands/flags_ruleset.js';
import loader from '../../commands/main.js';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks, stores, transports } from '../../src/define_config.js';
import type { FlagsRuntime } from '../../src/runtime.js';

/** The console-parity commands through the real ace kernel of a booted app. */
describe('console commands', () => {
  let app: ApplicationService;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'flags-cli-'));
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: {
          flags: defineConfig({
            flags: {
              new_player: flag.boolean({ default: false, owner: 'video' }),
              theme: flag.string({ default: 'light', variants: ['light', 'dark'] }),
            },
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

  type Ran = {
    exitCode?: number;
    ui: { logger: { getLogs(): Array<{ message: string }> } };
    assertSucceeded(): void;
    assertFailed(): void;
  };
  async function run(command: unknown, args: string[]): Promise<Ran> {
    const ace = await app.container.make('ace');
    const instance = await ace.create(command as never, args);
    instance.ui.switchMode('raw');
    await instance.exec();
    return instance as unknown as Ran;
  }
  const logs = (command: Ran) =>
    command.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  const json = async (command: unknown, args: string[]) => {
    const ran = await run(command, [...args, '--json']);
    ran.assertSucceeded();
    return JSON.parse(logs(ran));
  };
  const runtime = async () => (await app.container.make('flags.runtime')) as FlagsRuntime;
  const ruleset = async (env = 'production') => (await runtime()).store!.readRuleset(env);
  const file = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  it('registers every command under flags:<noun>:<verb>', async () => {
    const names = (await loader.getMetaData()).map((c) => c.commandName);
    expect(names).toEqual(
      expect.arrayContaining([
        'flags:flag:show',
        'flags:flag:enable',
        'flags:segments:list',
        'flags:experiments:recompute',
        'flags:requests:approve',
        'flags:schedules:create',
        'flags:audit:list',
        'flags:environments:list',
        'flags:ops:status',
      ]),
    );
    expect(names).not.toContain('flags:requests');
    expect(names).not.toContain('flags:results');
  });

  it('flag writes go through the console handlers and audit as cli:<user>', async () => {
    (await run(FlagsFlagRollout, ['new_player', '25%'])).assertSucceeded();
    expect((await ruleset()).flags.new_player?.fallthrough).toEqual({
      split: [
        { variant: 'on', weight: 2500 },
        { variant: 'off', weight: 7500 },
      ],
    });
    (await run(FlagsFlagDisable, ['new_player', '--note=incident'])).assertSucceeded();
    expect((await ruleset()).flags.new_player?.enabled).toBe(false);
    (await run(FlagsFlagEnable, ['new_player'])).assertSucceeded();
    (await run(FlagsFlagVariant, ['theme', 'dark'])).assertSucceeded();
    (await run(FlagsFlagOverride, ['theme', 'qa-1', 'light'])).assertSucceeded();
    expect((await ruleset()).flags.theme?.overrides).toEqual({ 'qa-1': 'light' });
    (await run(FlagsFlagOverride, ['theme', 'qa-1', '--clear'])).assertSucceeded();
    expect((await ruleset()).flags.theme?.overrides ?? {}).toEqual({});

    const audit = await (await runtime()).store!.audit({ key: 'new_player' });
    expect(audit.map((a) => a.actor.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^cli:/)]),
    );

    const shown = await json(FlagsFlagShow, ['theme']);
    expect(shown).toMatchObject({
      key: 'theme',
      serving: { kind: 'fixed', variant: 'dark' },
      requiresApproval: false,
    });
    expect(Array.isArray(shown.audit)).toBe(true);
    const human = await run(FlagsFlagShow, ['theme']);
    human.assertSucceeded();
  });

  it('a refused write is one error line and exit code 1', async () => {
    const bad = await run(FlagsFlagVariant, ['theme', 'neon']);
    expect(bad.exitCode).toBe(1);
    expect(logs(bad)).toMatch(/neon/);
    const unknown = await run(FlagsFlagShow, ['nope']);
    expect(unknown.exitCode).toBe(1);
    expect(logs(unknown)).toMatch(/^.*404/m);
    const both = await run(FlagsFlagOverride, ['theme', 'qa-1', 'dark', '--clear']);
    expect(both.exitCode).toBe(1);
  });

  it('flag:save takes a definition from a file and refuses an invalid one', async () => {
    const definition = {
      variants: { on: true, off: false },
      enabled: true,
      offVariant: 'off',
      fallthrough: { variant: 'on' },
    };
    const out = await json(FlagsFlagSave, [
      'new_player',
      `--definition=@${file('def.json', definition)}`,
    ]);
    expect(out.status).toBe('applied');
    const invalid = await run(FlagsFlagSave, ['new_player', '--definition={"enabled":1}']);
    expect(invalid.exitCode).toBe(1);
    expect(logs(invalid)).toMatch(/422/);
  });

  it('flag:create, flag:update, and flag:delete (asks unless --force)', async () => {
    (
      await run(FlagsFlagCreate, [
        'banner',
        '--declaration={"type":"boolean","default":false,"description":"top banner"}',
      ])
    ).assertSucceeded();
    (await run(FlagsFlagUpdate, ['banner', '--declaration={"owner":"growth"}'])).assertSucceeded();
    expect((await ruleset()).flags.banner?.declaration?.owner).toBe('growth');

    const refused = await run(FlagsFlagDelete, ['banner']);
    expect(refused.exitCode).toBe(1);
    expect(logs(refused)).toMatch(/--force/);
    expect((await ruleset()).flags.banner).toBeDefined();

    (await run(FlagsFlagDelete, ['banner', '--force'])).assertSucceeded();
    expect((await ruleset()).flags.banner).toBeUndefined();
  });

  it('flag:evaluate answers for a subject without recording an exposure', async () => {
    await run(FlagsFlagOverride, ['theme', 'u1', 'dark']);
    const one = await json(FlagsFlagEvaluate, ['theme', '--subject=u1']);
    expect(one.result).toMatchObject({ flagKey: 'theme', value: 'dark', variant: 'dark' });
    const all = await json(FlagsFlagEvaluate, ['--context={"targetingKey":"u2"}']);
    expect(all.results.map((r: { flagKey: string }) => r.flagKey)).toEqual(['new_player', 'theme']);
    (await run(FlagsFlagEvaluate, ['theme', '--subject=u1'])).assertSucceeded();
  });

  it('segments: save, list, refuse to delete one in use, delete', async () => {
    (await run(FlagsSegmentsSave, ['staff', '--segment={"included":["u1"]}'])).assertSucceeded();
    await (await runtime()).admin!.saveFlag(
      'new_player',
      {
        variants: { on: true, off: false },
        enabled: true,
        offVariant: 'off',
        rules: [{ id: 'r1', conditions: [{ segment: 'staff' }], serve: { variant: 'on' } }],
        fallthrough: { variant: 'off' },
      },
      { id: 'ana' },
    );
    const list = await json(FlagsSegmentsList, []);
    expect(list.data).toEqual([
      { key: 'staff', segment: { included: ['u1'] }, usedBy: ['new_player'] },
    ]);
    (await run(FlagsSegmentsList, [])).assertSucceeded();

    const inUse = await run(FlagsSegmentsDelete, ['staff', '--force']);
    expect(inUse.exitCode).toBe(1);
    const unasked = await run(FlagsSegmentsDelete, ['staff']);
    expect(logs(unasked)).toMatch(/--force/);

    await (await runtime()).admin!.setOverride('new_player', 'x', 'on', { id: 'ana' });
    await (await runtime()).admin!.saveFlag(
      'new_player',
      {
        variants: { on: true, off: false },
        enabled: true,
        offVariant: 'off',
        fallthrough: { variant: 'off' },
      },
      { id: 'ana' },
    );
    (await run(FlagsSegmentsDelete, ['staff', '--force'])).assertSucceeded();
    expect((await ruleset()).segments?.staff).toBeUndefined();
  });

  it('layers and the global holdout', async () => {
    (await run(FlagsLayersSave, ['checkout', '--layer={"allocations":{}}'])).assertSucceeded();
    const list = await json(FlagsLayersList, []);
    expect(list.data).toEqual([
      { key: 'checkout', layer: { allocations: {} }, allocatedPercent: 0 },
    ]);
    (await run(FlagsHoldoutSave, ['--holdout={"percent":5}'])).assertSucceeded();
    expect((await ruleset()).holdout).toEqual({ percent: 5 });
    expect((await run(FlagsHoldoutSave, ['--clear'])).exitCode).toBe(1);
    (await run(FlagsHoldoutSave, ['--clear', '--force'])).assertSucceeded();
    expect((await ruleset()).holdout ?? null).toBeNull();
    (await run(FlagsLayersList, [])).assertSucceeded();
    expect((await run(FlagsLayersDelete, ['checkout'])).exitCode).toBe(1);
    (await run(FlagsLayersDelete, ['checkout', '--force'])).assertSucceeded();
    expect((await ruleset()).layers?.checkout).toBeUndefined();
  });

  it('metrics: save, list, delete', async () => {
    (
      await run(FlagsMetricsSave, [
        'purchases',
        '--metric={"kind":"conversion","event":"purchase"}',
      ])
    ).assertSucceeded();
    const list = await json(FlagsMetricsList, []);
    expect(list.data).toEqual([
      expect.objectContaining({ name: 'purchases', source: 'console', usedBy: [] }),
    ]);
    (await run(FlagsMetricsList, [])).assertSucceeded();
    const invalid = await run(FlagsMetricsSave, ['bad', '--metric={"kind":"nope"}']);
    expect(invalid.exitCode).toBe(1);
    (await run(FlagsMetricsDelete, ['purchases', '--force'])).assertSucceeded();
  });

  it('experiments: list, show and recompute answer as the console does', async () => {
    const list = await json(FlagsExperimentsList, []);
    expect(list).toMatchObject({ analytics: false, data: [] });
    (await run(FlagsExperimentsList, [])).assertSucceeded();
    const show = await run(FlagsExperimentsShow, ['checkout']);
    expect(show.exitCode).toBe(1);
    expect(logs(show)).toMatch(/404: experiment "checkout" is not configured/);
    const recompute = await run(FlagsExperimentsRecompute, ['checkout']);
    expect(recompute.exitCode).toBe(1);
  });

  it('change requests go through the approval flow: no self-approval, reject, cancel', async () => {
    const pending = await json(FlagsFlagEnable, ['new_player', '--env=locked', '--as=alice']);
    expect(pending.status).toBe('pending');
    const id = pending.request.id as string;

    const list = await json(FlagsRequestsList, ['--env=locked']);
    expect(list.data).toEqual([expect.objectContaining({ id, status: 'pending' })]);
    expect(list.requiresApproval).toBe(true);

    const own = await run(FlagsRequestsApprove, [id, '--as=alice']);
    expect(own.exitCode).toBe(1);
    expect(logs(own)).toMatch(/403/);
    const approved = await json(FlagsRequestsApprove, [id, '--as=bob', '--note=ok']);
    expect(approved.version).toBeDefined();
    expect((await ruleset('locked')).flags.new_player?.enabled).toBe(true);

    const second = await json(FlagsFlagDisable, ['new_player', '--env=locked', '--as=alice']);
    (
      await run(FlagsRequestsReject, [second.request.id, '--as=bob', '--note=no'])
    ).assertSucceeded();
    const again = await run(FlagsRequestsReject, [second.request.id, '--as=bob']);
    expect(again.exitCode).toBe(1);
    expect(logs(again)).toMatch(/409/);

    const third = await json(FlagsFlagDisable, ['new_player', '--env=locked', '--as=alice']);
    expect((await run(FlagsRequestsCancel, [third.request.id, '--as=bob'])).exitCode).toBe(1);
    (await run(FlagsRequestsCancel, [third.request.id, '--as=alice'])).assertSucceeded();

    const all = await json(FlagsRequestsList, ['--env=locked', '--status=all']);
    expect(all.data.map((r: { status: string }) => r.status).sort()).toEqual([
      'applied',
      'cancelled',
      'rejected',
    ]);
    (await run(FlagsRequestsList, ['--env=locked', '--status=all'])).assertSucceeded();
  });

  it('schedules: create one, a gradual rollout, list, cancel', async () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const one = await json(FlagsSchedulesCreate, ['new_player', '--kind=enable', `--at=${at}`]);
    expect(one.schedules).toHaveLength(1);
    (
      await run(FlagsSchedulesCreate, [
        'new_player',
        `--steps=[{"at":"${at}","percent":10},{"at":"${at}","percent":50}]`,
      ])
    ).assertSucceeded();
    const list = await json(FlagsSchedulesList, ['--flag=new_player']);
    expect(list.data).toHaveLength(3);
    (await run(FlagsSchedulesList, [])).assertSucceeded();
    (await run(FlagsSchedulesCancel, [one.schedules[0].id])).assertSucceeded();
    const twice = await run(FlagsSchedulesCancel, [one.schedules[0].id]);
    expect(twice.exitCode).toBe(1);
    expect(
      (await run(FlagsSchedulesCreate, ['new_player', '--kind=explode', `--at=${at}`])).exitCode,
    ).toBe(1);
    expect((await run(FlagsSchedulesCreate, ['new_player'])).exitCode).toBe(1);
  });

  it('audit:list filters and pages forward with --after', async () => {
    await run(FlagsFlagEnable, ['new_player']);
    await run(FlagsFlagDisable, ['new_player']);
    await run(FlagsFlagVariant, ['theme', 'dark']);
    const page = await json(FlagsAuditList, ['--entity=flag', '--key=new_player', '--first=1']);
    expect(page.data).toHaveLength(1);
    expect(page.meta.hasNext).toBe(true);
    const next = await json(FlagsAuditList, [
      '--key=new_player',
      '--first=1',
      `--after=${page.meta.nextCursor}`,
    ]);
    expect(next.data).toHaveLength(1);
    expect(next.data[0].id).not.toBe(page.data[0].id);
    (await run(FlagsAuditList, [])).assertSucceeded();
    expect((await run(FlagsAuditList, ['--entity=planet'])).exitCode).toBe(1);
    expect((await run(FlagsAuditList, ['--first=0'])).exitCode).toBe(1);
  });

  it('environments:list and ops:status', async () => {
    const envs = await json(FlagsEnvironmentsList, []);
    expect(envs.data).toEqual(
      expect.arrayContaining([{ name: 'production', current: true, requiresApproval: false }]),
    );
    (await run(FlagsEnvironmentsList, [])).assertSucceeded();
    const ops = await json(FlagsOpsStatus, []);
    expect(ops).toMatchObject({ environment: 'production', relay: expect.any(Boolean) });
    (await run(FlagsOpsStatus, [])).assertSucceeded();
  });

  it('import and promote: --dry-run changes nothing, and they ask unless --force', async () => {
    await run(FlagsFlagVariant, ['theme', 'dark']);
    const out = join(dir, 'prod.json');
    (await run(FlagsExport, [`--out=${out}`])).assertSucceeded();

    const dry = await json(FlagsImport, [out, '--env=staging', '--dry-run']);
    expect(dry).toMatchObject({ dryRun: true, valid: true, environment: 'staging', flags: 1 });
    expect((await ruleset('staging')).flags.theme).toBeUndefined();
    const broken = await run(FlagsImport, [file('bad.json', { flags: { x: {} } }), '--dry-run']);
    expect(broken.exitCode).toBe(1);

    expect((await run(FlagsImport, [out, '--env=staging'])).exitCode).toBe(1);
    (await run(FlagsImport, [out, '--env=staging', '--force'])).assertSucceeded();
    expect((await ruleset('staging')).flags.theme).toBeDefined();

    (await run(FlagsPromote, ['production', 'qa', '--dry-run'])).assertSucceeded();
    expect((await run(FlagsPromote, ['production', 'qa'])).exitCode).toBe(1);
    (await run(FlagsPromote, ['production', 'qa', '--force'])).assertSucceeded();
    expect((await ruleset('qa')).flags.theme?.fallthrough).toEqual({ variant: 'dark' });
    const locked = await json(FlagsPromote, ['production', 'locked', '--force']);
    expect(locked.status).toBe('pending');
  });

  it('stale --json, and forget refuses without --force', async () => {
    await run(FlagsFlagEnable, ['new_player']);
    const stale = await json(FlagsStale, ['--unused-days=1']);
    expect(stale.data.map((s: { key: string }) => s.key)).toContain('new_player');
    const forget = await run(FlagsForget, ['u1']);
    expect(forget.exitCode).toBe(1);
    (await run(FlagsForget, ['u1', '--force'])).assertSucceeded();
  });
});
