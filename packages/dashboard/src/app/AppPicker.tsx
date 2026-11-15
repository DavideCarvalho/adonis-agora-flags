import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../agora-kit/ui/popover';
import { type Meta, selectedApp } from '../client/flags-client';

/** Put the picked app in the URL (`?app=`, absent = all apps), keeping the hash route. */
function writeAppToUrl(app: string | undefined): void {
  const url = new URL(window.location.href);
  if (app === undefined) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  window.history.pushState(null, '', url.toString());
}

/** What the picker offers, from `meta`: nothing on a standalone app or with a single app. */
export function appPickerMode(meta: Meta | undefined): 'off' | 'fixed' | 'pick' {
  if (meta?.topology !== 'control-plane') return 'off';
  const apps = meta.apps ?? [];
  if (apps.length > 1) return 'pick';
  // One app: worth a chip only when this person is limited to it.
  return apps.length === 1 && Array.isArray(meta.appScope) ? 'fixed' : 'off';
}

/**
 * The header's "App" control on a central server: which app's events, exposures, evaluation counts
 * and results every screen shows. A searchable list, "All apps" first (every app this person may
 * see, together); a fixed chip for someone limited to one app; nothing on a standalone app.
 */
export function AppPicker({ meta }: { meta: Meta | undefined }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState(selectedApp);
  const mode = appPickerMode(meta);
  if (mode === 'off') return null;
  const apps = meta?.apps ?? [];

  const chip =
    'mono flex h-[30px] items-center gap-1.5 rounded-md border border-line bg-panel px-2 text-[11px] text-fg-2';

  if (mode === 'fixed') {
    return (
      <span className={chip} data-app-picker="fixed">
        <span className="text-dim">App</span>
        {apps[0]}
      </span>
    );
  }

  const choose = async (app: string | undefined) => {
    setOpen(false);
    setSearch('');
    writeAppToUrl(app);
    setCurrent(app);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'meta' });
  };
  const needle = search.trim().toLowerCase();
  const shown = apps.filter((app) => needle === '' || app.toLowerCase().includes(needle));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`${chip} hover:border-line-strong`}
        aria-label="App"
        data-app-picker="pick"
      >
        <span className="text-dim">App</span>
        {current ?? 'All apps'}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-1 p-1">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search apps…"
          aria-label="search apps"
          className="mb-1 w-full rounded border border-line bg-transparent px-2 py-1 text-xs text-fg outline-none"
        />
        <div role="listbox" aria-label="Apps" className="max-h-72 overflow-y-auto">
          <button
            type="button"
            role="option"
            aria-selected={current === undefined}
            onClick={() => void choose(undefined)}
            className="w-full rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-panel"
          >
            All apps
          </button>
          {shown.map((app) => (
            <button
              key={app}
              type="button"
              role="option"
              aria-selected={current === app}
              onClick={() => void choose(app)}
              className="mono w-full truncate rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-panel"
            >
              {app}
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-dim">No match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
