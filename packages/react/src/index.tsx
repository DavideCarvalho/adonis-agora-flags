import type { FlagKey, FlagValue } from '@adonis-agora/flags/types';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';

export const VERSION = '0.0.0';

/** The flag values the server evaluated for this page (`ctx.flags.all()`). */
export type FlagValues = Record<string, unknown>;

const FlagsContext = createContext<FlagValues | null>(null);

/**
 * Makes the server-evaluated flags available to the tree. With Inertia, share them from the server
 * and pass the page prop:
 *
 * ```ts
 * // config/inertia.ts
 * sharedData: { flags: (ctx) => ctx.flags.all() }
 * ```
 * ```tsx
 * <FlagsProvider values={props.flags}>…</FlagsProvider>
 * ```
 *
 * Only flags declared with `client: true` are included by `ctx.flags.all()`; the browser never sees
 * targeting rules, only values.
 */
export function FlagsProvider({
  values,
  children,
}: {
  values: FlagValues | undefined;
  children: ReactNode;
}) {
  return <FlagsContext.Provider value={values ?? {}}>{children}</FlagsContext.Provider>;
}

/** All flag values in context. */
export function useFlags(): FlagValues {
  const values = useContext(FlagsContext);
  if (values === null) throw new Error('useFlags() must be used inside <FlagsProvider>');
  return values;
}

/**
 * One flag's value, typed from the app's flag declarations. `fallback` is used when the server did
 * not send the flag (not declared `client: true`, or an older page).
 */
export function useFlag<K extends FlagKey>(key: K, fallback: FlagValue<K>): FlagValue<K> {
  const values = useFlags();
  return (Object.hasOwn(values, key) ? values[key] : fallback) as FlagValue<K>;
}

/** Whether a boolean flag is on (`false` when absent). */
export function useFlagEnabled(key: FlagKey): boolean {
  return useFlags()[key] === true;
}

/**
 * Renders `children` when a boolean flag is on, or when a multivariate flag serves one of `is`.
 *
 * ```tsx
 * <Flag name="new_player" fallback={<OldPlayer />}><NewPlayer /></Flag>
 * <Flag name="checkout" is="one_page"><OnePageCheckout /></Flag>
 * ```
 */
export function Flag({
  name,
  is,
  fallback = null,
  children,
}: {
  name: FlagKey;
  is?: string | string[];
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const value = useFlags()[name];
  const show =
    is === undefined ? value === true : (Array.isArray(is) ? is : [is]).includes(String(value));
  return <>{show ? children : fallback}</>;
}

/** The part of `@adonisjs/transmit-client` this hook uses. */
export interface TransmitLike {
  subscription(channel: string): {
    create(): Promise<void>;
    onMessage<T>(handler: (message: T) => void): () => void;
    delete(): Promise<void>;
  };
}

/**
 * Live updates: when the server's ruleset changes (config `realtime: true`), calls `onChange` —
 * typically an Inertia partial reload of the `flags` prop:
 *
 * ```tsx
 * useFlagsRealtime({ transmit, onChange: () => router.reload({ only: ['flags'] }) })
 * ```
 */
export function useFlagsRealtime(options: {
  transmit: TransmitLike;
  onChange: (version: string) => void;
  /** Must match the server's `realtime.channel`. Default `flags/ruleset`. */
  channel?: string;
}) {
  const onChange = useRef(options.onChange);
  onChange.current = options.onChange;
  const channel = options.channel ?? 'flags/ruleset';
  const transmit = options.transmit;
  useEffect(() => {
    const subscription = transmit.subscription(channel);
    let stop: (() => void) | undefined;
    let cancelled = false;
    void subscription.create().then(() => {
      if (cancelled) return;
      stop = subscription.onMessage<{ version: string }>((message) =>
        onChange.current(message.version),
      );
    });
    return () => {
      cancelled = true;
      stop?.();
      void subscription.delete();
    };
  }, [transmit, channel]);
}

/** Memoized helper for non-React code paths that received the values (e.g. a store). */
export function useFlagSnapshot(): Readonly<FlagValues> {
  const values = useFlags();
  return useMemo(() => Object.freeze({ ...values }), [values]);
}
