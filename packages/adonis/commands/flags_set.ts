import type { JsonValue } from '@adonis-agora/flags-core';
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
  return setVariantOrValue(admin, key, value, actor, options);
}

/** A variant by name; otherwise a value of the flag's type (`25` for a number flag, JSON for json). */
async function setVariantOrValue(
  admin: FlagsAdmin,
  key: string,
  value: string,
  actor: Actor,
  options: { environment?: string; note?: string },
): Promise<ProposeResult> {
  const definition = await admin.definition(key, options.environment);
  if (Object.hasOwn(definition.variants, value))
    return admin.setVariant(key, value, actor, options);
  const type =
    admin.declarations[key]?.type ??
    definition.declaration?.type ??
    typeof Object.values(definition.variants)[0];
  if (type === 'number') {
    const number = Number(value);
    if (value.trim() === '' || !Number.isFinite(number)) {
      throw new Error(`"${value}" is not a number, and ${key} is a number flag`);
    }
    return admin.setValue(key, number, actor, options);
  }
  if (type === 'json' || type === 'object') {
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      throw new Error(`"${value}" is not valid JSON, and ${key} is a JSON flag`);
    }
    return admin.setValue(key, parsed, actor, options);
  }
  if (
    type === 'string' &&
    !definition.declaration?.variants &&
    !admin.declarations[key]?.variants
  ) {
    return admin.setValue(key, value, actor, options);
  }
  const known = Object.keys(definition.variants).join(', ');
  throw new Error(`${key} has no variant "${value}" (variants: ${known})`);
}

export default class FlagsSet extends FlagsCommand {
  static override commandName = 'flags:set';
  static override description =
    'Change what a flag serves: on | off | kill | unkill | <n>% (rollout) | <variant> | <value>';

  @args.string({ description: 'Flag key' })
  declare key: string;

  @args.string({
    description:
      'on, off, kill, unkill, 25%, a variant name, or a value (number/string/JSON flags)',
  })
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
