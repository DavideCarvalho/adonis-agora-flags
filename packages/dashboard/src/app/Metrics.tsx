import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type DefinitionSource, type MetricDefinition } from '../client/flags-client';
import { Notice, useEnv, useWrite } from './env';
import { ErrorBox, Panel, QueryState } from './shell';
import { Badge } from './ui/badge';
import { Button, Field, Input, Select } from './ui/form';

const DAY_MS = 86_400_000;

const KINDS: Array<{ value: MetricDefinition['kind']; label: string }> = [
  { value: 'conversion', label: 'Conversion — share of subjects who did the event' },
  { value: 'count', label: 'Count — times per subject' },
  { value: 'sum', label: 'Sum — total of the events’ value per subject' },
];

const days = (ms: number | undefined) => (ms === undefined ? '' : String(ms / DAY_MS));
const msOf = (text: string) => (text.trim() === '' ? undefined : Number(text) * DAY_MS);

/** Builds the metric the form describes, leaving out what was left blank. */
export function metricOf(fields: {
  kind: MetricDefinition['kind'];
  event: string;
  description: string;
  direction: 'increase' | 'decrease';
  windowDays: string;
  cupedDays: string;
}): MetricDefinition {
  const out: MetricDefinition = { kind: fields.kind, event: fields.event.trim() };
  if (fields.description.trim() !== '') out.description = fields.description.trim();
  if (fields.direction === 'decrease') out.direction = 'decrease';
  const windowMs = msOf(fields.windowDays);
  if (windowMs !== undefined) out.windowMs = windowMs;
  const cupedMs = msOf(fields.cupedDays);
  if (cupedMs !== undefined && cupedMs > 0) out.cupedMs = cupedMs;
  return out;
}

function describe(metric: MetricDefinition): string {
  const parts = [`${metric.kind} of "${metric.event}"`];
  parts.push(metric.direction === 'decrease' ? 'lower is better' : 'higher is better');
  if (metric.windowMs !== undefined) parts.push(`within ${days(metric.windowMs)}d of exposure`);
  if (metric.cupedMs !== undefined) parts.push(`CUPED over ${days(metric.cupedMs)}d`);
  return parts.join(' · ');
}

function UsedBy({ usedBy }: { usedBy: string[] }) {
  if (usedBy.length === 0) return null;
  return (
    <span className="text-[11px] text-dim">
      used by{' '}
      {usedBy.map((key) => (
        <Badge key={key}>{key}</Badge>
      ))}
    </span>
  );
}

function MetricForm({
  metricKey,
  initial,
  usedBy,
  isNew,
  onDone,
}: {
  metricKey: string;
  initial: MetricDefinition;
  usedBy: string[];
  isNew: boolean;
  onDone?: () => void;
}) {
  const { environment } = useEnv();
  const [key, setKey] = useState(metricKey);
  const [kind, setKind] = useState(initial.kind);
  const [event, setEvent] = useState(initial.event);
  const [description, setDescription] = useState(initial.description ?? '');
  const [direction, setDirection] = useState(initial.direction ?? 'increase');
  const [windowDays, setWindowDays] = useState(days(initial.windowMs));
  const [cupedDays, setCupedDays] = useState(days(initial.cupedMs));
  const label = metricKey || 'new metric';
  const save = useWrite(() =>
    api.saveMetric(
      environment,
      key,
      metricOf({ kind, event, description, direction, windowDays, cupedDays }),
    ),
  );
  const remove = useWrite(() => api.deleteMetric(environment, metricKey));

  return (
    <div className="space-y-2 border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        {isNew ? (
          <Input
            aria-label="New metric name"
            placeholder="metric name"
            className="mono w-48"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        ) : (
          <span className="mono text-sm text-fg">{metricKey}</span>
        )}
        <UsedBy usedBy={usedBy} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Kind">
          <Select
            aria-label={`${label} kind`}
            value={kind}
            onChange={(e) => setKind(e.target.value as MetricDefinition['kind'])}
          >
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Event" hint="The name passed to track()">
          <Input
            aria-label={`${label} event`}
            className="mono w-44"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
          />
        </Field>
        <Field label="Better when it">
          <Select
            aria-label={`${label} direction`}
            value={direction}
            onChange={(e) => setDirection(e.target.value as 'increase' | 'decrease')}
          >
            <option value="increase">increases</option>
            <option value="decrease">decreases</option>
          </Select>
        </Field>
        <Field label="Window (days)" hint="After exposure; blank = no limit">
          <Input
            aria-label={`${label} window`}
            type="number"
            min={0}
            step="any"
            className="w-24"
            value={windowDays}
            onChange={(e) => setWindowDays(e.target.value)}
          />
        </Field>
        <Field label="CUPED (days)" hint="Pre-exposure history; blank = off">
          <Input
            aria-label={`${label} cuped`}
            type="number"
            min={0}
            step="any"
            className="w-24"
            value={cupedDays}
            onChange={(e) => setCupedDays(e.target.value)}
          />
        </Field>
        <Field label="Description" className="min-w-48 flex-1">
          <Input
            aria-label={`${label} description`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          disabled={key === '' || event.trim() === '' || save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: () => onDone?.() })}
        >
          Save metric
        </Button>
        {isNew && onDone && (
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        )}
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

function ConfigMetric({
  name,
  metric,
  usedBy,
}: {
  name: string;
  metric: MetricDefinition;
  usedBy: string[];
}) {
  return (
    <div className="space-y-1 border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono text-sm text-fg">{name}</span>
        <Badge>config</Badge>
        <UsedBy usedBy={usedBy} />
      </div>
      <p className="text-[11px] text-dim">{describe(metric)}</p>
      {metric.description && <p className="text-[11px] text-dim">{metric.description}</p>}
    </div>
  );
}

/** What experiments measure: tracked events aggregated per subject. */
export function Metrics() {
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['metrics', environment],
    queryFn: () => api.metrics(environment),
  });
  const [adding, setAdding] = useState(false);
  const metrics = query.data?.data ?? [];
  const bySource = (source: DefinitionSource) => metrics.filter((m) => m.source === source);
  return (
    <Panel
      title="All metrics"
      subtitle="What experiments measure, from events sent with track(). Pick them per experiment in the flag editor. Metrics from config/flags.ts are read-only here."
      actions={<Button onClick={() => setAdding(true)}>New metric</Button>}
    >
      {adding && (
        <MetricForm
          metricKey=""
          initial={{ kind: 'conversion', event: '' }}
          usedBy={[]}
          isNew
          onDone={() => setAdding(false)}
        />
      )}
      <QueryState
        query={query}
        empty={metrics.length === 0 && !adding}
        emptyMessage="No metrics in this environment."
      >
        {bySource('console').map((m) => (
          <MetricForm
            key={`${m.name}:${JSON.stringify(m.metric)}`}
            metricKey={m.name}
            initial={m.metric}
            usedBy={m.usedBy}
            isNew={false}
          />
        ))}
        {bySource('config').map((m) => (
          <ConfigMetric key={m.name} name={m.name} metric={m.metric} usedBy={m.usedBy} />
        ))}
      </QueryState>
    </Panel>
  );
}
