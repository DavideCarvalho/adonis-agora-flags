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
  const [before, setBefore] = useState<string | undefined>(undefined);
  const query = useQuery({
    queryKey: ['audit', environment, entity, key, before],
    queryFn: () =>
      api.audit(environment, {
        ...(entity !== '' ? { entity } : {}),
        ...(key !== '' ? { key } : {}),
        ...(before ? { before } : {}),
      }),
  });
  const entries = query.data?.entries ?? [];
  const last = entries[entries.length - 1];
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
            setBefore(undefined);
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
            setBefore(undefined);
          }}
        />
      </div>
      <QueryState query={query} empty={entries.length === 0} emptyMessage="No changes recorded.">
        <div className="p-4">
          <HistoryPanel entries={entries} />
        </div>
      </QueryState>
      <div className="flex justify-between border-t border-line px-4 py-2">
        <Button variant="ghost" disabled={!before} onClick={() => setBefore(undefined)}>
          Newest
        </Button>
        <Button
          variant="ghost"
          disabled={!last || entries.length < (query.data?.limit ?? 50)}
          onClick={() => last && setBefore(last.at)}
        >
          Older
        </Button>
      </div>
    </Panel>
  );
}
