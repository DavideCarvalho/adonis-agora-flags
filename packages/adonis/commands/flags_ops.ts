import { readFile, writeFile } from 'node:fs/promises';
import { args, flags } from '@adonisjs/core/ace';
import { cliActor, FlagsCommand } from './shared.js';

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

export class FlagsImport extends FlagsCommand {
  static override commandName = 'flags:import';
  static override description =
    'Replace an environment ruleset with a JSON export (validated; approvals apply)';

  @args.string({ description: 'JSON file' })
  declare file: string;

  @flags.string({ description: 'Environment (default: the configured one)' })
  declare env?: string;

  @flags.string({ description: 'Why' })
  declare note?: string;

  override async run() {
    const runtime = await this.runtime();
    const ruleset = JSON.parse(await readFile(this.file, 'utf8'));
    const result = await runtime.admin!.importRuleset(ruleset, cliActor(), {
      ...(this.env ? { environment: this.env } : {}),
      ...(this.note ? { note: this.note } : {}),
    });
    if (result.status === 'applied')
      this.logger.success(`imported (ruleset version ${result.version})`);
    else this.logger.warning(`approval required: change request ${result.request.id}`);
  }
}

export class FlagsPromote extends FlagsCommand {
  static override commandName = 'flags:promote';
  static override description = 'Copy one environment ruleset over another (staging → production)';

  @args.string({ description: 'Source environment' })
  declare from: string;

  @args.string({ description: 'Target environment' })
  declare to: string;

  @flags.string({ description: 'Why' })
  declare note?: string;

  override async run() {
    const runtime = await this.runtime();
    const result = await runtime.admin!.promote(this.from, this.to, cliActor(), this.note);
    if (result.status === 'applied')
      this.logger.success(`${this.from} → ${this.to} (version ${result.version})`);
    else this.logger.warning(`approval required: change request ${result.request.id}`);
  }
}

export class FlagsStale extends FlagsCommand {
  static override commandName = 'flags:stale';
  static override description =
    'Flags that are probably safe to remove (unused, expired, static, undeclared)';

  @flags.number({ description: 'Days without evaluations to count as unused (default 30)' })
  declare unusedDays?: number;

  @flags.number({ description: 'Days serving one value to count as static (default 30)' })
  declare staticDays?: number;

  override async run() {
    const runtime = await this.runtime();
    const stale = await runtime.admin!.stale({
      ...(this.unusedDays ? { unusedDays: this.unusedDays } : {}),
      ...(this.staticDays ? { staticDays: this.staticDays } : {}),
    });
    if (stale.length === 0) {
      this.logger.success('no stale flags');
      return;
    }
    const table = this.ui.table();
    table.head(['Flag', 'Why', 'Last evaluated', 'Owner']);
    for (const s of stale)
      table.row([s.key, s.reasons.join(', '), s.lastEvaluated ?? 'never', s.owner ?? '']);
    table.render();
  }
}

export class FlagsResults extends FlagsCommand {
  static override commandName = 'flags:results';
  static override description = 'Show experiment results (recompute with --fresh)';

  @args.string({ description: 'Experiment key' })
  declare experiment: string;

  @flags.boolean({ description: 'Recompute now instead of reading the cache' })
  declare fresh?: boolean;

  override async run() {
    const runtime = await this.runtime();
    const results = this.fresh
      ? await runtime.worker!.computeResults(this.experiment)
      : await runtime.manager.results(this.experiment);
    if (!results) {
      this.logger.warning(
        'no results yet (is the experiment configured in config/flags.ts experiments?)',
      );
      return;
    }
    this.logger.info(
      `${results.experiment}: exposures ${JSON.stringify(results.exposures)} (computed ${results.computedAt})`,
    );
    if (results.srm?.mismatch)
      this.logger.error(
        `sample ratio mismatch (p=${results.srm.pValue.toExponential(2)}): fix assignment before trusting results`,
      );
    const table = this.ui.table();
    table.head(['Metric', 'Variant', 'Lift', 'p', 'p (sequential)', 'Verdict']);
    for (const metric of results.metrics) {
      for (const c of metric.comparisons) {
        table.row([
          `${metric.name}${metric.guardrail ? ' (guardrail)' : ''}`,
          c.variant,
          Number.isFinite(c.relativeLift) ? `${(c.relativeLift * 100).toFixed(2)}%` : '-',
          c.pValue.toPrecision(3),
          c.sequential.pValue.toPrecision(3),
          c.verdict,
        ]);
      }
    }
    table.render();
    for (const warning of results.warnings) this.logger.warning(warning);
  }
}

export class FlagsForget extends FlagsCommand {
  static override commandName = 'flags:forget';
  static override description =
    'Delete everything stored about a subject in every sink that supports it';

  @args.string({ description: 'Subject id' })
  declare subject: string;

  override async run() {
    const runtime = await this.runtime();
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

export class FlagsRequests extends FlagsCommand {
  static override commandName = 'flags:requests';
  static override description = 'List change requests, or approve/reject one';

  @args.string({ description: 'list | approve | reject | cancel', required: false })
  declare action?: string;

  @args.string({ description: 'Change request id', required: false })
  declare id?: string;

  @flags.string({ description: 'Review note' })
  declare note?: string;

  @flags.string({ description: 'Act as this actor id instead of cli:<user>' })
  declare as?: string;

  override async run() {
    const runtime = await this.runtime();
    const admin = runtime.admin!;
    const actor = cliActor(this.as);
    const action = this.action ?? 'list';
    if (action === 'list') {
      const requests = await runtime.store!.listChangeRequests({ status: 'pending' });
      const table = this.ui.table();
      table.head(['Id', 'Environment', 'Change', 'Requested by', 'Note']);
      for (const r of requests) {
        table.row([
          r.id,
          r.environment,
          `${r.change.entity} ${r.change.key ?? ''}`,
          r.requestedBy.id,
          r.note ?? '',
        ]);
      }
      table.render();
      return;
    }
    if (!this.id) {
      this.logger.error('give the change request id');
      this.exitCode = 1;
      return;
    }
    if (action === 'approve') {
      const { version } = await admin.approve(this.id, actor, this.note);
      this.logger.success(`applied (ruleset version ${version})`);
    } else if (action === 'reject') {
      await admin.reject(this.id, actor, this.note);
      this.logger.success('rejected');
    } else if (action === 'cancel') {
      await admin.cancel(this.id, actor);
      this.logger.success('cancelled');
    } else {
      this.logger.error(`unknown action "${action}"`);
      this.exitCode = 1;
    }
  }
}
