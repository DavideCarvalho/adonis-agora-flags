import { args, flags } from '@adonisjs/core/ace';
import type { FlagsAdmin, ProposeResult } from '../src/admin.js';
import type { Actor } from '../src/stores/store.js';
import { cliActor, FlagsCommand } from './shared.js';

/** Applies a `flags:set` value. Exported for tests. */
export function applySetValue(
  admin: FlagsAdmin,
  key: string,
  value: string,
  actor: Actor,
  options: { environment?: string; note?: string },
): Promise<ProposeResult> {
  if (value === 'on') return admin.turnOn(key, actor, options);
  if (value === 'off') return admin.turnOff(key, actor, options);
  if (value === 'kill') return admin.setEnabled(key, false, actor, options);
  if (value === 'unkill') return admin.setEnabled(key, true, actor, options);
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(value);
  if (percent) return admin.setRollout(key, Number(percent[1]), actor, options);
  return admin.setVariant(key, value, actor, options);
}

export default class FlagsSet extends FlagsCommand {
  static override commandName = 'flags:set';
  static override description =
    'Change what a flag serves: on | off | kill | unkill | <n>% (rollout) | <variant>';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @args.string({ description: 'on, off, kill, unkill, 25%, or a variant name' })
  declare value: string;

  @flags.string({ description: 'Environment (default: the configured one)' })
  declare env?: string;

  @flags.string({ description: 'Why (kept on the change request / audit)' })
  declare note?: string;

  @flags.string({ description: 'Act as this actor id instead of cli:<user>' })
  declare as?: string;

  override async run() {
    const runtime = await this.runtime();
    const result = await applySetValue(runtime.admin!, this.key, this.value, cliActor(this.as), {
      ...(this.env ? { environment: this.env } : {}),
      ...(this.note ? { note: this.note } : {}),
    });
    if (result.status === 'applied')
      this.logger.success(`${this.key} → ${this.value} (ruleset version ${result.version})`);
    else this.logger.warning(`approval required: change request ${result.request.id} is pending`);
  }
}
