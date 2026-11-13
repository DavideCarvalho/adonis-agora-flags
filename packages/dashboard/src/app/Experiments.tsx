import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { api, type ExperimentResults, type MetricResult } from '../client/flags-client';
import { useEnv } from './env';
import { formatMean, formatP, formatPercent } from './serving';
import { ErrorBox, formatTime, Panel, QueryState, Table } from './shell';
import { Badge } from './ui/badge';
import { Button } from './ui/form';

/** Every experiment: configured ones with their last numbers, and flagged-but-unanalysed ones. */
export function Experiments({ onOpen }: { onOpen: (key: string) => void }) {
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['experiments', environment],
    queryFn: () => api.experiments(environment),
  });
  const rows = query.data?.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      {query.data ? (
        <ExperimentMetrics rows={rows} />
      ) : query.isPending ? (
        <MetricGridSkeleton count={4} />
      ) : null}
      <Panel
        title="All experiments"
        subtitle={
          query.data && !query.data.analytics
            ? 'No analytics backend is configured: results cannot be computed.'
            : 'Results are recomputed by the flags worker; open one to recompute now.'
        }
      >
        <QueryState
          query={query}
          empty={rows.length === 0}
          emptyMessage="No experiments. Mark a flag as an experiment and pick its metrics in the flag editor."
        >
          <Table head={['Experiment', 'Flag', 'Exposures', 'Verdicts', 'Computed', '']}>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="px-4 py-2">
                  {row.configured ? (
                    <button
                      type="button"
                      className="mono text-fg hover:text-brand"
                      onClick={() => onOpen(row.key)}
                    >
                      {row.key}
                    </button>
                  ) : (
                    <span className="mono text-fg-2">{row.key}</span>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {!row.configured && <Badge variant="danger">no metrics configured</Badge>}
                    {row.source === 'config' && <Badge>config</Badge>}
                    {row.running ? <Badge variant="type">running</Badge> : <Badge>stopped</Badge>}
                    {row.srmMismatch && <Badge variant="danger">SRM</Badge>}
                    {row.alert && <Badge variant="danger">guardrail</Badge>}
                  </div>
                </td>
                <td className="mono px-4 py-2 text-dim">{row.flag}</td>
                <td className="mono px-4 py-2 tnum">{row.exposures ?? '—'}</td>
                <td className="px-4 py-2">
                  {row.verdicts.length === 0
                    ? '—'
                    : row.verdicts.map((v) => (
                        <span key={`${v.metric}:${v.variant}`} className={`mr-2 s-${v.verdict}`}>
                          {v.metric}/{v.variant}: {v.verdict}
                        </span>
                      ))}
                </td>
                <td className="mono px-4 py-2 text-dim">{formatTime(row.computedAt)}</td>
                <td className="px-4 py-2 text-right">
                  {row.configured && (
                    <button
                      type="button"
                      className="text-brand hover:underline"
                      onClick={() => onOpen(row.key)}
                    >
                      Results
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </Table>
        </QueryState>
      </Panel>
    </div>
  );
}

type ExperimentRow = NonNullable<Awaited<ReturnType<typeof api.experiments>>>['data'][number];

/** The metric row over the experiments list. Pure. */
export function ExperimentMetrics({ rows }: { rows: ExperimentRow[] }) {
  const running = rows.filter((r) => r.running).length;
  const alerts = rows.filter((r) => r.srmMismatch || r.alert).length;
  const exposures = rows.reduce((sum, r) => sum + (r.exposures ?? 0), 0);
  const unconfigured = rows.filter((r) => !r.configured).length;
  return (
    <MetricGrid>
      <MetricCard
        label="Experiments"
        value={rows.length}
        caption={unconfigured > 0 ? `${unconfigured} without metrics` : 'all analysed'}
      />
      <MetricCard label="Running" value={running} tone="brand" caption="enabled with variants" />
      <MetricCard
        label="Alerts"
        value={alerts}
        tone={alerts > 0 ? 'bad' : 'default'}
        caption="SRM or guardrail"
      />
      <MetricCard
        label="Exposures"
        value={exposures.toLocaleString('en-US')}
        tone="violet"
        caption="last computed"
      />
    </MetricGrid>
  );
}

function MetricTable({ metric, control }: { metric: MetricResult; control: string }) {
  const byVariant = new Map(metric.comparisons.map((c) => [c.variant, c]));
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 px-4 pt-3">
        <h3 className="text-xs text-fg">{metric.name}</h3>
        <Badge>{metric.kind}</Badge>
        <span className="text-[11px] text-dim">
          on <span className="mono">{metric.event}</span> ·{' '}
          {metric.direction === 'increase' ? 'higher is better' : 'lower is better'}
        </span>
        {metric.guardrail && <Badge variant="type">guardrail</Badge>}
        {metric.alert && (
          <Badge variant="danger" role="alert">
            guardrail regressed
          </Badge>
        )}
      </div>
      <Table
        head={[
          'Variant',
          'Subjects',
          'Mean',
          'Lift',
          'CI (difference)',
          'p-value',
          'Sequential p',
          'Verdict',
        ]}
      >
        {metric.variants.map((v) => {
          const c = byVariant.get(v.variant);
          const isControl = v.variant === control;
          return (
            <tr key={v.variant}>
              <td className="mono px-4 py-1.5">
                {v.variant}
                {isControl && <span className="ml-1 text-[10px] text-dim">control</span>}
              </td>
              <td className="mono px-4 py-1.5 tnum">{v.n}</td>
              <td className="mono px-4 py-1.5 tnum">{formatMean(metric.kind, v.mean)}</td>
              <td className="mono px-4 py-1.5 tnum">{c ? formatPercent(c.relativeLift) : '—'}</td>
              <td className="mono px-4 py-1.5 tnum text-dim">
                {c ? `[${c.interval[0].toPrecision(3)}, ${c.interval[1].toPrecision(3)}]` : '—'}
              </td>
              <td className="mono px-4 py-1.5 tnum">{c ? formatP(c.pValue) : '—'}</td>
              <td className="mono px-4 py-1.5 tnum">{c ? formatP(c.sequential.pValue) : '—'}</td>
              <td className={`px-4 py-1.5 ${c ? `s-${c.verdict}` : ''}`}>
                {c ? c.verdict : isControl ? 'baseline' : 'not enough data'}
                {c?.test === 'cuped' && c.varianceReduction !== undefined && (
                  <span className="block text-[10px] text-dim">
                    CUPED −{(c.varianceReduction * 100).toFixed(0)}% variance
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}

/** The numbers for one experiment. */
export function ResultsView({ results }: { results: ExperimentResults }) {
  const total = Object.values(results.exposures).reduce((a, b) => a + b, 0);
  return (
    <>
      <div className="flex flex-wrap gap-x-6 gap-y-1 border-b border-line px-4 py-2 text-[11px] text-dim">
        <span>
          control <span className="mono text-fg-2">{results.control}</span>
        </span>
        <span>
          exposures <span className="mono text-fg-2">{total}</span>
        </span>
        {Object.entries(results.exposures).map(([variant, n]) => (
          <span key={variant}>
            <span className="mono text-fg-2">{variant}</span> {n}
          </span>
        ))}
        <span>computed {formatTime(results.computedAt)}</span>
      </div>
      {results.srm?.mismatch && (
        <div role="alert" className="border-b border-bad/40 bg-bad/10 px-4 py-2 text-xs text-bad">
          Sample ratio mismatch (p = {formatP(results.srm.pValue)}): exposures do not match the
          configured split. Something is assigning or recording unevenly — do not trust the
          comparisons below until it is explained.
        </div>
      )}
      {total === 0 ? (
        <p className="px-4 py-6 text-sm text-dim">
          No exposures in{' '}
          <span className="mono text-fg-2">{results.environment ?? 'this environment'}</span> yet.
          Subjects are counted once the code reads this experiment's variant here.
        </p>
      ) : (
        results.metrics.map((metric) => (
          <MetricTable key={metric.name} metric={metric} control={results.control} />
        ))
      )}
      {results.warnings.length > 0 && (
        <ul className="border-t border-line px-4 py-2 text-[11px] text-warn">
          {results.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ExperimentDetail({
  experimentKey,
  onClose,
}: {
  experimentKey: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { environment } = useEnv();
  const query = useQuery({
    queryKey: ['experiment', experimentKey, environment],
    queryFn: () => api.experiment(experimentKey, environment),
  });
  const recompute = useMutation({
    mutationFn: () => api.recompute(experimentKey, environment),
    onSuccess: (data) => {
      client.setQueryData(['experiment', experimentKey, environment], (old: unknown) =>
        old && typeof old === 'object' ? { ...old, results: data.results } : old,
      );
      void client.invalidateQueries({ queryKey: ['experiments'] });
    },
  });
  const detail = query.data;
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onClose}>
        ← All experiments
      </Button>
      <Panel
        title={experimentKey}
        subtitle={
          detail
            ? `flag ${detail.flag} · metrics ${detail.config.metrics.join(', ')}${detail.config.guardrails?.length ? ` · guardrails ${detail.config.guardrails.join(', ')}` : ''}`
            : undefined
        }
        actions={
          <Button
            variant="primary"
            disabled={recompute.isPending || detail?.analytics === false}
            onClick={() => recompute.mutate()}
          >
            {recompute.isPending ? 'Computing…' : 'Recompute now'}
          </Button>
        }
      >
        {recompute.isError && <ErrorBox error={recompute.error} />}
        <QueryState query={query} empty={false}>
          {detail?.results ? (
            <ResultsView results={detail.results} />
          ) : (
            <p className="p-4 text-sm text-dim">
              {detail?.analytics === false
                ? 'No analytics backend is configured, so there are no results.'
                : 'Not computed yet. The worker computes results periodically, or press Recompute now.'}
            </p>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}
