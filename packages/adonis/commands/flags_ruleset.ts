import { args, flags } from '@adonisjs/core/ace';
import {
  deleteLayer,
  deleteMetric,
  deleteSegment,
  listLayers,
  listMetrics,
  listSegments,
  saveHoldout,
  saveLayer,
  saveMetric,
  saveSegment,
} from '../src/dashboard/handlers.js';
import { FlagsConsoleCommand, jsonArgument } from './shared.js';

/** `--note` and `--force` for the ruleset entity writes. */
abstract class EntityWriteCommand extends FlagsConsoleCommand {
  @flags.string({ description: 'Why (kept on the change request / audit)' })
  declare note?: string;

  protected withNote(body: Record<string, unknown>): Record<string, unknown> {
    return this.note !== undefined ? { ...body, note: this.note } : body;
  }

  protected async environment(): Promise<string> {
    return this.env ?? (await this.runtime()).manager.environment;
  }
}

// ── Segments ────────────────────────────────────────────────────────────────

export class FlagsSegmentsList extends FlagsConsoleCommand {
  static override commandName = 'flags:segments:list';
  static override description = 'Segments, and the flags whose rules reference each one';

  override async run() {
    const out = await this.call(listSegments);
    if (this.json) return this.printJson(out);
    const rows = out.data as Array<{
      key: string;
      segment: { conditions?: unknown[]; included?: string[]; excluded?: string[] };
      usedBy: string[];
    }>;
    const table = this.ui.table();
    table.head(['Segment', 'Conditions', 'Included', 'Excluded', 'Used by']);
    for (const r of rows) {
      table.row([
        r.key,
        String(r.segment.conditions?.length ?? 0),
        String(r.segment.included?.length ?? 0),
        String(r.segment.excluded?.length ?? 0),
        r.usedBy.join(', '),
      ]);
    }
    table.render();
  }
}

export class FlagsSegmentsSave extends EntityWriteCommand {
  static override commandName = 'flags:segments:save';
  static override description = 'Create or replace a segment';

  @args.string({ description: 'Segment key' })
  declare key: string;

  @flags.string({ description: 'The segment as JSON or @file.json', required: true })
  declare segment: string;

  override async run() {
    const segment = await jsonArgument(this.segment, 'segment');
    const out = await this.call(saveSegment, {
      params: { key: this.key },
      body: this.withNote({ segment }),
    });
    this.reportWrite(out, `segment ${this.key} saved`);
  }
}

export class FlagsSegmentsDelete extends EntityWriteCommand {
  static override commandName = 'flags:segments:delete';
  static override description =
    'Delete a segment (refused while a rule references it); asks unless --force';

  @args.string({ description: 'Segment key' })
  declare key: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    const env = await this.environment();
    if (!(await this.confirmed(this.force, `Delete segment ${this.key} from ${env}?`))) return;
    const out = await this.call(deleteSegment, {
      params: { key: this.key },
      body: this.withNote({}),
    });
    this.reportWrite(out, `segment ${this.key} deleted`);
  }
}

// ── Layers and holdout ──────────────────────────────────────────────────────

export class FlagsLayersList extends FlagsConsoleCommand {
  static override commandName = 'flags:layers:list';
  static override description =
    'Layers with their allocations, the global holdout, and every experiment';

  override async run() {
    const out = await this.call(listLayers);
    if (this.json) return this.printJson(out);
    const layers = out.data as Array<{
      key: string;
      layer: { allocations: Record<string, [number, number]> };
      allocatedPercent: number;
    }>;
    const table = this.ui.table();
    table.head(['Layer', 'Allocated', 'Experiments']);
    for (const l of layers) {
      table.row([l.key, `${l.allocatedPercent}%`, Object.keys(l.layer.allocations).join(', ')]);
    }
    table.render();
    const holdout = out.holdout as { percent: number } | null;
    this.logger.info(holdout ? `global holdout: ${holdout.percent}%` : 'no global holdout');
  }
}

export class FlagsLayersSave extends EntityWriteCommand {
  static override commandName = 'flags:layers:save';
  static override description = 'Create or replace a layer (mutually exclusive experiments)';

  @args.string({ description: 'Layer key' })
  declare key: string;

  @flags.string({ description: 'The layer as JSON or @file.json', required: true })
  declare layer: string;

  override async run() {
    const layer = await jsonArgument(this.layer, 'layer');
    const out = await this.call(saveLayer, {
      params: { key: this.key },
      body: this.withNote({ layer }),
    });
    this.reportWrite(out, `layer ${this.key} saved`);
  }
}

export class FlagsLayersDelete extends EntityWriteCommand {
  static override commandName = 'flags:layers:delete';
  static override description = 'Delete a layer; asks unless --force';

  @args.string({ description: 'Layer key' })
  declare key: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    const env = await this.environment();
    if (!(await this.confirmed(this.force, `Delete layer ${this.key} from ${env}?`))) return;
    const out = await this.call(deleteLayer, {
      params: { key: this.key },
      body: this.withNote({}),
    });
    this.reportWrite(out, `layer ${this.key} deleted`);
  }
}

export class FlagsHoldoutSave extends EntityWriteCommand {
  static override commandName = 'flags:holdout:save';
  static override description =
    'Set the global holdout, or remove it with --clear (asks unless --force)';

  @flags.string({ description: 'The holdout as JSON or @file.json' })
  declare holdout?: string;

  @flags.boolean({ description: 'Remove the global holdout' })
  declare clear?: boolean;

  @flags.boolean({ description: 'Do not ask for confirmation (--clear)' })
  declare force?: boolean;

  override async run() {
    if (this.clear === (this.holdout !== undefined)) {
      throw new Error('give --holdout, or --clear to remove the global holdout');
    }
    if (this.clear) {
      const env = await this.environment();
      if (!(await this.confirmed(this.force, `Remove the global holdout from ${env}?`))) return;
    }
    const holdout = this.holdout !== undefined ? await jsonArgument(this.holdout, 'holdout') : null;
    const out = await this.call(saveHoldout, { body: this.withNote({ holdout }) });
    this.reportWrite(out, holdout === null ? 'holdout removed' : 'holdout saved');
  }
}

// ── Metrics ─────────────────────────────────────────────────────────────────

export class FlagsMetricsList extends FlagsConsoleCommand {
  static override commandName = 'flags:metrics:list';
  static override description = 'Metrics (config and console), and the experiments that use each';

  override async run() {
    const out = await this.call(listMetrics);
    if (this.json) return this.printJson(out);
    const rows = out.data as Array<{
      name: string;
      metric: { kind: string; event: string };
      source: string;
      usedBy: string[];
    }>;
    const table = this.ui.table();
    table.head(['Metric', 'Kind', 'Event', 'Source', 'Used by']);
    for (const r of rows) {
      table.row([r.name, r.metric.kind, r.metric.event, r.source, r.usedBy.join(', ')]);
    }
    table.render();
  }
}

export class FlagsMetricsSave extends EntityWriteCommand {
  static override commandName = 'flags:metrics:save';
  static override description =
    'Create or replace a console metric (metrics in config/flags.ts are refused)';

  @args.string({ description: 'Metric name' })
  declare key: string;

  @flags.string({ description: 'The metric as JSON or @file.json', required: true })
  declare metric: string;

  override async run() {
    const metric = await jsonArgument(this.metric, 'metric');
    const out = await this.call(saveMetric, {
      params: { key: this.key },
      body: this.withNote({ metric }),
    });
    this.reportWrite(out, `metric ${this.key} saved`);
  }
}

export class FlagsMetricsDelete extends EntityWriteCommand {
  static override commandName = 'flags:metrics:delete';
  static override description =
    'Delete a console metric (refused while an experiment uses it); asks unless --force';

  @args.string({ description: 'Metric name' })
  declare key: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    const env = await this.environment();
    if (!(await this.confirmed(this.force, `Delete metric ${this.key} from ${env}?`))) return;
    const out = await this.call(deleteMetric, {
      params: { key: this.key },
      body: this.withNote({}),
    });
    this.reportWrite(out, `metric ${this.key} deleted`);
  }
}
