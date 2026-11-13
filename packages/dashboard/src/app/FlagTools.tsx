import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  type AuditEntry,
  api,
  type EvaluationDetails,
  type FlagDefinition,
  type ScheduledChange,
} from '../client/flags-client';
import { localInputToIso, rolloutSteps } from './flag-model';
import { formatValue } from './serving';
import { ErrorBox, formatTime, Table } from './shell';
import { Badge } from './ui/badge';
import { Button, Field, Input, Select, TextArea } from './ui/form';

/**
 * "What would this person get?" — evaluates the DRAFT (unsaved edits included) for a context. The
 * server evaluates with the engine directly, so testing records no exposure.
 */
export function EvaluateTester({
  environment,
  flagKey,
  draft,
}: {
  environment: string;
  flagKey: string;
  draft: FlagDefinition;
}) {
  const [targetingKey, setTargetingKey] = useState('');
  const [attributes, setAttributes] = useState('{}');
  const [parseError, setParseError] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (context: Record<string, unknown>) =>
      api.evaluate(environment, { flag: flagKey, context, definition: draft }),
  });
  const result: EvaluationDetails | undefined = run.data?.result;

  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(attributes === '' ? '{}' : attributes);
    } catch {
      setParseError('Attributes must be a JSON object.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setParseError('Attributes must be a JSON object.');
      return;
    }
    setParseError(null);
    run.mutate({
      ...(parsed as Record<string, unknown>),
      ...(targetingKey ? { targetingKey } : {}),
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Targeting key">
          <Input
            aria-label="Targeting key"
            className="mono w-48"
            placeholder="user id"
            value={targetingKey}
            onChange={(e) => setTargetingKey(e.target.value)}
          />
        </Field>
        <Field label="Attributes (JSON)" className="min-w-0 flex-1">
          <TextArea
            aria-label="Attributes"
            rows={2}
            value={attributes}
            onChange={(e) => setAttributes(e.target.value)}
          />
        </Field>
        <Button variant="primary" onClick={submit} disabled={run.isPending}>
          Evaluate
        </Button>
      </div>
      {parseError !== null && <p className="text-xs text-bad">{parseError}</p>}
      {run.isError && <ErrorBox error={run.error} />}
      {result && (
        <dl className="mono grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-line-soft p-2 text-[11px]">
          <dt className="text-dim">value</dt>
          <dd className="text-fg" data-testid="evaluated-value">
            {formatValue(result.value)}
          </dd>
          <dt className="text-dim">variant</dt>
          <dd>{result.variant ?? '—'}</dd>
          <dt className="text-dim">reason</dt>
          <dd>{result.reason}</dd>
          {result.flagMetadata.ruleId !== undefined && (
            <>
              <dt className="text-dim">rule</dt>
              <dd>{String(result.flagMetadata.ruleId)}</dd>
            </>
          )}
          {result.errorCode && (
            <>
              <dt className="text-dim">error</dt>
              <dd className="text-bad">
                {result.errorCode} {result.errorMessage}
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}

const STEP_PRESET = [10, 25, 50, 100];

/** Scheduled changes for this flag, plus forms for one change or a gradual rollout. */
export function SchedulesPanel({
  environment,
  flagKey,
  schedules,
  onOff,
}: {
  environment: string;
  flagKey: string;
  schedules: ScheduledChange[];
  /** Rollouts only make sense for on/off flags. */
  onOff: boolean;
}) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries();
  const [kind, setKind] = useState<'enable' | 'disable' | 'rollout'>('enable');
  const [runAt, setRunAt] = useState('');
  const [percent, setPercent] = useState(50);
  const [start, setStart] = useState('');
  const [every, setEvery] = useState(24);
  const [steps, setSteps] = useState(STEP_PRESET.join(', '));

  const one = useMutation({
    mutationFn: () => {
      const iso = localInputToIso(runAt);
      if (!iso) throw new Error('Pick when the change should run.');
      return api.schedule(environment, flagKey, {
        kind,
        runAt: iso,
        ...(kind === 'rollout' ? { percent } : {}),
      });
    },
    onSuccess: refresh,
  });
  const gradual = useMutation({
    mutationFn: () => {
      const iso = localInputToIso(start);
      if (!iso) throw new Error('Pick when the rollout starts.');
      const percents = steps
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n));
      if (percents.length === 0) throw new Error('List the percentages, e.g. 10, 25, 50, 100.');
      return api.schedule(environment, flagKey, {
        steps: rolloutSteps(new Date(iso), percents, every),
      });
    },
    onSuccess: refresh,
  });
  const cancel = useMutation({ mutationFn: api.cancelSchedule, onSuccess: refresh });

  return (
    <div className="space-y-3">
      {schedules.length === 0 ? (
        <p className="text-[11px] text-dim">Nothing scheduled.</p>
      ) : (
        <Table head={['When', 'Change', 'Status', 'By', '']}>
          {schedules.map((s) => (
            <tr key={s.id}>
              <td className="px-4 py-1.5 mono">{formatTime(s.runAt)}</td>
              <td className="px-4 py-1.5">
                {s.kind === 'rollout' ? `rollout to ${s.payload.percent}%` : s.kind}
              </td>
              <td className={`px-4 py-1.5 s-${s.status}`}>
                {s.status}
                {s.error && <span className="block text-[10px] text-bad">{s.error}</span>}
              </td>
              <td className="px-4 py-1.5 text-dim">{s.createdBy.name ?? s.createdBy.id}</td>
              <td className="px-4 py-1.5 text-right">
                {s.status === 'pending' && (
                  <Button variant="ghost" onClick={() => cancel.mutate(s.id)}>
                    Cancel
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Change">
          <Select
            aria-label="Scheduled change"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="enable">Enable</option>
            <option value="disable">Disable (kill switch)</option>
            {onOff && <option value="rollout">Roll out to %</option>}
          </Select>
        </Field>
        {kind === 'rollout' && (
          <Field label="Percent">
            <Input
              aria-label="Scheduled percent"
              type="number"
              min={0}
              max={100}
              className="w-20"
              value={percent}
              onChange={(e) => setPercent(Number(e.target.value))}
            />
          </Field>
        )}
        <Field label="At">
          <Input
            aria-label="Run at"
            type="datetime-local"
            value={runAt}
            onChange={(e) => setRunAt(e.target.value)}
          />
        </Field>
        <Button onClick={() => one.mutate()} disabled={one.isPending}>
          Schedule
        </Button>
      </div>
      {onOff && (
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Gradual rollout from">
            <Input
              aria-label="Rollout start"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </Field>
          <Field label="Every (hours)">
            <Input
              aria-label="Hours between steps"
              type="number"
              min={1}
              className="w-20"
              value={every}
              onChange={(e) => setEvery(Number(e.target.value))}
            />
          </Field>
          <Field label="Steps (%)">
            <Input
              aria-label="Rollout steps"
              className="mono w-40"
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
            />
          </Field>
          <Button onClick={() => gradual.mutate()} disabled={gradual.isPending}>
            Schedule rollout
          </Button>
        </div>
      )}
      {one.isError && <ErrorBox error={one.error} />}
      {gradual.isError && <ErrorBox error={gradual.error} />}
      {cancel.isError && <ErrorBox error={cancel.error} />}
    </div>
  );
}

/** The flag's audit trail, newest first, with the before/after of each change. */
export function HistoryPanel({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-[11px] text-dim">No changes recorded in this environment yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {entries.map((entry) => (
        <li key={entry.id} className="rounded-md border border-line-soft">
          <details>
            <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
              <span className="mono text-dim">{formatTime(entry.at)}</span>
              <Badge>{entry.action}</Badge>
              <span className="text-fg-2">{entry.actor.name ?? entry.actor.id}</span>
              <span className="mono text-[10px] text-faint">v{entry.version}</span>
              {entry.changeRequestId && <Badge variant="type">approved request</Badge>}
            </summary>
            <div className="grid gap-2 border-t border-line-soft p-2 md:grid-cols-2">
              <pre className="mono overflow-x-auto text-[10px] text-dim">
                {JSON.stringify(entry.before, null, 2)}
              </pre>
              <pre className="mono overflow-x-auto text-[10px] text-fg-2">
                {JSON.stringify(entry.after, null, 2)}
              </pre>
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}
