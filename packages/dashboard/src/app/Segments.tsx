import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { type AttributeCondition, api, type Segment } from '../client/flags-client';
import { AttributeFields } from './editor-parts';
import { Notice, useEnv, useWrite } from './env';
import { newAttributeCondition } from './flag-model';
import { ErrorBox, Panel, QueryState } from './shell';
import { Badge } from './ui/badge';
import { Button, Field, Input, TextArea } from './ui/form';

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

function cleanSegment(segment: Segment): Segment {
  const out: Segment = {};
  if (segment.included && segment.included.length > 0) out.included = segment.included;
  if (segment.excluded && segment.excluded.length > 0) out.excluded = segment.excluded;
  if (segment.conditions && segment.conditions.length > 0) out.conditions = segment.conditions;
  return out;
}

function SegmentForm({
  segmentKey,
  initial,
  usedBy,
  isNew,
  onDone,
}: {
  segmentKey: string;
  initial: Segment;
  usedBy: string[];
  isNew: boolean;
  onDone?: () => void;
}) {
  const { environment, meta } = useEnv();
  const [key, setKey] = useState(segmentKey);
  const [included, setIncluded] = useState((initial.included ?? []).join('\n'));
  const [excluded, setExcluded] = useState((initial.excluded ?? []).join('\n'));
  const [conditions, setConditions] = useState<AttributeCondition[]>(initial.conditions ?? []);
  const save = useWrite(() =>
    api.saveSegment(
      environment,
      key,
      cleanSegment({ included: lines(included), excluded: lines(excluded), conditions }),
    ),
  );
  const remove = useWrite(() => api.deleteSegment(environment, segmentKey));

  return (
    <div className="space-y-2 border-b border-line px-4 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        {isNew ? (
          <Input
            aria-label="New segment key"
            placeholder="segment key"
            className="mono w-48"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        ) : (
          <span className="mono text-sm text-zinc-100">{segmentKey}</span>
        )}
        {usedBy.length > 0 && (
          <span className="text-[11px] text-zinc-500">
            used by{' '}
            {usedBy.map((flag) => (
              <Badge key={flag}>{flag}</Badge>
            ))}
          </span>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        <Field label="Always included (targeting keys)">
          <TextArea
            aria-label={`${segmentKey || 'new'} included`}
            rows={3}
            value={included}
            onChange={(e) => setIncluded(e.target.value)}
          />
        </Field>
        <Field label="Always excluded (targeting keys)">
          <TextArea
            aria-label={`${segmentKey || 'new'} excluded`}
            rows={3}
            value={excluded}
            onChange={(e) => setExcluded(e.target.value)}
          />
        </Field>
      </div>
      <p className="text-[11px] text-zinc-500">Otherwise, members match all of:</p>
      {conditions.map((condition, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional rows with editable names; a name key would remount the input being typed into.
          key={i}
          className="flex flex-wrap items-center gap-2 rounded-sm border border-line-soft p-2"
        >
          <AttributeFields
            label={`${segmentKey || 'new'} condition ${i + 1}`}
            condition={condition}
            operators={meta?.operators ?? []}
            onChange={(c) => setConditions(conditions.map((x, j) => (j === i ? c : x)))}
          />
          <Button
            variant="ghost"
            onClick={() => setConditions(conditions.filter((_, j) => j !== i))}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setConditions([...conditions, newAttributeCondition()])}>
          Add condition
        </Button>
        <Button
          variant="primary"
          disabled={key === '' || save.isPending}
          onClick={() => save.mutate(undefined, { onSuccess: () => onDone?.() })}
        >
          Save segment
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

/** Reusable audiences referenced from targeting rules. */
export function Segments() {
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['segments', environment],
    queryFn: () => api.segments(environment),
  });
  const [adding, setAdding] = useState(false);
  const segments = query.data?.data ?? [];
  return (
    <Panel
      title="Segments"
      subtitle="Explicit includes and excludes first, then conditions (all must match)."
      actions={<Button onClick={() => setAdding(true)}>New segment</Button>}
    >
      {adding && (
        <SegmentForm segmentKey="" initial={{}} usedBy={[]} isNew onDone={() => setAdding(false)} />
      )}
      <QueryState
        query={query}
        empty={segments.length === 0 && !adding}
        emptyMessage="No segments in this environment."
      >
        {segments.map((s) => (
          <SegmentForm
            key={`${s.key}:${JSON.stringify(s.segment)}`}
            segmentKey={s.key}
            initial={s.segment}
            usedBy={s.usedBy}
            isNew={false}
          />
        ))}
      </QueryState>
    </Panel>
  );
}
