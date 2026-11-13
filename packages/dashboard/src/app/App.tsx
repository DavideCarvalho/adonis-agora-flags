import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api, defaultEnvironment } from '../client/flags-client';
import { Activity } from './Activity';
import { Approvals } from './Approvals';
import { Environments } from './Environments';
import { ExperimentDetail, Experiments } from './Experiments';
import { EnvProvider } from './env';
import { FlagEditor } from './FlagEditor';
import { FlagsList } from './FlagsList';
import { Hygiene } from './Hygiene';
import { Layers } from './Layers';
import { Metrics } from './Metrics';
import { Ops } from './Ops';
import { formatRoute, parseRoute, type Route, SCREENS } from './routes';
import { Segments } from './Segments';
import { Select } from './ui/form';
import { Segmented } from './ui/segmented';

/** The hash is the single source of truth for the screen, the open item and the environment. */
function useHashRoute(): [Route, (next: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  const navigate = useCallback((next: Route) => {
    const hash = formatRoute(next);
    if (window.location.hash !== hash) window.location.hash = hash;
  }, []);
  return [route, navigate];
}

/**
 * The console shell: a header with the environment switcher, the screen tabs, and one screen.
 *
 * The environment is in the hash and in the header in a colour of its own: every read and every
 * write on every screen goes to it, and the one mistake this console must make hard is editing
 * production while believing you are in staging.
 */
export function App() {
  const [route, navigate] = useHashRoute();
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, refetchInterval: false });
  const environment = route.env ?? meta.data?.environment ?? defaultEnvironment();
  const go = (next: Omit<Route, 'env'>) =>
    navigate({ ...next, ...(route.env !== undefined ? { env: route.env } : {}) });
  const environments = [...new Set([environment, ...(meta.data?.environments ?? [])])].sort();
  const approvals = meta.data?.approvals[environment] === true;
  const isAppEnvironment = environment === (meta.data?.environment ?? defaultEnvironment());

  return (
    <EnvProvider value={{ environment, meta: meta.data }}>
      <div className="relative min-h-full">
        <div className="app-bg" />
        <div className="relative z-10 mx-auto max-w-6xl px-3 py-4 sm:px-4 sm:py-6">
          <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg text-zinc-100">
                flags <span className="text-brand">·</span> console
              </h1>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                {meta.data
                  ? `${meta.data.app} · ${meta.data.topology} · signed in as ${meta.data.actor.name ?? meta.data.actor.id}`
                  : 'Flags, targeting and experiments, edited where they are evaluated.'}
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">Environment</span>
              <Select
                aria-label="Environment"
                value={environment}
                onChange={(e) =>
                  navigate({
                    ...route,
                    env: e.target.value === meta.data?.environment ? undefined : e.target.value,
                  })
                }
                className={isAppEnvironment ? '' : 'border-warn/60 text-amber-300'}
              >
                {environments.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </Select>
              {approvals && (
                <span className="rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-amber-300">
                  approvals on
                </span>
              )}
            </div>
          </header>

          <Segmented
            aria-label="Screen"
            className="mb-4"
            options={SCREENS}
            value={route.screen}
            onChange={(screen) => go({ screen })}
          />

          {route.screen === 'flags' &&
            (route.id ? (
              <FlagEditor
                key={`${environment}:${route.id}`}
                flagKey={route.id}
                onClose={() => go({ screen: 'flags' })}
              />
            ) : (
              <FlagsList onOpen={(id) => go({ screen: 'flags', id })} />
            ))}
          {route.screen === 'segments' && <Segments key={environment} />}
          {route.screen === 'layers' && <Layers key={environment} />}
          {route.screen === 'experiments' &&
            (route.id ? (
              <ExperimentDetail
                experimentKey={route.id}
                onClose={() => go({ screen: 'experiments' })}
              />
            ) : (
              <Experiments onOpen={(id) => go({ screen: 'experiments', id })} />
            ))}
          {route.screen === 'metrics' && <Metrics key={environment} />}
          {route.screen === 'approvals' && <Approvals key={environment} />}
          {route.screen === 'activity' && <Activity key={environment} />}
          {route.screen === 'environments' && (
            <Environments key={`${environment}:${meta.data ? 'meta' : 'none'}`} />
          )}
          {route.screen === 'hygiene' && <Hygiene onOpen={(id) => go({ screen: 'flags', id })} />}
          {route.screen === 'ops' && <Ops />}
        </div>
      </div>
    </EnvProvider>
  );
}
