import type { FlagsRuntime } from '../runtime.js';

/**
 * The runtime the provider built, readable outside the container (middleware, the OpenFeature
 * provider, commands). Kept on a `Symbol.for` slot so two copies of this package in one process
 * still share it.
 */
const SLOT = Symbol.for('@adonis-agora/flags/runtime');

type Holder = { [SLOT]?: FlagsRuntime | undefined };

export function setRuntime(runtime: FlagsRuntime | undefined) {
  (globalThis as Holder)[SLOT] = runtime;
}

export function getRuntime(): FlagsRuntime {
  const runtime = (globalThis as Holder)[SLOT];
  if (!runtime) {
    throw new Error(
      '@adonis-agora/flags is not booted: register "@adonis-agora/flags/flags_provider" in adonisrc.ts (node ace configure @adonis-agora/flags)',
    );
  }
  return runtime;
}

export function hasRuntime(): boolean {
  return (globalThis as Holder)[SLOT] !== undefined;
}
