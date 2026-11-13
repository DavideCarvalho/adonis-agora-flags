import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { cn } from '../agora-kit/lib/utils';
import { AppShell, type NavSection, PageBody } from '../agora-kit/shell/app-shell';
import { type AgoraShellConfig, readShellConfig } from '../agora-kit/shell-config';
import { api, CONFIG_ELEMENT_ID, defaultEnvironment, type Meta } from '../client/flags-client';
import { Activity } from './Activity';
import { Approvals } from './Approvals';
import { Environments } from './Environments';
import { ExperimentDetail, Experiments } from './Experiments';
import { EnvProvider } from './env';
import { FlagEditor } from './FlagEditor';
import { FlagsList } from './FlagsList';
import { Hygiene } from './Hygiene';
import {
  ActivityIcon,
  ApprovalIcon,
  EnvironmentIcon,
  ExperimentIcon,
  FlagIcon,
  HygieneIcon,
  LayersIcon,
  LogoMark,
  MetricIcon,
  OpsIcon,
  SegmentIcon,
} from './icons';
import { Layers } from './Layers';
import { Metrics } from './Metrics';
import { Ops } from './Ops';
import { formatRoute, parseRoute, type Route, SCREENS, type Screen } from './routes';
import { Segments } from './Segments';

/** Flags' accent (emerald): passed to the kit's ThemeProvider in `main.tsx`. */
export const FLAGS_ACCENT = '#34d399';

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

const LABEL = Object.fromEntries(SCREENS.map((s) => [s.value, s.label])) as Record<Screen, string>;

/** Sidebar sections (CONSOLE-SHELL-SPEC): FLAGS · EXPERIMENTS · GOVERNANCE · CONFIG. */
const SECTIONS: ReadonlyArray<{ section: string; items: ReadonlyArray<[Screen, ReactNode]> }> = [
  {
    section: 'Flags',
    items: [
      ['flags', <FlagIcon key="i" />],
      ['segments', <SegmentIcon key="i" />],
      ['layers', <LayersIcon key="i" />],
    ],
  },
  {
    section: 'Experiments',
    items: [
      ['experiments', <ExperimentIcon key="i" />],
      ['metrics', <MetricIcon key="i" />],
    ],
  },
  {
    section: 'Governance',
    items: [
      ['approvals', <ApprovalIcon key="i" />],
      ['activity', <ActivityIcon key="i" />],
    ],
  },
  {
    section: 'Config',
    items: [
      ['environments', <EnvironmentIcon key="i" />],
      ['hygiene', <HygieneIcon key="i" />],
      ['ops', <OpsIcon key="i" />],
    ],
  },
];

/** The one sentence under each screen's title. */
const DESCRIPTION: Record<Screen, string> = {
  flags: 'Declared in code, stored in the ruleset, or both — with the kill switch on every row.',
  segments: 'Reusable audiences that flag rules target.',
  layers: 'Mutually exclusive experiments, and the global holdout.',
  experiments: 'Every experiment and what its numbers say so far.',
  metrics: 'What experiments measure, from events sent with track().',
  approvals: 'Changes filed for a second person, and their outcome.',
  activity: 'Every change to the ruleset, newest first.',
  environments: 'Export, import and promote rulesets between environments.',
  hygiene: 'Flags that are due for removal.',
  ops: 'Where the ruleset comes from, and whether events reach every sink.',
};

/** The sidebar footer's viewer: the provider's, else the acting person the API reports. */
function withViewer(shell: AgoraShellConfig, meta: Meta | undefined): AgoraShellConfig {
  if (shell.viewer || !meta || meta.actor.id === 'dashboard') return shell;
  return { ...shell, viewer: { label: meta.actor.name ?? meta.actor.id } };
}

/**
 * The environment picker, in the topbar. The environment is in the hash and drawn in a colour of
 * its own when it is not the app's: every read and every write on every screen goes to it, and the
 * one mistake this console must make hard is editing production while believing you are in staging.
 */
function EnvironmentPicker({
  environment,
  environments,
  isAppEnvironment,
  approvals,
  onChange,
}: {
  environment: string;
  environments: string[];
  isAppEnvironment: boolean;
  approvals: boolean;
  onChange: (environment: string) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {approvals && (
        <span className="hidden h-[18px] items-center rounded-full border border-warn/25 bg-warn/10 px-2 font-mono text-[10px] text-warn sm:inline-flex">
          approvals on
        </span>
      )}
      <label className="flex items-center gap-1.5">
        <span className="hidden text-[11px] text-faint md:inline">Environment</span>
        <select
          aria-label="Environment"
          value={environment}
          onChange={(e) => onChange(e.target.value)}
          className={cn(
            'mono h-[30px] max-w-[9.5rem] rounded-md border bg-panel-2 px-2 pr-6 text-[11.5px] font-medium focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
            isAppEnvironment ? 'border-input text-fg' : 'border-warn/50 bg-warn/10 text-warn',
          )}
        >
          {environments.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/**
 * The flags console: the Agora shell (kit) around ten screens in four sections, the environment
 * picker in the topbar. Every screen renders inside its own error boundary; detail views (a flag's
 * editor, an experiment's results) replace their list.
 */
export function App() {
  // What the provider put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shellConfig = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const [route, navigate] = useHashRoute();
  const meta = useQuery({ queryKey: ['meta'], queryFn: api.meta, refetchInterval: false });
  const appEnvironment = meta.data?.environment ?? defaultEnvironment();
  const environment = route.env ?? appEnvironment;
  const go = useCallback(
    (next: Omit<Route, 'env'>) =>
      navigate({ ...next, ...(route.env !== undefined ? { env: route.env } : {}) }),
    [navigate, route.env],
  );
  const environments = [...new Set([environment, ...(meta.data?.environments ?? [])])].sort();
  const approvals = meta.data?.approvals[environment] === true;
  const shell = useMemo(() => withViewer(shellConfig, meta.data), [shellConfig, meta.data]);

  const nav = useMemo<NavSection[]>(
    () =>
      SECTIONS.map(({ section, items }) => ({
        section,
        items: items.map(([screen, icon]) => ({
          id: screen,
          label: LABEL[screen],
          icon,
          href: formatRoute({ screen, ...(route.env !== undefined ? { env: route.env } : {}) }),
          onSelect: () => go({ screen }),
        })),
      })),
    [go, route.env],
  );

  const detail =
    route.id !== undefined && (route.screen === 'flags' || route.screen === 'experiments');
  const title = detail ? (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-dim">{LABEL[route.screen]}</span>
      <span className="text-faint">/</span>
      <span className="mono truncate">{route.id}</span>
    </span>
  ) : (
    LABEL[route.screen]
  );

  return (
    <EnvProvider value={{ environment, meta: meta.data }}>
      <AppShell
        brand={{
          name: 'flags',
          subtitle: meta.data ? `${meta.data.app} · ${meta.data.topology}` : 'console',
          mark: <LogoMark />,
          current: { title: 'Flags', package: '@adonis-agora/flags', icon: 'flags' },
        }}
        nav={nav}
        activeId={route.screen}
        shell={shell}
        title={title}
        searchPlaceholder="Search flags, segments, runs, users…"
        actions={
          <EnvironmentPicker
            environment={environment}
            environments={environments}
            isAppEnvironment={environment === appEnvironment}
            approvals={approvals}
            onChange={(env) =>
              navigate({ ...route, env: env === meta.data?.environment ? undefined : env })
            }
          />
        }
      >
        <PageBody>
          {!detail && (
            <PageHeader title={LABEL[route.screen]} description={DESCRIPTION[route.screen]} />
          )}
          <ErrorBoundary
            label={LABEL[route.screen]}
            resetKeys={[route.screen, route.id, environment]}
          >
            <ScreenView route={route} environment={environment} meta={meta.data} go={go} />
          </ErrorBoundary>
        </PageBody>
      </AppShell>
    </EnvProvider>
  );
}

function ScreenView({
  route,
  environment,
  meta,
  go,
}: {
  route: Route;
  environment: string;
  meta: Meta | undefined;
  go: (next: Omit<Route, 'env'>) => void;
}) {
  switch (route.screen) {
    case 'flags':
      return route.id ? (
        <FlagEditor
          key={`${environment}:${route.id}`}
          flagKey={route.id}
          onClose={() => go({ screen: 'flags' })}
        />
      ) : (
        <FlagsList onOpen={(id) => go({ screen: 'flags', id })} />
      );
    case 'segments':
      return <Segments key={environment} />;
    case 'layers':
      return <Layers key={environment} />;
    case 'experiments':
      return route.id ? (
        <ExperimentDetail experimentKey={route.id} onClose={() => go({ screen: 'experiments' })} />
      ) : (
        <Experiments onOpen={(id) => go({ screen: 'experiments', id })} />
      );
    case 'metrics':
      return <Metrics key={environment} />;
    case 'approvals':
      return <Approvals key={environment} />;
    case 'activity':
      return <Activity key={environment} />;
    case 'environments':
      return <Environments key={`${environment}:${meta ? 'meta' : 'none'}`} />;
    case 'hygiene':
      return <Hygiene onOpen={(id) => go({ screen: 'flags', id })} />;
    case 'ops':
      return <Ops />;
  }
}
