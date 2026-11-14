import { args, flags } from '@adonisjs/core/ace';
import {
  createFlag,
  deleteDeclaration,
  deleteFlag,
  evaluateContext,
  flagDetail,
  type Serving,
  saveFlag,
  setEnabled,
  setOverride,
  setRollout,
  setVariant,
  updateDeclaration,
} from '../src/dashboard/handlers.js';
import { FlagsConsoleCommand, jsonArgument } from './shared.js';

/** A console serving summary as one line. Exported for tests. */
export function servingText(serving: Serving): string {
  switch (serving.kind) {
    case 'default':
      return `code default (${JSON.stringify(serving.value)})`;
    case 'off':
      return `killed → ${serving.variant}`;
    case 'fixed':
      return `serves ${serving.variant}`;
    case 'rollout':
      return `rollout ${serving.percent}%`;
    case 'split':
      return `${serving.arms.map((a) => `${a.variant} ${a.percent}%`).join(' / ')}${
        serving.bucketBy ? ` by ${serving.bucketBy}` : ''
      }`;
  }
}

const date = (value: unknown) =>
  value instanceof Date ? value.toISOString() : value ? String(value) : '';

/** `--note` for every flag write. */
abstract class FlagWriteCommand extends FlagsConsoleCommand {
  @flags.string({ description: 'Why (kept on the change request / audit)' })
  declare note?: string;

  protected withNote(body: Record<string, unknown>): Record<string, unknown> {
    return this.note !== undefined ? { ...body, note: this.note } : body;
  }
}

export class FlagsFlagShow extends FlagsConsoleCommand {
  static override commandName = 'flags:flag:show';
  static override description =
    'One flag: declaration, targeting, what it serves, pending requests, schedules, last changes';

  @args.string({ description: 'Flag key' })
  declare key: string;

  override async run() {
    const out = await this.call(flagDetail, { params: { key: this.key } });
    if (this.json) return this.printJson(out);
    const declaration = out.declaration as {
      type: string;
      default: unknown;
      owner?: string;
      source: string;
    } | null;
    const definition = out.definition as {
      enabled: boolean;
      variants: Record<string, unknown>;
      rules?: unknown[];
      overrides?: Record<string, string>;
      experiment?: unknown;
    };
    this.logger.info(
      `${this.key} in ${String(out.environment)} (ruleset version ${String(out.version)})`,
    );
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Serving', servingText(out.serving as Serving)]);
    table.row([
      'Declared',
      declaration
        ? `${declaration.type}, default ${JSON.stringify(declaration.default)} (${declaration.source})`
        : 'undeclared',
    ]);
    table.row(['Owner', declaration?.owner ?? '']);
    table.row(['Enabled', String(definition.enabled)]);
    table.row(['Variants', Object.keys(definition.variants).join(', ')]);
    table.row(['Rules', String(definition.rules?.length ?? 0)]);
    table.row([
      'Overrides',
      Object.entries(definition.overrides ?? {})
        .map(([subject, variant]) => `${subject}=${variant}`)
        .join(', '),
    ]);
    table.row(['Experiment', definition.experiment ? 'yes' : 'no']);
    table.row(['Needs approval', String(out.requiresApproval)]);
    table.row(['Pending requests', String((out.pendingRequests as unknown[]).length)]);
    table.row(['Schedules', String((out.schedules as unknown[]).length)]);
    table.render();
    const audit = (out.audit as Array<Record<string, unknown>>).slice(0, 10);
    if (audit.length > 0) {
      const history = this.ui.table();
      history.head(['At', 'Action', 'By', 'Version']);
      for (const a of audit) {
        history.row([
          date(a.at),
          String(a.action),
          String((a.actor as { id: string }).id),
          String(a.version),
        ]);
      }
      history.render();
    }
  }
}

export class FlagsFlagEnable extends FlagWriteCommand {
  static override commandName = 'flags:flag:enable';
  static override description = 'Lift the kill switch: the flag serves its targeting again';

  @args.string({ description: 'Flag key' })
  declare key: string;

  override async run() {
    const out = await this.call(setEnabled, {
      params: { key: this.key },
      body: this.withNote({ enabled: true }),
    });
    this.reportWrite(out, `${this.key} enabled`);
  }
}

export class FlagsFlagDisable extends FlagWriteCommand {
  static override commandName = 'flags:flag:disable';
  static override description = 'Kill switch: everyone gets the off variant';

  @args.string({ description: 'Flag key' })
  declare key: string;

  override async run() {
    const out = await this.call(setEnabled, {
      params: { key: this.key },
      body: this.withNote({ enabled: false }),
    });
    this.reportWrite(out, `${this.key} disabled`);
  }
}

export class FlagsFlagRollout extends FlagWriteCommand {
  static override commandName = 'flags:flag:rollout';
  static override description = 'Serve `on` to a share of subjects (on/off flags only)';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @args.string({ description: 'Percent, 0 to 100 (`25` or `25%`)' })
  declare percent: string;

  override async run() {
    const percent = Number(this.percent.replace(/%$/, ''));
    if (this.percent.trim() === '' || !Number.isFinite(percent)) {
      throw new Error('percent must be a number between 0 and 100');
    }
    const out = await this.call(setRollout, {
      params: { key: this.key },
      body: this.withNote({ percent }),
    });
    this.reportWrite(out, `${this.key} → ${percent}%`);
  }
}

export class FlagsFlagVariant extends FlagWriteCommand {
  static override commandName = 'flags:flag:variant';
  static override description = 'Serve one variant to everyone';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @args.string({ description: 'Variant name' })
  declare variant: string;

  override async run() {
    const out = await this.call(setVariant, {
      params: { key: this.key },
      body: this.withNote({ variant: this.variant }),
    });
    this.reportWrite(out, `${this.key} → ${this.variant}`);
  }
}

export class FlagsFlagOverride extends FlagWriteCommand {
  static override commandName = 'flags:flag:override';
  static override description = 'Force a variant for one subject, or clear it with --clear';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @args.string({ description: 'Subject (targeting key)' })
  declare subject: string;

  @args.string({ description: 'Variant name', required: false })
  declare variant?: string;

  @flags.boolean({ description: 'Remove the override instead' })
  declare clear?: boolean;

  override async run() {
    if (this.clear === (this.variant !== undefined)) {
      throw new Error('give a variant, or --clear to remove the override');
    }
    const out = await this.call(setOverride, {
      params: { key: this.key },
      body: this.withNote({ subject: this.subject, variant: this.variant ?? null }),
    });
    this.reportWrite(
      out,
      this.clear
        ? `${this.key}: override for ${this.subject} removed`
        : `${this.key}: ${this.subject} → ${this.variant}`,
    );
  }
}

export class FlagsFlagSave extends FlagWriteCommand {
  static override commandName = 'flags:flag:save';
  static override description =
    'Save a whole flag definition (variants, rules, overrides, fallthrough, experiment)';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @flags.string({ description: 'The definition as JSON, or @file.json', required: true })
  declare definition: string;

  override async run() {
    const definition = await jsonArgument(this.definition, 'definition');
    const out = await this.call(saveFlag, {
      params: { key: this.key },
      body: this.withNote({ definition }),
    });
    this.reportWrite(out, `${this.key} saved`);
  }
}

export class FlagsFlagCreate extends FlagWriteCommand {
  static override commandName = 'flags:flag:create';
  static override description = 'Create a flag without code (typed later with flags:types)';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @flags.string({
    description:
      'The declaration as JSON or @file.json: { type, default, variants?, description?, owner?, tags?, expiresAt?, client? }',
    required: true,
  })
  declare declaration: string;

  override async run() {
    const declaration = await jsonArgument(this.declaration, 'declaration');
    const out = await this.call(createFlag, {
      body: this.withNote({ key: this.key, declaration }),
    });
    this.reportWrite(out, `${this.key} created`);
  }
}

export class FlagsFlagUpdate extends FlagWriteCommand {
  static override commandName = 'flags:flag:update';
  static override description =
    "Edit a console-created flag's declaration (description, owner, tags, expiresAt, …)";

  @args.string({ description: 'Flag key' })
  declare key: string;

  @flags.string({ description: 'The fields to change, as JSON or @file.json', required: true })
  declare declaration: string;

  override async run() {
    const declaration = await jsonArgument(this.declaration, 'declaration');
    const out = await this.call(updateDeclaration, {
      params: { key: this.key },
      body: this.withNote({ declaration }),
    });
    this.reportWrite(out, `${this.key} updated`);
  }
}

export class FlagsFlagDropDeclaration extends FlagWriteCommand {
  static override commandName = 'flags:flag:drop-declaration';
  static override description =
    'Drop the console declaration of a flag the code now declares (the code already overrides it); keeps the targeting';

  @args.string({ description: 'Flag key' })
  declare key: string;

  override async run() {
    const out = await this.call(deleteDeclaration, {
      params: { key: this.key },
      body: this.withNote({}),
    });
    this.reportWrite(out, `${this.key}: console declaration dropped, the code declaration applies`);
  }
}

export class FlagsFlagDelete extends FlagWriteCommand {
  static override commandName = 'flags:flag:delete';
  static override description =
    'Remove a flag from the ruleset (the code default takes over); asks unless --force';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @flags.boolean({ description: 'Do not ask for confirmation' })
  declare force?: boolean;

  override async run() {
    const environment = this.env ?? (await this.runtime()).manager.environment;
    if (!(await this.confirmed(this.force, `Delete ${this.key} from ${environment}?`))) return;
    const out = await this.call(deleteFlag, {
      params: { key: this.key },
      body: this.withNote({}),
    });
    this.reportWrite(out, `${this.key} deleted`);
  }
}

export class FlagsFlagEvaluate extends FlagsConsoleCommand {
  static override commandName = 'flags:flag:evaluate';
  static override description =
    'What a context would get, against the stored ruleset (records no exposure)';

  @args.string({ description: 'Flag key (default: every flag)', required: false })
  declare key?: string;

  @flags.string({
    description: 'The evaluation context as JSON or @file.json, e.g. {"targetingKey":"u1"}',
  })
  declare context?: string;

  @flags.string({ description: 'Subject id (shortcut for {"targetingKey": …})' })
  declare subject?: string;

  override async run() {
    const parsed = this.context ? await jsonArgument(this.context, 'context') : {};
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('--context must be a JSON object');
    }
    const context = {
      ...(parsed as Record<string, unknown>),
      ...(this.subject !== undefined ? { targetingKey: this.subject } : {}),
    };
    const out = await this.call(evaluateContext, {
      body: { context, ...(this.key !== undefined ? { flag: this.key } : {}) },
    });
    if (this.json) return this.printJson(out);
    const results = (out.result ? [out.result] : out.results) as Array<{
      flagKey: string;
      value: unknown;
      variant?: string;
      reason: string;
      errorMessage?: string;
    }>;
    const table = this.ui.table();
    table.head(['Flag', 'Value', 'Variant', 'Reason']);
    for (const r of results) {
      table.row([
        r.flagKey,
        JSON.stringify(r.value),
        r.variant ?? '',
        r.errorMessage ? `${r.reason}: ${r.errorMessage}` : r.reason,
      ]);
    }
    table.render();
  }
}
