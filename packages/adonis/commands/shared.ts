import { userInfo } from 'node:os';
import type { FlagDefinition } from '@adonis-agora/flags-core';
import { BaseCommand } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import type { FlagsRuntime } from '../src/runtime.js';
import type { Actor } from '../src/stores/store.js';

/** Who a command acts as: `cli:<os user>`, unless `--as` says otherwise. */
export function cliActor(as?: string): Actor {
  if (as) return { id: as };
  let name = 'unknown';
  try {
    name = userInfo().username;
  } catch {
    // containers without a passwd entry
  }
  return { id: `cli:${name}` };
}

/** One line on what a flag serves. */
export function describeServing(definition: FlagDefinition | undefined): string {
  if (!definition) return 'not configured (code default)';
  if (!definition.enabled) return `killed → ${definition.offVariant}`;
  const parts: string[] = [];
  const fallthrough = definition.fallthrough;
  if ('variant' in fallthrough) parts.push(`serves ${fallthrough.variant}`);
  else {
    const total = fallthrough.split.reduce((sum, arm) => sum + Math.max(0, arm.weight), 0) || 1;
    parts.push(
      fallthrough.split
        .filter((arm) => arm.weight > 0)
        .map((arm) => `${arm.variant} ${Math.round((arm.weight / total) * 1000) / 10}%`)
        .join(' / '),
    );
  }
  if (definition.rules?.length) parts.push(`${definition.rules.length} rule(s)`);
  const overrides = Object.keys(definition.overrides ?? {}).length;
  if (overrides) parts.push(`${overrides} override(s)`);
  if (definition.experiment) parts.push('experiment');
  return parts.join(', ');
}

/** Base for every flags command: boots the app and hands the runtime over. */
export abstract class FlagsCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  /**
   * A refused change (unknown flag, invalid value, not allowed) is a message, not a stack trace.
   * Programming errors keep their stack.
   */
  override async exec() {
    try {
      return await super.exec();
    } catch (error) {
      if (
        error instanceof Error &&
        !(error instanceof TypeError) &&
        !(error instanceof ReferenceError) &&
        !(error instanceof SyntaxError)
      ) {
        this.logger.error(error.message);
        this.exitCode = 1;
        return undefined;
      }
      throw error;
    }
  }

  protected async runtime(): Promise<FlagsRuntime> {
    const runtime = (await this.app.container.make('flags.runtime')) as FlagsRuntime;
    if (runtime.topology === 'tenant') {
      throw new Error('this app is a tenant: run flags commands on the control-plane');
    }
    return runtime;
  }
}
