import { args, flags } from '@adonisjs/core/ace';
import type { ExperimentResults } from '../src/analytics/results.js';
import {
  approveChangeRequest,
  audit,
  cancelChangeRequest,
  cancelSchedule,
  createSchedule,
  experimentDetail,
  listChangeRequests,
  listExperiments,
  listSchedules,
  meta,
  ops,
  recomputeExperiment,
  rejectChangeRequest,
} from '../src/dashboard/handlers.js';
import { FlagsConsoleCommand, jsonArgument } from './shared.js';

const date = (value: unknown) =>
  value instanceof Date ? value.toISOString() : value ? String(value) : '';

/** `--first` within a list's bounds. */
function firstOf(first: number | undefined, max: number): Record<string, string> {
  if (first === undefined) return {};
  if (!Number.isInteger(first) || first < 1 || first > max) {
    throw new Error(`--first must be an integer between 1 and ${max}`);
  }
  return { first: String(first) };
}

/** `filter[field]=value` for the fields that were given. */
function filterOf(fields: Record<string, string | undefined>): Record<string, unknown> {
  const filter = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  return Object.keys(filter).length > 0 ? { filter } : {};
}

// ── Experiments ─────────────────────────────────────────────────────────────

export class FlagsExperimentsList extends FlagsConsoleCommand {
  static override commandName = 'flags:experiments:list';
  static override description =
    'Experiments: running or not, exposures, SRM, and the verdicts of their last results';

  override async run() {
    const out = await this.call(listExperiments);
    if (this.json) return this.printJson(out);
    if (out.analytics === false) {
      this.logger.warning('no analytics backend is configured: results cannot be computed');
    }
    const rows = out.data as Array<{
      key: string;
      flag: string;
      configured: boolean;
      running: boolean;
      exposures: number | null;
      srmMismatch: boolean;
      computedAt: string | null;
      verdicts: Array<{ metric: string; variant: string; verdict: string }>;
    }>;
    const table = this.ui.table();
    table.head(['Experiment', 'Flag', 'Running', 'Exposures', 'SRM', 'Computed', 'Verdicts']);
    for (const r of rows) {
      table.row([
        r.configured ? r.key : `${r.key} (no analysis)`,
        r.flag,
        r.running ? 'yes' : 'no',
        r.exposures === null ? '' : String(r.exposures),
        r.srmMismatch ? 'MISMATCH' : '',
        r.computedAt ?? '',
        r.verdicts.map((v) => `${v.metric}/${v.variant}: ${v.verdict}`).join(', '),
      ]);
    }
    table.render();
  }
}

/** Prints experiment results as the console's results panel does. */
abstract class ResultsCommand extends FlagsConsoleCommand {
  protected renderResults(results: ExperimentResults | null): void {
    if (!results) {
      this.logger.warning(
        'no results yet: run flags:experiments:recompute, or wait for the worker',
      );
      return;
    }
    const total = Object.values(results.exposures).reduce((sum, n) => sum + n, 0);
    this.logger.info(
      `${results.experiment} (${results.flag}): ${total} exposures ${JSON.stringify(results.exposures)}, computed ${results.computedAt}`,
    );
    if (results.srm?.mismatch) {
      this.logger.error(
        `sample ratio mismatch (p=${results.srm.pValue.toExponential(2)}): fix assignment before trusting results`,
      );
    }
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

export class FlagsExperimentsShow extends ResultsCommand {
  static override commandName = 'flags:experiments:show';
  static override description = 'An experiment: its analysis config and last computed results';

  @args.string({ description: 'Experiment key' })
  declare key: string;

  override async run() {
    const out = await this.call(experimentDetail, { params: { key: this.key } });
    if (this.json) return this.printJson(out);
    this.renderResults(out.results as ExperimentResults | null);
  }
}

export class FlagsExperimentsRecompute extends ResultsCommand {
  static override commandName = 'flags:experiments:recompute';
  static override description = 'Compute an experiment results now instead of at the next tick';

  @args.string({ description: 'Experiment key' })
  declare key: string;

  override async run() {
    const out = await this.call(recomputeExperiment, { params: { key: this.key } });
    if (this.json) return this.printJson(out);
    this.renderResults(out.results as ExperimentResults);
  }
}

// ── Change requests ─────────────────────────────────────────────────────────

export class FlagsRequestsList extends FlagsConsoleCommand {
  static override commandName = 'flags:requests:list';
  static override description = 'Change requests, newest first (pending by default)';

  @flags.string({
    description: 'pending (default), approved, rejected, applied, cancelled, or all',
  })
  declare status?: string;

  @flags.number({ description: 'How many (default 100, at most 500)' })
  declare first?: number;

  override async run() {
    const status = this.status ?? 'pending';
    const out = await this.call(listChangeRequests, {
      query: {
        ...filterOf({ status: status === 'all' ? undefined : status }),
        ...firstOf(this.first, 500),
      },
    });
    if (this.json) return this.printJson(out);
    const rows = out.data as Array<{
      id: string;
      environment: string;
      status: string;
      change: { entity: string; key?: string };
      requestedBy: { id: string };
      requestedAt: Date | string;
      note?: string;
    }>;
    const table = this.ui.table();
    table.head(['Id', 'Environment', 'Status', 'Change', 'Requested by', 'At', 'Note']);
    for (const r of rows) {
      table.row([
        r.id,
        r.environment,
        r.status,
        `${r.change.entity} ${r.change.key ?? ''}`.trim(),
        r.requestedBy.id,
        date(r.requestedAt),
        r.note ?? '',
      ]);
    }
    table.render();
    if ((out.meta as { hasNext?: boolean }).hasNext) {
      this.logger.info('more requests match: narrow with --status or raise --first');
    }
  }
}

/** A review: approve or reject a pending change request (never the requester's own approval). */
abstract class ReviewCommand extends FlagsConsoleCommand {
  @args.string({ description: 'Change request id' })
  declare id: string;

  @flags.string({ description: 'Review note' })
  declare note?: string;

  protected body() {
    return this.note !== undefined ? { note: this.note } : {};
  }
}

export class FlagsRequestsApprove extends ReviewCommand {
  static override commandName = 'flags:requests:approve';
  static override description =
    'Approve and apply a pending change request (the requester cannot approve their own)';

  override async run() {
    const out = await this.call(approveChangeRequest, {
      params: { id: this.id },
      body: this.body(),
    });
    if (this.json) return this.printJson(out);
    this.logger.success(`${this.id} applied (ruleset version ${String(out.version)})`);
  }
}

export class FlagsRequestsReject extends ReviewCommand {
  static override commandName = 'flags:requests:reject';
  static override description = 'Reject a pending change request';

  override async run() {
    const out = await this.call(rejectChangeRequest, {
      params: { id: this.id },
      body: this.body(),
    });
    if (this.json) return this.printJson(out);
    this.logger.success(`${this.id} rejected`);
  }
}

export class FlagsRequestsCancel extends FlagsConsoleCommand {
  static override commandName = 'flags:requests:cancel';
  static override description = 'Withdraw your own pending change request';

  @args.string({ description: 'Change request id' })
  declare id: string;

  override async run() {
    const out = await this.call(cancelChangeRequest, { params: { id: this.id } });
    if (this.json) return this.printJson(out);
    this.logger.success(`${this.id} cancelled`);
  }
}

// ── Schedules ───────────────────────────────────────────────────────────────

export class FlagsSchedulesList extends FlagsConsoleCommand {
  static override commandName = 'flags:schedules:list';
  static override description = 'Scheduled changes, soonest first';

  @flags.string({ description: 'Only this flag' })
  declare flag?: string;

  @flags.string({ description: 'pending, running, done, failed or cancelled' })
  declare status?: string;

  @flags.number({ description: 'How many (default 100, at most 500)' })
  declare first?: number;

  override async run() {
    const out = await this.call(listSchedules, {
      query: { ...filterOf({ flag: this.flag, status: this.status }), ...firstOf(this.first, 500) },
    });
    if (this.json) return this.printJson(out);
    const rows = out.data as Array<{
      id: string;
      flag: string;
      kind: string;
      payload: { percent?: number };
      runAt: Date | string;
      status: string;
      createdBy: { id: string };
      error?: string;
    }>;
    const table = this.ui.table();
    table.head(['Id', 'Flag', 'Change', 'Run at', 'Status', 'By']);
    for (const r of rows) {
      table.row([
        r.id,
        r.flag,
        r.kind === 'rollout' ? `rollout ${r.payload.percent}%` : r.kind,
        date(r.runAt),
        r.error ? `${r.status}: ${r.error}` : r.status,
        r.createdBy.id,
      ]);
    }
    table.render();
    if ((out.meta as { hasNext?: boolean }).hasNext) {
      this.logger.info('more schedules match: narrow with --flag / --status or raise --first');
    }
  }
}

export class FlagsSchedulesCreate extends FlagsConsoleCommand {
  static override commandName = 'flags:schedules:create';
  static override description =
    'Schedule enable / disable / rollout at a date, or a gradual rollout with --steps';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @flags.string({ description: 'enable, disable or rollout' })
  declare kind?: string;

  @flags.string({ description: 'When (ISO date, e.g. 2026-12-01T09:00:00Z)' })
  declare at?: string;

  @flags.number({ description: 'rollout: the share of `on`, 0 to 100' })
  declare percent?: number;

  @flags.string({
    description: 'Gradual rollout as JSON or @file.json: [{"at":"…","percent":10}, …]',
  })
  declare steps?: string;

  override async run() {
    let body: Record<string, unknown>;
    if (this.steps !== undefined) {
      if (this.kind !== undefined || this.at !== undefined) {
        throw new Error('give either --steps, or --kind and --at');
      }
      body = { steps: await jsonArgument(this.steps, 'steps') };
    } else {
      if (this.kind === undefined || this.at === undefined) {
        throw new Error('give --kind and --at (or --steps)');
      }
      body = {
        kind: this.kind,
        runAt: this.at,
        ...(this.percent !== undefined ? { percent: this.percent } : {}),
      };
    }
    const out = await this.call(createSchedule, { params: { key: this.key }, body });
    if (this.json) return this.printJson(out);
    for (const s of out.schedules as Array<{
      id: string;
      kind: string;
      runAt: Date | string;
      payload: { percent?: number };
    }>) {
      this.logger.success(
        `${s.id}: ${this.key} ${s.kind === 'rollout' ? `→ ${s.payload.percent}%` : s.kind} at ${date(s.runAt)}`,
      );
    }
  }
}

export class FlagsSchedulesCancel extends FlagsConsoleCommand {
  static override commandName = 'flags:schedules:cancel';
  static override description = 'Cancel a pending scheduled change';

  @args.string({ description: 'Schedule id' })
  declare id: string;

  override async run() {
    const out = await this.call(cancelSchedule, { params: { id: this.id } });
    if (this.json) return this.printJson(out);
    this.logger.success(`${this.id} cancelled`);
  }
}

// ── Audit, environments, ops ────────────────────────────────────────────────

export class FlagsAuditList extends FlagsConsoleCommand {
  static override commandName = 'flags:audit:list';
  static override description = 'Who changed what, newest first';

  @flags.string({ description: 'flag, segment, layer, metric, holdout or ruleset' })
  declare entity?: string;

  @flags.string({ description: 'Only this key (a flag, segment, …)' })
  declare key?: string;

  @flags.number({ description: 'How many (default 50, at most 200)' })
  declare first?: number;

  @flags.string({ description: 'Continue after this cursor (the previous page prints it)' })
  declare after?: string;

  override async run() {
    const out = await this.call(audit, {
      query: {
        ...filterOf({ entity: this.entity, key: this.key }),
        ...firstOf(this.first, 200),
        ...(this.after !== undefined ? { after: this.after } : {}),
      },
    });
    if (this.json) return this.printJson(out);
    const rows = out.data as Array<{
      at: Date | string;
      entity: string;
      key: string | null;
      action: string;
      actor: { id: string };
      changeRequestId?: string;
      version: string;
    }>;
    const table = this.ui.table();
    table.head(['At', 'Entity', 'Key', 'Action', 'By', 'Request', 'Version']);
    for (const r of rows) {
      table.row([
        date(r.at),
        r.entity,
        r.key ?? '',
        r.action,
        r.actor.id,
        r.changeRequestId ?? '',
        r.version,
      ]);
    }
    table.render();
    const next = (out.meta as { nextCursor?: string | null }).nextCursor;
    if (next) this.logger.info(`older changes: --after=${next}`);
  }
}

export class FlagsEnvironmentsList extends FlagsConsoleCommand {
  static override commandName = 'flags:environments:list';
  static override description = 'Environments, and which ones route changes through approvals';

  override async run() {
    const out = await this.call(meta);
    const environments = out.environments as string[];
    const approvals = out.approvals as Record<string, boolean>;
    const rows = environments.map((name) => ({
      name,
      current: name === out.environment,
      requiresApproval: approvals[name] === true,
    }));
    if (this.json)
      return this.printJson({ app: out.app, environment: out.environment, data: rows });
    const table = this.ui.table();
    table.head(['Environment', 'This app', 'Needs approval']);
    for (const r of rows) {
      table.row([r.name, r.current ? 'yes' : '', r.requiresApproval ? 'yes' : 'no']);
    }
    table.render();
  }
}

export class FlagsOpsStatus extends FlagsConsoleCommand {
  static override commandName = 'flags:ops:status';
  static override description =
    'Is the machinery healthy: ruleset source, buffer, transport, sinks, tenants';

  override async run() {
    const out = await this.call(ops);
    if (this.json) return this.printJson(out);
    const table = this.ui.table();
    table.head(['Part', 'State']);
    table.row(['App', `${String(out.app)} (${String(out.topology)}, role ${String(out.role)})`]);
    table.row(['Environment', String(out.environment)]);
    table.row(['Source', JSON.stringify(out.source)]);
    table.row(['Buffer', JSON.stringify(out.buffer)]);
    table.row(['Transport', JSON.stringify(out.transport)]);
    table.row(['Delivery', String(out.delivery ?? 'none')]);
    table.row(['Worker', out.worker ? 'yes' : 'no']);
    table.row(['Analytics', out.analytics ? 'yes' : 'no']);
    for (const sink of out.sinks as Array<Record<string, unknown>>) {
      const { sink: name, ...rest } = sink;
      table.row([`Sink ${String(name)}`, JSON.stringify(rest)]);
    }
    if (out.sinkError) table.row(['Sink error', String(out.sinkError)]);
    for (const t of out.tenants as Array<{ partition: string; lastSeenAt: string | null }>) {
      table.row([`Tenant ${t.partition}`, `last seen ${t.lastSeenAt ?? 'never'}`]);
    }
    table.render();
  }
}
