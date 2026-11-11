import type { JsonValue } from '@adonis-agora/flags-core';

/**
 * The typed flag registry. Flags declared in `config/flags.ts` are added with
 * `interface FlagsList extends InferFlags<typeof flagsConfig> {}`, and flags created in the console
 * with `node ace flags:types` (it writes a `.d.ts` that augments this interface).
 */
export interface FlagsList {}

/**
 * Type-level settings. `node ace flags:types` sets `strictKeys: true`: once every flag (code and
 * console) is in {@link FlagsList}, an unknown key is a compile error. Without it, any string is
 * accepted (flags created in the console since the last generation still compile) and declared
 * keys are offered by autocomplete.
 */
export interface FlagsSettings {}

type Declared = Extract<keyof FlagsList, string>;
type Strict = FlagsSettings extends { strictKeys: true } ? true : false;

/** Flag keys: the declared ones, plus any string unless `strictKeys` is on. */
export type FlagKey = keyof FlagsList extends never
  ? string
  : Strict extends true
    ? Declared
    : Declared | (string & {});

/** The value type of a flag key (any JSON for keys not in {@link FlagsList}). */
export type FlagValue<K extends string> = K extends keyof FlagsList ? FlagsList[K] : JsonValue;

/** Keys whose value is boolean (what `enabled()` accepts). */
export type BooleanFlagKey = keyof FlagsList extends never
  ? string
  :
      | ({ [K in keyof FlagsList]: FlagsList[K] extends boolean ? K : never }[keyof FlagsList] &
          string)
      | (Strict extends true ? never : string & {});
