import { readFile, writeFile } from 'node:fs/promises';
import type { Ruleset } from '@adonis-agora/flags-core';
import { args, flags } from '@adonisjs/core/ace';
import { ValidationError } from '../src/admin.js';
import { importRuleset, promote, stale } from '../src/dashboard/handlers.js';
import { rulesetIssues } from '../src/dashboard/shape.js';
import { FlagsCommand, FlagsConsoleCommand } from './shared.js';

export class FlagsExport extends FlagsCommand {
  static override commandName = 'flags:export';
  static override description = 'Export an environment ruleset as JSON';

  @flags.string({ description: 'Environment (default: the configured one)' })
  declare env?: string;

  @flags.string({ description: 'Write to this file instead of stdout' })
  declare out?: string;

  override async run() {
    const runtime = await this.runtime();
    const ruleset = await runtime.admin!.exportRuleset(this.env ?? runtime.manager.environment);
    const json = JSON.stringify(ruleset, null, 2);
    if (this.out) {
      await writeFile(this.out, `${json}\n`);
      this.logger.success(`ruleset version ${ruleset.version} written to ${this.out}`);
    } else {
      this.logger.log(json);
    }
  }
}

/** `--note`, `--force` and `--dry-run` for the commands that replace a whole ruleset. */
abstract class ReplaceRulesetCommand extends FlagsConsoleCommand {
  @flags.string({ description: 'Why (kept on the change request / audit)' })
  declare note?: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  @flags.boolean({ description: 'Validate against the target environment, change nothing' })
  declare dryRun?: boolean;

  /** Validates `ruleset` as the replacement for `environment` without writing; prints the verdict. */
  protected async dryRunReplace(ruleset: Ruleset, environment: string): Promise<void> {
    const runtime = await this.runtime();
    const issues = rulesetIssues(ruleset);
    if (issues.length > 0) throw new ValidationError(issues);
    await runtime.admin!.preview(
      {
        entity: 'ruleset',
        value: {
          flags: ruleset.flags,
          segments: ruleset.segments ?? {},
          layers: ruleset.layers ?? {},
          ...(ruleset.metrics ? { metrics: ruleset.metrics } : {}),
          ...(ruleset.holdout ? { holdout: ruleset.holdout } : {}),
        },
      },
      environment,
    );
    const summary = {
      dryRun: true,
      environment,
      valid: true,
      flags: Object.keys(ruleset.flags).length,
      segments: Object.keys(ruleset.segments ?? {}).length,
      layers: Object.keys(ruleset.layers ?? {}).length,
      requiresApproval: runtime.admin!.requiresApproval(environment),
    };
    if (this.json) return this.printJson(summary);
    this.logger.success(
      `dry run: valid for ${environment} (${summary.flags} flags, ${summary.segments} segments, ${summary.layers} layers)${
        summary.requiresApproval ? '; applying would file a change request' : ''
      }`,
    );
  }
}

export class FlagsImport extends ReplaceRulesetCommand {
  static override commandName = 'flags:import';
  static override description =
    'Replace an environment ruleset with a JSON export (validated; approvals apply; asks unless --force)';

  @args.string({ description: 'JSON file' })
  declare file: string;

  override async run() {
    const ruleset = JSON.parse(await readFile(this.file, 'utf8')) as Ruleset;
    const environment = this.env ?? (await this.runtime()).manager.environment;
    if (this.dryRun) return this.dryRunReplace(ruleset, environment);
    const question = `Replace every flag, segment and layer in ${environment} with ${this.file}?`;
    if (!(await this.confirmed(this.force, question))) return;
    const out = await this.call(importRuleset, {
      body: { ruleset, ...(this.note ? { note: this.note } : {}) },
    });
    this.reportWrite(out, `imported into ${environment}`);
  }
}

export class FlagsPromote extends ReplaceRulesetCommand {
  static override commandName = 'flags:promote';
  static override description =
    'Copy one environment ruleset over another (staging → production); asks unless --force';

  @args.string({ description: 'Source environment' })
  declare from: string;

  @args.string({ description: 'Target environment' })
  declare to: string;

  override async run() {
    if (this.dryRun) {
      const source = await (await this.runtime()).admin!.exportRuleset(this.from);
      return this.dryRunReplace(source, this.to);
    }
    const question = `Replace every flag, segment and layer in ${this.to} with ${this.from}'s?`;
    if (!(await this.confirmed(this.force, question))) return;
    const out = await this.call(promote, {
      body: { from: this.from, to: this.to, ...(this.note ? { note: this.note } : {}) },
    });
    this.reportWrite(out, `${this.from} → ${this.to}`);
  }
}

export class FlagsStale extends FlagsConsoleCommand {
  static override commandName = 'flags:stale';
  static override description =
    'Flags that are probably safe to remove (unused, expired, static, undeclared)';

  @flags.number({ description: 'Days without evaluations to count as unused (default 30)' })
  declare unusedDays?: number;

  @flags.number({ description: 'Days serving one value to count as static (default 30)' })
  declare staticDays?: number;

  override async run() {
    const out = await this.call(stale, {
      query: {
        ...(this.unusedDays !== undefined ? { unusedDays: String(this.unusedDays) } : {}),
        ...(this.staticDays !== undefined ? { staticDays: String(this.staticDays) } : {}),
      },
    });
    if (this.json) return this.printJson(out);
    const rows = out.data as Array<{
      key: string;
      reasons: string[];
      lastEvaluated?: string | null;
      owner?: string | null;
    }>;
    if (rows.length === 0) {
      this.logger.success('no stale flags');
      return;
    }
    const table = this.ui.table();
    table.head(['Flag', 'Why', 'Last evaluated', 'Owner']);
    for (const s of rows)
      table.row([s.key, s.reasons.join(', '), s.lastEvaluated ?? 'never', s.owner ?? '']);
    table.render();
  }
}

export class FlagsForget extends FlagsCommand {
  static override commandName = 'flags:forget';
  static override description =
    'Delete everything stored about a subject in every sink that supports it';

  @args.string({ description: 'Subject id' })
  declare subject: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    const runtime = await this.runtime();
    if (!this.force) {
      if (process.stdin.isTTY !== true) {
        throw new Error(`forgetting ${this.subject} cannot be undone: pass --force`);
      }
      const ok = await this.prompt.confirm(
        `Delete everything stored about ${this.subject}? This cannot be undone.`,
      );
      if (!ok) {
        this.logger.warning('cancelled');
        this.exitCode = 1;
        return;
      }
    }
    await runtime.manager.forget(this.subject);
    this.logger.success(`forgot ${this.subject}`);
  }
}

export class FlagsReplay extends FlagsCommand {
  static override commandName = 'flags:replay';
  static override description =
    'Move a sink cursor back to the start of the log (backfill a new destination)';

  @args.string({ description: 'Sink name' })
  declare sink: string;

  override async run() {
    const runtime = await this.runtime();
    if (!runtime.transport?.rewind) {
      this.logger.error(`the "${runtime.transport?.name}" transport cannot rewind`);
      this.exitCode = 1;
      return;
    }
    await runtime.transport.rewind(this.sink);
    this.logger.success(`${this.sink} will receive the retained log again`);
  }
}
