import { useQuery } from '@tanstack/react-query';
import { Skeleton } from '../agora-kit/ui/skeleton';
import { api } from '../client/flags-client';
import { formatTime, Panel, QueryState, Table } from './shell';
import { Badge } from './ui/badge';

/** One figure of the ops screen: CAPS label, mono value (the kit's metric-card look, compact). */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'bad' | 'warn';
}) {
  return (
    <div className="rounded-lg border border-border bg-sunken/20 px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{label}</p>
      <p
        className={`mono mt-1.5 truncate text-[15px] font-semibold tnum ${tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-fg'}`}
      >
        {value}
      </p>
    </div>
  );
}

/** Is the machinery healthy: where the ruleset comes from, and whether events reach every sink. */
export function Ops() {
  const query = useQuery({ queryKey: ['ops'], queryFn: api.ops });
  const ops = query.data;
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Ruleset source"
        subtitle={
          ops
            ? `${ops.app} · ${ops.topology} · role ${ops.role} · evaluates ${ops.environment}`
            : undefined
        }
      >
        <QueryState query={query} empty={false} skeleton={<StatsSkeleton />}>
          {ops && (
            <div className="grid gap-2 p-4 sm:grid-cols-4">
              <Stat label="Version" value={ops.source.version} />
              <Stat label="Mode" value={ops.source.mode} />
              <Stat label="Loaded" value={formatTime(ops.source.loadedAt)} />
              <Stat
                label="Last error"
                value={ops.source.lastError ?? 'none'}
                {...(ops.source.lastError
                  ? { tone: ops.source.stale ? ('bad' as const) : ('warn' as const) }
                  : {})}
              />
            </div>
          )}
          {ops?.source.stale && (
            <p role="alert" className="border-t border-bad/25 bg-bad/5 px-4 py-2 text-xs text-bad">
              Serving the last ruleset that loaded: reloading is failing, so edits made since will
              not reach this process.
            </p>
          )}
        </QueryState>
      </Panel>

      <Panel
        title="Events"
        subtitle="Exposures and tracked events: buffered in process, published to the transport, relayed to each sink."
      >
        <QueryState query={query} empty={false} skeleton={<StatsSkeleton />}>
          {ops && (
            <>
              <div className="grid gap-2 p-4 sm:grid-cols-4">
                <Stat
                  label="Transport"
                  value={
                    ops.transport
                      ? `${ops.transport.name}${ops.transport.durable ? '' : ' (not durable)'}${ops.transport.transactional ? ' · transactional' : ''}`
                      : 'none'
                  }
                  {...(ops.transport && !ops.transport.durable ? { tone: 'warn' as const } : {})}
                />
                <Stat label="Buffered" value={ops.buffer?.pending ?? '—'} />
                <Stat label="Published" value={ops.buffer?.published ?? '—'} />
                <Stat
                  label="Dropped"
                  value={ops.buffer?.dropped ?? '—'}
                  {...((ops.buffer?.dropped ?? 0) > 0 ? { tone: 'bad' as const } : {})}
                />
              </div>
              <div className="flex flex-wrap gap-1 px-4 pb-3">
                {ops.delivery === 'transport' ? (
                  <Badge variant="type">{`delivered by ${ops.transport?.name ?? 'transport'} jobs`}</Badge>
                ) : (
                  <Badge variant={ops.relay ? 'type' : 'danger'}>
                    {ops.relay ? 'relay configured' : 'no relay'}
                  </Badge>
                )}
                <Badge variant={ops.worker ? 'type' : 'outline'}>
                  {ops.worker ? 'worker available' : 'no worker'}
                </Badge>
                <Badge variant={ops.analytics ? 'type' : 'outline'}>
                  {ops.analytics ? 'analytics backend' : 'no analytics'}
                </Badge>
              </div>
              {ops.delivery === 'transport' && (
                <p className="px-4 pb-2 text-xs text-dim">
                  This transport keeps no per-sink log: pending, retried and failed batches are in
                  your queue.
                </p>
              )}
              {ops.sinkError && (
                <p className="px-4 pb-2 text-xs text-bad">
                  Sink status unavailable: {ops.sinkError}
                </p>
              )}
              {ops.sinks.length === 0 ? (
                <p className="border-t border-line p-4 text-sm text-dim">No sinks configured.</p>
              ) : (
                <Table head={['Sink', 'Lag', 'Delivered', 'Leased by', 'Last error']}>
                  {ops.sinks.map((sink) => (
                    <tr key={sink.sink}>
                      <td className="mono px-4 py-2">{sink.sink}</td>
                      <td
                        className={`mono px-4 py-2 tnum ${(sink.lag ?? 0) > 0 ? 'text-warn' : ''}`}
                      >
                        {sink.lag ?? '—'}
                      </td>
                      <td className="mono px-4 py-2 tnum">{sink.delivered ?? '—'}</td>
                      <td className="mono px-4 py-2 text-dim">{sink.leasedBy ?? '—'}</td>
                      <td className="px-4 py-2 text-bad">{sink.lastError ?? ''}</td>
                    </tr>
                  ))}
                </Table>
              )}
            </>
          )}
        </QueryState>
      </Panel>

      {ops && ops.topology === 'control-plane' && (
        <Panel
          title="Tenants"
          subtitle="Apps that evaluate this control-plane's ruleset. Version and capabilities are what this replica saw; the rest comes from the declarations every tenant publishes."
        >
          {ops.tenants.length === 0 ? (
            <p className="p-4 text-sm text-dim">No tenant has called in yet.</p>
          ) : (
            <Table
              head={['Partition', 'Environment', 'Ruleset version', 'Last seen', 'Capabilities']}
            >
              {ops.tenants.map((t) => (
                <tr key={t.partition}>
                  <td className="mono px-4 py-2">{t.partition}</td>
                  <td className="px-4 py-2">{t.environment ?? '—'}</td>
                  <td className="mono px-4 py-2">{t.lastRulesetVersion ?? '—'}</td>
                  <td className="mono px-4 py-2">
                    {t.lastSeenAt ? formatTime(t.lastSeenAt) : '—'}
                  </td>
                  <td className="px-4 py-2 text-dim">{t.capabilities.join(', ') || '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      )}
    </div>
  );
}

function StatsSkeleton() {
  return (
    <div className="grid gap-2 p-4 sm:grid-cols-4" aria-hidden>
      {['a', 'b', 'c', 'd'].map((key) => (
        <div key={key} className="rounded-lg border border-border px-3.5 py-3">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="mt-2 h-4 w-20" />
        </div>
      ))}
    </div>
  );
}
