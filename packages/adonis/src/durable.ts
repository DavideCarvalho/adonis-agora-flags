import type { FlagsRuntime } from './runtime.js';

/** The slice of `@adonis-agora/durable`'s engine this package uses. */
export interface DurableEngineLike {
  register(
    name: string,
    version: string,
    fn: (ctx: unknown, input: never) => Promise<void>,
    opts?: { origin?: string },
  ): void;
  registerSchedules?(
    schedules: Array<{
      key: string;
      workflow: string;
      input?: unknown;
      everyMs: number;
      overlap?: 'allow' | 'skip';
    }>,
  ): void;
}

export const PACKAGE_ORIGIN = '@adonis-agora/flags';

export const WORKFLOWS = {
  relay: 'flags.relay',
  schedules: 'flags.schedules',
  results: 'flags.results',
  maintenance: 'flags.maintenance',
} as const;

/**
 * Runs the background work as durable workflows: one schedule per sink for the relay, plus
 * scheduled changes, results and maintenance. `overlap: 'skip'` keeps a slow run from piling up, and
 * the durable console shows every run, its errors and retries. The leases and claims inside each
 * task still make concurrent runs safe.
 */
export function registerDurableWorkflows(
  engine: DurableEngineLike,
  runtime: FlagsRuntime,
): boolean {
  const worker = runtime.worker;
  if (!worker) return false;
  if (!engine.registerSchedules) return false;
  const opts = { origin: PACKAGE_ORIGIN };
  engine.register(
    WORKFLOWS.relay,
    '1',
    async (_ctx, input: never) => {
      const result = await worker.relaySink((input as { sink: string }).sink);
      if (result?.error) throw new Error(result.error);
    },
    opts,
  );
  engine.register(WORKFLOWS.schedules, '1', async () => void (await worker.runSchedules()), opts);
  engine.register(
    WORKFLOWS.results,
    '1',
    async () => void (await worker.computeAllResults()),
    opts,
  );
  engine.register(WORKFLOWS.maintenance, '1', async () => worker.maintenance(), opts);

  const config = runtime.config as { relay?: { intervalMs?: number }; resultsIntervalMs?: number };
  const relayInterval = config.relay?.intervalMs ?? 5000;
  engine.registerSchedules([
    ...(runtime.relay?.sinkNames ?? []).map((sink) => ({
      key: `flags.relay.${sink}`,
      workflow: WORKFLOWS.relay,
      input: { sink },
      everyMs: Math.max(1000, runtime.sinks.get(sink)?.intervalMs ?? relayInterval),
      overlap: 'skip' as const,
    })),
    { key: 'flags.schedules', workflow: WORKFLOWS.schedules, everyMs: 15_000, overlap: 'skip' },
    {
      key: 'flags.results',
      workflow: WORKFLOWS.results,
      everyMs: config.resultsIntervalMs ?? 600_000,
      overlap: 'skip',
    },
    {
      key: 'flags.maintenance',
      workflow: WORKFLOWS.maintenance,
      everyMs: 3_600_000,
      overlap: 'skip',
    },
  ]);
  return true;
}
