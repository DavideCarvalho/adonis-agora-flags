import type { JsonValue } from '@adonis-agora/flags-core';

/** The value types a flag can carry. */
export type FlagType = 'boolean' | 'string' | 'number' | 'json';

/** Metadata every declaration accepts. None of it is evaluated; the console and commands read it. */
export interface FlagMeta {
  /** One line on what the flag controls. */
  description?: string;
  /** Who to ask about it (a person, team or channel). */
  owner?: string;
  /**
   * When the flag is expected to be removed (ISO date). Past this date `flags:stale` and the
   * console list it, so temporary flags do not become permanent by neglect.
   */
  expiresAt?: string;
  /** Free-form labels. */
  tags?: string[];
  /**
   * Allowed to reach the browser: included by `ctx.flags.all()` (Inertia shared props, `useFlag`).
   * Off by default so internal flag names and values are never sent to a page by accident.
   */
  client?: boolean;
}

/**
 * A flag declared in code: its type and the value served whenever the ruleset cannot answer (store
 * down, flag missing, error). Declarations are the source of truth for keys and types; targeting
 * lives in the store.
 */
export interface FlagDeclaration<T extends JsonValue = JsonValue> extends FlagMeta {
  type: FlagType;
  default: T;
  /**
   * Named variants for string flags (experiments). The console offers exactly these, and the type
   * of `flags.variant()` narrows to them.
   */
  variants?: readonly string[];
}

/** Builders for flag declarations, used in `config/flags.ts`. */
export const flag = {
  /** An on/off flag. */
  boolean(options: FlagMeta & { default: boolean }): FlagDeclaration<boolean> {
    return { ...options, type: 'boolean' };
  },
  /**
   * A string flag. With `variants`, the flag is a multivariate experiment and its type narrows to
   * the listed names.
   */
  string<const V extends string>(
    options: FlagMeta & { default: NoInfer<V>; variants?: readonly V[] },
  ): FlagDeclaration<V> {
    if (options.variants && !options.variants.includes(options.default)) {
      throw new Error(`flag default "${options.default}" is not one of its variants`);
    }
    return { ...options, type: 'string' };
  },
  /** A numeric flag (limits, thresholds, percentages). */
  number(options: FlagMeta & { default: number }): FlagDeclaration<number> {
    return { ...options, type: 'number' };
  },
  /** A JSON payload flag (configuration objects). */
  json<T extends JsonValue>(options: FlagMeta & { default: T }): FlagDeclaration<T> {
    return { ...options, type: 'json' };
  },
};

/** The value type of a declaration. */
export type ValueOf<D> = D extends FlagDeclaration<infer T> ? T : never;

/** Turns `{ key: FlagDeclaration<T> }` into `{ key: T }`. */
export type InferFlags<C> = C extends { flags: infer F }
  ? { [K in keyof F]: ValueOf<F[K]> }
  : C extends Record<string, FlagDeclaration>
    ? { [K in keyof C]: ValueOf<C[K]> }
    : never;

/** A JSON-safe copy of the declarations, as pushed to a control-plane and shown in the console. */
export function serializeDeclarations(
  declarations: Record<string, FlagDeclaration>,
): Record<string, FlagDeclaration> {
  return JSON.parse(JSON.stringify(declarations)) as Record<string, FlagDeclaration>;
}
