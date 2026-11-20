import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { useMemo, useState } from 'react';
import { ComboSelect } from '../agora-kit/blocks/combo-field';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { api, type FlagRow } from '../client/flags-client';
import { ConfigLockBadge } from './ConfigLock';
import { flagFacets, useFlagRows } from './catalogs';
import { Notice, useEnv, useWrite } from './env';
import { NewFlag } from './NewFlag';
import { describeServing, formatValue, STALE_LABELS, servingTone } from './serving';
import { DateText, ErrorBox, Panel, QueryState, Table, TableSkeleton } from './shell';
import { Badge } from './ui/badge';
import { Button, Input, Toggle } from './ui/form';
import { Segmented } from './ui/segmented';

const SHOWS = ['all', 'stale', 'experiments'] as const;
type Show = (typeof SHOWS)[number];

/**
 * The list's filters, in the hash's query (`#/flags?q=checkout&tag=billing&show=stale`). Typing in
 * the search rewrites the current history entry; picking a tag, an owner or a view adds one.
 */
export const flagListParams = {
  q: parseAsString.withDefault(''),
  tag: parseAsString.withDefault('').withOptions({ history: 'push' }),
  owner: parseAsString.withDefault('').withOptions({ history: 'push' }),
  show: parseAsStringLiteral(SHOWS).withDefault('all').withOptions({ history: 'push' }),
};

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
  const query = useFlagRows(environment);
  const [{ q: search, tag, owner, show }, setFilters] = useQueryStates(flagListParams);
  const [creating, setCreating] = useState(false);
  const kill = useWrite((input: { key: string; enabled: boolean }) =>
    api.setEnabled(environment, input.key, input.enabled),
  );

  const flags = query.data?.data ?? [];
  const { tags, owners } = useMemo(() => flagFacets(flags), [flags]);
  const visible = filterFlags(flags, { search, tag, owner, show });

  return (
    <div className="flex flex-col gap-4">
      {query.data ? (
        <FlagMetrics flags={flags} version={query.data.version} />
      ) : query.isPending ? (
        <MetricGridSkeleton count={5} />
      ) : null}
      <Panel
        title="All flags"
        subtitle={`${visible.length} of ${flags.length} flags in ${environment}`}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="primary" onClick={() => setCreating((open) => !open)}>
              New flag
            </Button>
            <Segmented
              aria-label="Show"
              value={show}
              onChange={(value) => void setFilters({ show: value })}
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
            onChange={(e) => void setFilters({ q: e.target.value })}
            className="min-w-0 flex-1 basis-full sm:basis-auto"
          />
          <ComboSelect
            aria-label="Tag"
            className="w-40"
            options={tags}
            value={tag === '' ? null : tag}
            onValueChange={(next) => void setFilters({ tag: next ?? '' })}
            placeholder="All tags"
          />
          <ComboSelect
            aria-label="Owner"
            className="w-40"
            options={owners}
            value={owner === '' ? null : owner}
            onValueChange={(next) => void setFilters({ owner: next ?? '' })}
            placeholder="All owners"
          />
        </div>
        {kill.isError && <ErrorBox error={kill.error} />}
        {kill.notice !== null && (
          <div className="border-b border-line px-4 py-2">
            <Notice text={kill.notice} />
          </div>
        )}
        <QueryState
          query={query}
          skeleton={<TableSkeleton columns={8} />}
          emptyTitle={flags.length === 0 ? 'No flags yet' : 'No match'}
          empty={visible.length === 0}
          emptyMessage={
            flags.length === 0
              ? 'No flags yet. Create one with “New flag”, or declare it in config/flags.ts.'
              : 'No flag matches these filters.'
          }
        >
          <FlagsTable
            flags={visible}
            onOpen={onOpen}
            toggling={kill.isPending}
            onToggle={(key, enabled) => kill.mutate({ key, enabled })}
          />
        </QueryState>
      </Panel>
    </div>
  );
}

/** The metric row over the list: how many flags, how many serve, how many are killed or stale. */
export function FlagMetrics({ flags, version }: { flags: FlagRow[]; version: string }) {
  const killed = flags.filter((f) => f.enabled === false).length;
  const stale = flags.filter((f) => f.stale.length > 0).length;
  const experiments = flags.filter((f) => f.experiment).length;
  const undeclared = flags.filter((f) => f.declaration === null).length;
  return (
    <MetricGrid>
      <MetricCard label="Flags" value={flags.length} caption={`ruleset v${version}`} />
      <MetricCard
        label="Serving"
        value={flags.length - killed}
        tone="brand"
        caption={`${flags.filter((f) => f.inRuleset).length} stored · ${flags.filter((f) => !f.inRuleset).length} code default`}
      />
      <MetricCard
        label="Killed"
        value={killed}
        tone={killed > 0 ? 'bad' : 'default'}
        caption="kill switch off"
      />
      <MetricCard
        label="Stale"
        value={stale}
        tone={stale > 0 ? 'warn' : 'default'}
        caption={undeclared > 0 ? `${undeclared} undeclared in code` : 'due for removal'}
      />
      <MetricCard
        label="Experiments"
        value={experiments}
        tone="violet"
        caption="flags with variants"
      />
    </MetricGrid>
  );
}

/** The flag rows: kill switch, key + description + tags, type, serving, owner, expiry, last change. Pure. */
export function FlagsTable({
  flags,
  onOpen,
  onToggle,
  toggling,
}: {
  flags: FlagRow[];
  onOpen: (key: string) => void;
  onToggle: (key: string, enabled: boolean) => void;
  toggling: boolean;
}) {
  const visible = flags;
  return (
    <Table head={['On', 'Flag', 'Type', 'Serving', 'Owner', 'Expires', 'Updated', '']}>
      {visible.map((flag) => (
        <tr key={flag.key} className="hover:bg-hover">
          <td className="px-4 py-2">
            <Toggle
              label={`Kill switch for ${flag.key}`}
              checked={flag.enabled ?? true}
              disabled={toggling}
              onChange={(enabled) => onToggle(flag.key, enabled)}
            />
          </td>
          <td className="px-4 py-2">
            <button
              type="button"
              className="mono text-left text-fg hover:text-brand"
              onClick={() => onOpen(flag.key)}
            >
              {flag.key}
            </button>
            {flag.declaration?.description && (
              <p className="text-[11px] text-dim">{flag.declaration.description}</p>
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
          <td className="px-4 py-2 text-dim">
            {flag.declaration ? (
              <>
                {flag.declaration.type}
                {flag.declaration.source === 'console' ? (
                  <Badge className="ml-1" title="Created in the console">
                    console
                  </Badge>
                ) : (
                  <span className="ml-1 inline-flex">
                    <ConfigLockBadge title="Declared in config/flags.ts: type and default change in code">
                      code
                    </ConfigLockBadge>
                  </span>
                )}
                {flag.declaration.overriddenConsole && (
                  <Badge
                    variant="warn"
                    className="ml-1"
                    title="Created in the console, declared in code since: the code's declaration applies"
                  >
                    overridden
                  </Badge>
                )}
                <span className="block text-[10px] text-faint">
                  default {formatValue(flag.declaration.default)}
                </span>
              </>
            ) : (
              <span className="text-warn">undeclared</span>
            )}
          </td>
          <td className={`px-4 py-2 s-${servingTone(flag.serving)}`}>
            {describeServing(flag.serving)}
            {(flag.rules > 0 || flag.overrides > 0) && (
              <span className="block text-[10px] text-dim">
                {flag.rules} rules · {flag.overrides} overrides
              </span>
            )}
          </td>
          <td className="px-4 py-2 text-dim">{flag.owner ?? '—'}</td>
          <td className="px-4 py-2 text-dim">{flag.expiresAt ?? '—'}</td>
          <td className="whitespace-nowrap px-4 py-2 text-dim">
            <DateText iso={flag.updatedAt} />
          </td>
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
  );
}
