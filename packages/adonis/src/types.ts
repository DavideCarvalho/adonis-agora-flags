/**
 * The typed flag registry. `config/flags.ts` augments it so every key and value is checked:
 *
 * ```ts
 * declare module '@adonis-agora/flags/types' {
 *   interface FlagsList extends InferFlags<typeof flagsConfig> {}
 * }
 * ```
 *
 * Until the app augments it, keys are plain strings and values are any JSON.
 */
export interface FlagsList {}

import type { JsonValue } from '@adonis-agora/flags-core';

/** Flag keys: the declared ones once `FlagsList` is augmented, any string before. */
export type FlagKey = keyof FlagsList extends never ? string : Extract<keyof FlagsList, string>;

/** The value type of a flag key. */
export type FlagValue<K extends string> = K extends keyof FlagsList ? FlagsList[K] : JsonValue;

/** Keys whose value is boolean (what `enabled()` accepts). */
export type BooleanFlagKey = keyof FlagsList extends never
  ? string
  : { [K in keyof FlagsList]: FlagsList[K] extends boolean ? K : never }[keyof FlagsList] & string;
