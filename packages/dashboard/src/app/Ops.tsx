import { useQuery } from '@tanstack/react-query';
import { api } from '../client/flags-client';
import { formatTime, Panel, QueryState, Table } from './shell';
import { Badge } from './ui/badge';

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
    <div className="rounded-sm border border-line px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p
        className={`mono mt-1 text-sm ${tone === 'bad' ? 'text-rose-300' : tone === 'warn' ? 'text-amber-300' : 'text-zinc-100'}`}
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
    <div className="space-y-4">
      <Panel
        title="Ruleset source"
        subtitle={
          ops
            ? `${ops.app} · ${ops.topology} · role ${ops.role} · evaluates ${ops.environment}`
            : undefined
        }
      >
        <QueryState query={query} empty={false}>
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
            <p
              role="alert"
              className="border-t border-bad/40 bg-bad/10 px-4 py-2 text-xs text-rose-300"
            >
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
        <QueryState query={query} empty={false}>
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
                <Badge variant={ops.relay ? 'type' : 'danger'}>
                  {ops.relay ? 'relay configured' : 'no relay'}
                </Badge>
                <Badge variant={ops.worker ? 'type' : 'outline'}>
                  {ops.worker ? 'worker available' : 'no worker'}
                </Badge>
                <Badge variant={ops.analytics ? 'type' : 'outline'}>
                  {ops.analytics ? 'analytics backend' : 'no analytics'}
                </Badge>
              </div>
              {ops.sinkError && (
                <p className="px-4 pb-2 text-xs text-rose-300">
                  Sink status unavailable: {ops.sinkError}
                </p>
              )}
              {ops.sinks.length === 0 ? (
                <p className="border-t border-line p-4 text-sm text-zinc-500">
                  No sinks configured.
                </p>
              ) : (
                <Table head={['Sink', 'Lag', 'Delivered', 'Leased by', 'Last error']}>
                  {ops.sinks.map((sink) => (
                    <tr key={sink.sink}>
                      <td className="mono px-4 py-2">{sink.sink}</td>
                      <td
                        className={`mono px-4 py-2 tnum ${(sink.lag ?? 0) > 0 ? 'text-amber-300' : ''}`}
                      >
                        {sink.lag ?? '—'}
                      </td>
                      <td className="mono px-4 py-2 tnum">{sink.delivered ?? '—'}</td>
                      <td className="mono px-4 py-2 text-zinc-400">{sink.leasedBy ?? '—'}</td>
                      <td className="px-4 py-2 text-rose-300">{sink.lastError ?? ''}</td>
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
            <p className="p-4 text-sm text-zinc-500">No tenant has called in yet.</p>
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
                  <td className="px-4 py-2 text-zinc-400">{t.capabilities.join(', ') || '—'}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      )}
    </div>
  );
}
