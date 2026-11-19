import { useQueryClient } from '@tanstack/react-query';
import { useState, useSyncExternalStore } from 'react';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { subscribeHashUrl } from '../agora-kit/url-state/hash-url';
import { type Meta, selectedApp } from '../client/flags-client';

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

/** What the picker offers, from `meta`: nothing on a standalone app or with a single app. */
export function appPickerMode(meta: Meta | undefined): 'off' | 'fixed' | 'pick' {
  if (meta?.topology !== 'control-plane') return 'off';
  const apps = meta.apps ?? [];
  if (apps.length > 1) return 'pick';
  // One app: worth a chip only when this person is limited to it.
  return apps.length === 1 && Array.isArray(meta.appScope) ? 'fixed' : 'off';
}

const TEXT = {
  noun: 'App',
  all: 'All apps',
  some: 'Every app you can see',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The header's "App" control on a central server: which app's events, exposures, evaluation counts
 * and results every screen shows. The kit's searchable `ScopeMenu`, "All apps" first (every app
 * this person may see, together); a fixed chip for someone limited to one app; nothing on a
 * standalone app.
 */
export function AppPicker({ meta }: { meta: Meta | undefined }) {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(selectedApp);
  const mode = appPickerMode(meta);
  if (mode === 'off') return null;
  const apps = meta?.apps ?? [];

  if (mode === 'fixed') {
    return <ScopeChip noun={TEXT.noun} label={apps[0] ?? 'none'} kind="app" />;
  }

  const choose = async (app: string | undefined) => {
    writeAppToUrl(app);
    setCurrent(app);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'meta' });
  };

  return (
    <ScopeMenu
      items={apps.map((app) => ({ id: app, label: app }))}
      all
      current={current}
      text={TEXT}
      labelOf={(id) => id}
      onChoose={(next) => void choose(next)}
    />
  );
}
