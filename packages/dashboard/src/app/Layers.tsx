import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Layer } from '../client/flags-client';
import { Notice, useEnv, useWrite } from './env';
import { ErrorBox, Panel, QueryState } from './shell';
import { Button, Field, Input, Select } from './ui/form';

const BUCKETS = 10_000;

/** A layer's allocations as a bar: who owns which slice of the 0…10000 buckets. */
export function AllocationBar({ allocations }: { allocations: Layer['allocations'] }) {
  return (
    <div
      className="relative h-3 w-full overflow-hidden rounded-md border border-line bg-panel-2"
      aria-hidden="true"
    >
      {Object.entries(allocations).map(([flag, [start, end]], i) => (
        <span
          key={flag}
          title={`${flag}: ${start}–${end}`}
          className="absolute top-0 h-full border-r border-background"
          style={{
            left: `${(start / BUCKETS) * 100}%`,
            width: `${(Math.max(0, end - start) / BUCKETS) * 100}%`,
            background: `color-mix(in srgb, var(--accent) ${40 + ((i * 23) % 50)}%, transparent)`,
          }}
        />
      ))}
    </div>
  );
}

function LayerForm({
  layerKey,
  initial,
  experiments,
  isNew,
  onDone,
}: {
  layerKey: string;
  initial: Layer;
  /** Experiment flags that name this layer (only they may hold a range). */
  experiments: string[];
  isNew: boolean;
  onDone?: () => void;
}) {
  const { environment } = useEnv();
  const [key, setKey] = useState(layerKey);
  const [rows, setRows] = useState(
    Object.entries(initial.allocations).map(([flag, [start, end]]) => ({ flag, start, end })),
  );
  const allocations = Object.fromEntries(
    rows.map((r) => [r.flag, [r.start, r.end] as [number, number]]),
  );
  const save = useWrite(() =>
    api.saveLayer(environment, key, {
      ...(initial.salt ? { salt: initial.salt } : {}),
      allocations,
    }),
  );
  const remove = useWrite(() => api.deleteLayer(environment, layerKey));
  const free = experiments.filter((f) => !rows.some((r) => r.flag === f));

  return (
    <div className="space-y-2 border-b border-line px-4 py-3 last:border-b-0">
      {isNew ? (
        <Input
          aria-label="New layer key"
          placeholder="layer key"
          className="mono w-48"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      ) : (
        <span className="mono text-sm text-fg">{layerKey}</span>
      )}
      <AllocationBar allocations={allocations} />
      {rows.map((row, i) => (
        <div key={row.flag} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="mono w-40 text-fg-2">{row.flag}</span>
          <Input
            aria-label={`${row.flag} start`}
            type="number"
            min={0}
            max={BUCKETS}
            className="w-24"
            value={row.start}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, start: Number(e.target.value) } : r)))
            }
          />
          <span className="text-faint">to</span>
          <Input
            aria-label={`${row.flag} end`}
            type="number"
            min={0}
            max={BUCKETS}
            className="w-24"
            value={row.end}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, end: Number(e.target.value) } : r)))
            }
          />
          <span className="mono text-[11px] text-dim">
            {((row.end - row.start) / 100).toFixed(2)}%
          </span>
          <Button variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        {free.length > 0 && (
          <Select
            aria-label={`Add an experiment to ${layerKey || 'the new layer'}`}
            value=""
            onChange={(e) => {
              const used = rows.reduce((max, r) => Math.max(max, r.end), 0);
              setRows([
                ...rows,
                { flag: e.target.value, start: used, end: Math.min(BUCKETS, used + 1000) },
              ]);
            }}
          >
            <option value="">Add experiment…</option>
            {free.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        )}
        <Button
          variant="primary"
          disabled={key === '' || save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: () => onDone?.() })}
        >
          Save layer
        </Button>
        {!isNew && (
          <Button
            variant="danger"
            disabled={remove.isPending}
            onClick={() => remove.mutate(undefined)}
          >
            Delete
          </Button>
        )}
      </div>
      {save.isError && <ErrorBox error={save.error} />}
      {remove.isError && <ErrorBox error={remove.error} />}
      <Notice text={save.notice ?? remove.notice} />
    </div>
  );
}

function HoldoutForm({ percent }: { percent: number | null }) {
  const { environment } = useEnv();
  const [value, setValue] = useState(percent ?? 0);
  const save = useWrite((holdout: { percent: number } | null) =>
    api.saveHoldout(environment, holdout),
  );
  return (
    <div className="flex flex-wrap items-end gap-2 px-4 py-3">
      <Field
        label="Held out (% of subjects)"
        hint="No experiment reaches them; the summed effect of everything shipped is measured against them."
      >
        <Input
          aria-label="Holdout percent"
          type="number"
          min={0}
          max={100}
          step={0.1}
          className="w-24"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
        />
      </Field>
      <Button
        variant="primary"
        disabled={save.isPending}
        onClick={() => save.mutate({ percent: value })}
      >
        Save holdout
      </Button>
      {percent !== null && (
        <Button variant="danger" disabled={save.isPending} onClick={() => save.mutate(null)}>
          Remove holdout
        </Button>
      )}
      {save.isError && <ErrorBox error={save.error} />}
      <Notice text={save.notice} />
    </div>
  );
}

/** Mutual-exclusion layers (with their bucket ranges) and the global holdout. */
export function Layers() {
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['layers', environment],
    queryFn: () => api.layers(environment),
  });
  const [adding, setAdding] = useState(false);
  const data = query.data;
  const inLayer = (layer: string) =>
    (data?.experiments ?? []).filter((e) => e.layer === layer).map((e) => e.flag);

  return (
    <div className="space-y-4">
      <Panel
        title="All layers"
        subtitle="Experiments in one layer never share a subject: each owns a range of the layer's 10,000 buckets. Set an experiment's layer in its flag editor first."
        actions={<Button onClick={() => setAdding(true)}>New layer</Button>}
      >
        {adding && (
          <LayerForm
            layerKey=""
            initial={{ allocations: {} }}
            experiments={[]}
            isNew
            onDone={() => setAdding(false)}
          />
        )}
        <QueryState
          query={query}
          empty={(data?.data.length ?? 0) === 0 && !adding}
          emptyMessage="No layers in this environment."
        >
          {data?.data.map((l) => (
            <LayerForm
              key={`${l.key}:${JSON.stringify(l.layer)}`}
              layerKey={l.key}
              initial={l.layer}
              experiments={inLayer(l.key)}
              isNew={false}
            />
          ))}
        </QueryState>
      </Panel>
      <Panel title="Global holdout">
        <QueryState query={query} empty={false}>
          <HoldoutForm
            key={String(data?.holdout?.percent ?? 'none')}
            percent={data?.holdout?.percent ?? null}
          />
          <ul className="border-t border-line px-4 py-2 text-[11px] text-dim">
            {(data?.experiments ?? []).map((e) => (
              <li key={e.flag}>
                <span className="mono text-fg-2">{e.flag}</span>{' '}
                {e.holdout ? 'honours the holdout' : 'opted out of the holdout'}
                {e.layer ? ` · layer ${e.layer}` : ''}
              </li>
            ))}
          </ul>
        </QueryState>
      </Panel>
    </div>
  );
}
