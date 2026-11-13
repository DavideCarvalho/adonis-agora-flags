import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, type FlagRow } from '../client/flags-client';
import { Notice, useEnv, useWrite } from './env';
import { NewFlag } from './NewFlag';
import { describeServing, formatValue, STALE_LABELS, servingTone } from './serving';
import { ErrorBox, Panel, QueryState, Table } from './shell';
import { Badge } from './ui/badge';
import { Button, Input, Select, Toggle } from './ui/form';
import { Segmented } from './ui/segmented';

type Show = 'all' | 'stale' | 'experiments';

/** Pure filter, so the list and its spec agree on what "matches" means. */
export function filterFlags(
  flags: FlagRow[],
  filters: { search: string; tag: string; owner: string; show: Show },
): FlagRow[] {
  const needle = filters.search.trim().toLowerCase();
  return flags.filter((flag) => {
    if (needle !== '') {
      const haystack = [flag.key, flag.declaration?.description ?? '', flag.owner ?? '']
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (filters.tag !== '' && !flag.tags.includes(filters.tag)) return false;
    if (filters.owner !== '' && flag.owner !== filters.owner) return false;
    if (filters.show === 'stale' && flag.stale.length === 0) return false;
    if (filters.show === 'experiments' && !flag.experiment) return false;
    return true;
  });
}

/**
 * Every flag — declared in code, stored in the ruleset, or both — with the kill switch on the row.
 * The switch is the one control that must be reachable in one click from the first screen: when a
 * flag is hurting production, nobody should have to find its editor first.
 */
export function FlagsList({ onOpen }: { onOpen: (key: string) => void }) {
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['flags', environment],
    queryFn: () => api.flags(environment),
  });
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [owner, setOwner] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [creating, setCreating] = useState(false);
  const kill = useWrite((input: { key: string; enabled: boolean }) =>
    api.setEnabled(environment, input.key, input.enabled),
  );

  const flags = query.data?.data ?? [];
  const tags = useMemo(() => [...new Set(flags.flatMap((f) => f.tags))].sort(), [flags]);
  const owners = useMemo(
    () => [...new Set(flags.map((f) => f.owner).filter((o): o is string => o !== null))].sort(),
    [flags],
  );
  const visible = filterFlags(flags, { search, tag, owner, show });

  return (
    <Panel
      title="Flags"
      subtitle={`${flags.length} flags in ${environment}${query.data ? ` · ruleset v${query.data.version}` : ''}`}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => setCreating((open) => !open)}>
            New flag
          </Button>
          <Segmented
            aria-label="Show"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'All' },
              {
                value: 'stale',
                label: 'Stale',
                hint: String(flags.filter((f) => f.stale.length > 0).length),
              },
              { value: 'experiments', label: 'Experiments' },
            ]}
          />
        </div>
      }
    >
      {creating && (
        <NewFlag
          onCancel={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            onOpen(key);
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Input
          aria-label="Search flags"
          placeholder="Search key, description, owner"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-w-0 flex-1"
        />
        <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Select aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">All owners</option>
          {owners.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </div>
      {kill.isError && <ErrorBox error={kill.error} />}
      {kill.notice !== null && (
        <div className="border-b border-line px-4 py-2">
          <Notice text={kill.notice} />
        </div>
      )}
      <QueryState
        query={query}
        empty={visible.length === 0}
        emptyMessage={
          flags.length === 0
            ? 'No flags yet. Create one with “New flag”, or declare it in config/flags.ts.'
            : 'No flag matches these filters.'
        }
      >
        <Table head={['On', 'Flag', 'Type', 'Serving', 'Owner', 'Expires', '']}>
          {visible.map((flag) => (
            <tr key={flag.key} className="hover:bg-panel-2/60">
              <td className="px-4 py-2">
                <Toggle
                  label={`Kill switch for ${flag.key}`}
                  checked={flag.enabled ?? true}
                  disabled={kill.isPending}
                  onChange={(enabled) => kill.mutate({ key: flag.key, enabled })}
                />
              </td>
              <td className="px-4 py-2">
                <button
                  type="button"
                  className="mono text-left text-zinc-100 hover:text-brand"
                  onClick={() => onOpen(flag.key)}
                >
                  {flag.key}
                </button>
                {flag.declaration?.description && (
                  <p className="text-[11px] text-zinc-500">{flag.declaration.description}</p>
                )}
                <div className="mt-1 flex flex-wrap gap-1">
                  {flag.experiment && <Badge variant="type">experiment</Badge>}
                  {flag.tags.map((t) => (
                    <Badge key={t}>{t}</Badge>
                  ))}
                  {flag.stale.map((reason) => (
                    <Badge key={reason} variant="danger" title={STALE_LABELS[reason]}>
                      {reason}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="px-4 py-2 text-zinc-400">
                {flag.declaration ? (
                  <>
                    {flag.declaration.type}
                    {flag.declaration.source === 'console' && (
                      <Badge className="ml-1" title="Created in the console">
                        console
                      </Badge>
                    )}
                    <span className="block text-[10px] text-zinc-600">
                      default {formatValue(flag.declaration.default)}
                    </span>
                  </>
                ) : (
                  <span className="text-amber-300">undeclared</span>
                )}
              </td>
              <td className={`px-4 py-2 s-${servingTone(flag.serving)}`}>
                {describeServing(flag.serving)}
                {(flag.rules > 0 || flag.overrides > 0) && (
                  <span className="block text-[10px] text-zinc-500">
                    {flag.rules} rules · {flag.overrides} overrides
                  </span>
                )}
              </td>
              <td className="px-4 py-2 text-zinc-400">{flag.owner ?? '—'}</td>
              <td className="px-4 py-2 text-zinc-400">{flag.expiresAt ?? '—'}</td>
              <td className="px-4 py-2 text-right">
                <button
                  type="button"
                  className="text-brand hover:underline"
                  onClick={() => onOpen(flag.key)}
                >
                  Edit
                </button>
              </td>
            </tr>
          ))}
        </Table>
      </QueryState>
    </Panel>
  );
}
