import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../client/flags-client';
import { useEnv } from './env';
import { STALE_LABELS } from './serving';
import { Panel, QueryState, Table } from './shell';
import { Badge } from './ui/badge';
import { Field, Input } from './ui/form';

/** Flags that probably should be removed from code and from the ruleset. */
export function Hygiene({ onOpen }: { onOpen: (key: string) => void }) {
  const { environment } = useEnv();
  const [unusedDays, setUnusedDays] = useState(30);
  const [staticDays, setStaticDays] = useState(30);
  const query = useQuery({
    queryKey: ['stale', environment, unusedDays, staticDays],
    queryFn: () => api.stale(environment, unusedDays, staticDays),
  });
  const flags = query.data?.data ?? [];
  return (
    <Panel
      title="Stale flags"
      subtitle="Not evaluated lately, past their declared expiry, serving one value to everyone for a while, or no longer declared in code."
      actions={
        <div className="flex gap-2">
          <Field label="Unused for (days)" className="flex-row items-center gap-2">
            <Input
              aria-label="Unused days"
              type="number"
              min={1}
              className="w-20"
              value={unusedDays}
              onChange={(e) => setUnusedDays(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label="Static for (days)" className="flex-row items-center gap-2">
            <Input
              aria-label="Static days"
              type="number"
              min={1}
              className="w-20"
              value={staticDays}
              onChange={(e) => setStaticDays(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
        </div>
      }
    >
      <QueryState
        query={query}
        empty={flags.length === 0}
        emptyMessage="Nothing stale. Every flag is in use and still changing."
      >
        <Table head={['Flag', 'Why', 'Last evaluated', 'Expires', 'Owner']}>
          {flags.map((flag) => (
            <tr key={flag.key}>
              <td className="px-4 py-2">
                <button
                  type="button"
                  className="mono text-fg hover:text-brand"
                  onClick={() => onOpen(flag.key)}
                >
                  {flag.key}
                </button>
              </td>
              <td className="px-4 py-2">
                <div className="flex flex-wrap gap-1">
                  {flag.reasons.map((reason) => (
                    <Badge key={reason} variant="danger">
                      {STALE_LABELS[reason]}
                    </Badge>
                  ))}
                </div>
              </td>
              <td className="mono px-4 py-2 text-dim">{flag.lastEvaluated ?? 'never'}</td>
              <td className="mono px-4 py-2 text-dim">{flag.expiresAt ?? '—'}</td>
              <td className="px-4 py-2 text-dim">{flag.owner ?? '—'}</td>
            </tr>
          ))}
        </Table>
      </QueryState>
    </Panel>
  );
}
