import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../client/flags-client';
import { useEnv } from './env';
import { HistoryPanel } from './FlagTools';
import { Panel, QueryState } from './shell';
import { Button, Input } from './ui/form';
import { Segmented } from './ui/segmented';

type Entity = '' | 'flag' | 'segment' | 'layer' | 'metric' | 'holdout' | 'ruleset';

/** The environment's audit log: every change, who made it, before and after. */
export function Activity() {
  const { environment } = useEnv();
  const [entity, setEntity] = useState<Entity>('');
  const [key, setKey] = useState('');
  // The cursors of the pages walked so far: the last one is the page shown, none is the newest.
  const [cursors, setCursors] = useState<string[]>([]);
  const after = cursors[cursors.length - 1];
  const query = useQuery({
    queryKey: ['audit', environment, entity, key, after],
    queryFn: () =>
      api.audit(environment, {
        ...(entity !== '' ? { entity } : {}),
        ...(key !== '' ? { key } : {}),
        ...(after ? { after } : {}),
      }),
  });
  const entries = query.data?.data ?? [];
  const next = query.data?.meta.nextCursor ?? null;
  return (
    <Panel
      title="Activity"
      subtitle={`Every change to ${environment}, newest first.`}
      actions={
        <Segmented
          aria-label="Entity"
          value={entity}
          onChange={(value) => {
            setEntity(value);
            setCursors([]);
          }}
          options={[
            { value: '', label: 'All' },
            { value: 'flag', label: 'Flags' },
            { value: 'segment', label: 'Segments' },
            { value: 'layer', label: 'Layers' },
            { value: 'metric', label: 'Metrics' },
            { value: 'holdout', label: 'Holdout' },
            { value: 'ruleset', label: 'Imports' },
          ]}
        />
      }
    >
      <div className="border-b border-line px-4 py-2">
        <Input
          aria-label="Filter by key"
          placeholder="Exact key"
          className="w-64"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setCursors([]);
          }}
        />
      </div>
      <QueryState query={query} empty={entries.length === 0} emptyMessage="No changes recorded.">
        <div className="p-4">
          <HistoryPanel entries={entries} />
        </div>
      </QueryState>
      <div className="flex justify-between border-t border-line px-4 py-2">
        <div className="flex gap-2">
          <Button variant="ghost" disabled={cursors.length === 0} onClick={() => setCursors([])}>
            Newest
          </Button>
          <Button
            variant="ghost"
            disabled={cursors.length === 0}
            onClick={() => setCursors((walked) => walked.slice(0, -1))}
          >
            Newer
          </Button>
        </div>
        <Button
          variant="ghost"
          disabled={next === null}
          onClick={() => next && setCursors((walked) => [...walked, next])}
        >
          Older
        </Button>
      </div>
    </Panel>
  );
}
