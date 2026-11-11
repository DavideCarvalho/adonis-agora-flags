import type { FlagKey, FlagValue } from '@adonis-agora/flags/types';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { RemoteFlags } from './remote.js';

export {
  type BrowserToken,
  type EndpointOptions,
  RemoteFlags,
  type RemoteFlagsOptions,
  type RemoteState,
  remoteFlags,
  type TokenOptions,
} from './remote.js';

export const VERSION = '0.0.0';

/** The flag values available to the tree. */
export type FlagValues = Record<string, unknown>;

interface FlagsContextValue {
  values: FlagValues;
  ready: boolean;
  error: Error | null;
  expose(key: string): void;
  track(name: string, options?: { value?: number; props?: Record<string, unknown> }): void;
}

const FlagsContext = createContext<FlagsContextValue | null>(null);

const noop = () => {};
const subscribeNever = () => noop;

/**
 * Makes flags available to the tree, from one of two places:
 *
 * - `values` — what your Adonis backend evaluated for the page (Inertia):
 *   `sharedData: { flags: (ctx) => ctx.flags.all() }`, then `<FlagsProvider values={props.flags}>`.
 * - `source` — a flags server the browser talks to directly (SPAs, mobile, static sites):
 *   `<FlagsProvider source={remoteFlags({ endpoint: '/_flags/token' })}>`. Rendering an experiment flag records
 *   the exposure; `useTrack()` records conversions.
 *
 * Either way the browser receives values, never targeting rules, and only for flags declared
 * `client: true`.
 */
export function FlagsProvider({
  values,
  source,
  children,
}: {
  values?: FlagValues | undefined;
  source?: RemoteFlags;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!source) return;
    source.start();
    return () => source.stop();
  }, [source]);
  const remote = useSyncExternalStore(
    source?.subscribe ?? subscribeNever,
    () => source?.getSnapshot() ?? null,
    () => source?.getSnapshot() ?? null,
  );
  const value = useMemo<FlagsContextValue>(() => {
    if (source && remote) {
      return {
        values: remote.values,
        ready: remote.ready,
        error: remote.error,
        expose: (key) => source.expose(key),
        track: (name, options) => source.track(name, options),
      };
    }
    return { values: values ?? {}, ready: true, error: null, expose: noop, track: noop };
  }, [source, remote, values]);
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}

function useFlagsContext(): FlagsContextValue {
  const context = useContext(FlagsContext);
  if (context === null) throw new Error('flags hooks must be used inside <FlagsProvider>');
  return context;
}

/** Records an exposure once the component rendering `key` mounts (remote sources only). */
function useExposure(key: string, active = true) {
  const { expose, ready } = useFlagsContext();
  useEffect(() => {
    if (active && ready) expose(key);
  }, [expose, key, ready, active]);
}

/** All flag values in context. */
export function useFlags(): FlagValues {
  return useFlagsContext().values;
}

/** Whether the first evaluation arrived (always `true` with `values`), and the last error. */
export function useFlagsStatus(): { ready: boolean; error: Error | null } {
  const { ready, error } = useFlagsContext();
  return { ready, error };
}

/**
 * One flag's value, typed from the app's flags. `fallback` is used until the value is known, or
 * when the server did not send the flag (not declared `client: true`).
 */
export function useFlag<K extends FlagKey>(key: K, fallback: FlagValue<K>): FlagValue<K> {
  const values = useFlags();
  useExposure(key);
  return (Object.hasOwn(values, key) ? values[key] : fallback) as FlagValue<K>;
}

/** Whether a boolean flag is on (`false` when absent). */
export function useFlagEnabled(key: FlagKey): boolean {
  const values = useFlags();
  useExposure(key);
  return values[key] === true;
}

/** Records conversions for the signed-in user (remote sources; a no-op with `values`). */
export function useTrack(): FlagsContextValue['track'] {
  return useFlagsContext().track;
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
  useExposure(name);
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
 * Live updates for the `values` (Inertia) mode: when the server's ruleset changes (config
 * `realtime: true`), calls `onChange` — typically an Inertia partial reload of the `flags` prop.
 * Remote sources update themselves.
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

/** A frozen copy of the values, for non-React code paths. */
export function useFlagSnapshot(): Readonly<FlagValues> {
  const values = useFlags();
  return useMemo(() => Object.freeze({ ...values }), [values]);
}
