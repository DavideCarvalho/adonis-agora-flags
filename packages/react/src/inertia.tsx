import { router } from '@inertiajs/react';
import { type ReactNode, useEffect, useState } from 'react';
import { FlagsProvider, type TransmitLike, useFlagsRealtime } from './index.js';

type Values = Record<string, unknown>;

export interface InertiaFlagsProviderProps {
  /** The first page (`props.initialPage` in `createInertiaApp`'s `setup`). */
  initialPage: { props: Record<string, unknown> };
  /** The shared prop holding the flags. Default `flags`. */
  prop?: string;
  /**
   * Live updates: with `realtime: true` in `config/flags.ts` and `@adonisjs/transmit`, reloads the
   * flags prop (`router.reload({ only: [prop] })`) whenever the ruleset changes.
   */
  realtime?: { transmit: TransmitLike; channel?: string };
  children: ReactNode;
}

function Realtime({
  transmit,
  channel,
  prop,
}: {
  transmit: TransmitLike;
  channel: string | undefined;
  prop: string;
}) {
  useFlagsRealtime({
    transmit,
    ...(channel ? { channel } : {}),
    onChange: () => router.reload({ only: [prop] }),
  });
  return null;
}

/**
 * `FlagsProvider` for Inertia apps: starts from the first page's shared `flags` prop and follows it
 * on every Inertia response — visits, `router.reload()`, partial reloads such as
 * `router.reload({ only: ['flags'] })`. Mount it in `setup`, around `<App>`:
 *
 * ```tsx
 * setup({ el, App, props }) {
 *   createRoot(el).render(
 *     <InertiaFlagsProvider initialPage={props.initialPage}>
 *       <App {...props} />
 *     </InertiaFlagsProvider>,
 *   )
 * }
 * ```
 *
 * Pass `realtime={{ transmit }}` to also follow ruleset changes while the page stays open.
 *
 * A plain `<FlagsProvider values={props.initialPage.props.flags}>` there would keep the first
 * page's values forever: `setup` runs once.
 */
export function InertiaFlagsProvider({
  initialPage,
  prop = 'flags',
  realtime,
  children,
}: InertiaFlagsProviderProps) {
  const [values, setValues] = useState<Values>(
    (initialPage.props[prop] as Values | undefined) ?? {},
  );
  useEffect(
    () =>
      // `success` fires for visits and reloads alike (`navigate` does not fire on reloads). A
      // partial reload that left the prop out keeps the current values.
      router.on('success', (event: { detail: { page: { props: Record<string, unknown> } } }) => {
        const next = event.detail.page.props[prop] as Values | undefined;
        if (next) setValues(next);
      }),
    [prop],
  );
  return (
    <FlagsProvider values={values}>
      {realtime ? (
        <Realtime transmit={realtime.transmit} channel={realtime.channel} prop={prop} />
      ) : null}
      {children}
    </FlagsProvider>
  );
}
