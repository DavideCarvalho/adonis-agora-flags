import { useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { AppModeBadge } from '../agora-kit/blocks/app-mode';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { subscribeHashUrl } from '../agora-kit/url-state/hash-url';
import { type AppsResponse, type ConsoleApp, type Meta, selectedApp } from '../client/flags-client';

/** Put the picked app in the URL (`?app=`, absent = all apps), keeping the hash route. */
function writeAppToUrl(app: string | undefined): void {
  const url = new URL(window.location.href);
  if (app === undefined) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  window.history.pushState(null, '', url.toString());
  // A pushState fires nothing: tell the shell and the URL-state adapter the URL moved.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * The page's query string (`?app=` / `?tenant=`), kept current: a pick writes it with
 * `pushState` plus a `popstate`. The shell reads it so its cross-console links carry the new
 * scope right after a pick.
 */
export function usePageSearch(): string {
  return useSyncExternalStore(
    subscribeHashUrl,
    () => window.location.search,
    () => '',
  );
}

/** What the picker offers: nothing on a standalone app with no federated apps, or with one app. */
export function appPickerMode(
  meta: Meta | undefined,
  directory?: AppsResponse | undefined,
): 'off' | 'fixed' | 'pick' {
  if (directory) {
    const federated = directory.apps.some((app) => app.mode === 'federated');
    if (directory.topology !== 'control-plane' && !federated) return 'off';
    // A standalone app with federated apps: this app is the first choice, so one more is a pick.
    if (directory.topology !== 'control-plane') return directory.apps.length > 0 ? 'pick' : 'off';
    if (directory.apps.length > 1) return 'pick';
    if (directory.apps.length === 1 && federated) return 'pick';
    return directory.apps.length === 1 && Array.isArray(directory.appScope) ? 'fixed' : 'off';
  }
  if (meta?.topology !== 'control-plane') return 'off';
  const apps = meta.apps ?? [];
  if (apps.length > 1) return 'pick';
  // One app: worth a chip only when this person is limited to it.
  return apps.length === 1 && Array.isArray(meta.appScope) ? 'fixed' : 'off';
}

/** The apps the picker lists: `/api/apps` when the server has it, else `meta.apps`. */
export function pickerApps(meta: Meta | undefined, directory?: AppsResponse): ConsoleApp[] {
  if (directory) return directory.apps;
  return (meta?.apps ?? []).map((id) => ({
    id,
    label: id,
    mode: 'control-plane' as const,
    actions: 'here' as const,
  }));
}

const TEXT = {
  noun: 'App',
  all: 'All apps',
  some: 'Every app you can see',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The header's "App" control: which app's flags, events and results every screen shows. On a
 * central server, "All apps" first (every app this person may see, together), then its tenants;
 * then the federated apps of `apps` in config/flags_dashboard.ts, tagged `federated`. On a
 * standalone app with federated apps, this app comes first. A fixed chip for someone limited to
 * one app; nothing when there is nothing to pick.
 */
export function AppPicker({
  meta,
  directory,
}: {
  meta: Meta | undefined;
  directory?: AppsResponse | undefined;
}) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(selectedApp);
  const mode = appPickerMode(meta, directory);
  if (mode === 'off') return null;
  const apps = pickerApps(meta, directory);
  const byId = new Map(apps.map((app) => [app.id, app]));

  if (mode === 'fixed') {
    return <ScopeChip noun={TEXT.noun} label={apps[0]?.label ?? 'none'} kind="app" />;
  }

  const central = (directory?.topology ?? meta?.topology) === 'control-plane';
  const text = central ? TEXT : { ...TEXT, all: directory?.local.label ?? meta?.app ?? 'This app' };
  const picked = current !== undefined ? byId.get(current) : undefined;

  const choose = async (app: string | undefined) => {
    writeAppToUrl(app);
    setCurrent(app);
    // Everything changes with the app, `meta` too (a federated app has its own environments).
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'apps' });
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <ScopeMenu
        items={apps.map((app) => ({
          id: app.id,
          label: app.label,
          ...(app.mode === 'federated' ? { hint: 'federated' } : {}),
        }))}
        all
        current={current}
        text={text}
        labelOf={(id) => byId.get(id)?.label ?? id}
        onChoose={(next) => void choose(next)}
      />
      {picked && (
        <AppModeBadge
          mode={picked.mode}
          actions={picked.actions}
          appLabel={picked.label}
          className="hidden sm:inline-flex"
        />
      )}
    </span>
  );
}
