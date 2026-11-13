import type { Ruleset } from '@adonis-agora/flags-core';
import type { FlagsAdmin } from '../admin.js';
import type { AnalyticsBackend } from '../analytics/backend.js';
import { resolveAnalysis } from '../analytics/experiments.js';
import type { MetricDefinition } from '../analytics/metrics.js';
import { computeResults, type ExperimentResults } from '../analytics/results.js';
import type { ExperimentConfig } from '../define_config.js';
import type { RulesetSource } from '../ruleset_source.js';
import { ensureEventPartitions, pruneEvents } from '../schema.js';
import type { SqlClient } from '../sql.js';
import type { Transport } from '../transports/transport.js';
import type { Relay } from './relay.js';
import type { ResultsCache } from './results_cache.js';

export interface WorkerOptions {
  relay?: Relay;
  /** Default drain interval per sink (ms). */
  relayIntervalMs?: number;
  admin?: FlagsAdmin;
  source: RulesetSource;
  /** The environment this process reads (results default to it). */
  environment?: string;
  /** Environments whose experiment results the worker recomputes. Default: `[environment]`. */
  resultsEnvironments?: string[];
  analytics?: AnalyticsBackend;
  resultsCache?: ResultsCache;
  metrics?: Record<string, MetricDefinition>;
  experiments?: Record<string, ExperimentConfig>;
  resultsIntervalMs?: number;
  transport?: Transport;
  /** The db transport's client, for partition maintenance and pruning. */
  eventsDb?: SqlClient;
  retentionDays?: number;
  logger?: {
    info?(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}

export type TaskName = 'relay' | 'schedules' | 'results' | 'maintenance';

/**
 * The background work of a flags deployment: relaying events to sinks, executing scheduled changes,
 * recomputing experiment results, and maintaining the event log. Every task is safe to run on many
 * replicas at once (leases, schedule claims, idempotent writes), so where it runs is a deployment
 * choice (`role` / `dispatcher`), not a correctness one.
 */
export class FlagsWorker {
  #timer: NodeJS.Timeout | undefined;
  #nextRun = new Map<string, number>();
  #running = false;

  constructor(readonly options: WorkerOptions) {}

  /** Due-ness check for in-process scheduling. */
  #due(key: string, intervalMs: number, now: number): boolean {
    const next = this.#nextRun.get(key) ?? 0;
    if (now < next) return false;
    this.#nextRun.set(key, now + intervalMs);
    return true;
  }

  /** Runs whatever is due. In-process mode calls this every second. */
  async tick(now = Date.now()): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const relay = this.options.relay;
      if (relay) {
        for (const name of relay.sinkNames) {
          const interval = relay.sink(name)?.intervalMs ?? this.options.relayIntervalMs ?? 5000;
          if (this.#due(`relay:${name}`, interval, now)) await this.relaySink(name);
        }
      }
      if (this.options.admin && this.#due('schedules', 15_000, now)) await this.runSchedules();
      if (this.#due('results', this.options.resultsIntervalMs ?? 600_000, now))
        await this.computeAllResults();
      if (this.#due('maintenance', 3_600_000, now)) await this.maintenance();
    } finally {
      this.#running = false;
    }
  }

  /** Runs every task once, regardless of schedule (`flags:work --once`). */
  async runAll(): Promise<void> {
    for (const name of this.options.relay?.sinkNames ?? []) await this.relaySink(name);
    await this.runSchedules();
    await this.computeAllResults();
    await this.maintenance();
  }

  async relaySink(name: string) {
    try {
      const result = await this.options.relay!.drain(name);
      if (result.error) this.options.logger?.warn(`[flags] sink "${name}" failed: ${result.error}`);
      return result;
    } catch (error) {
      this.options.logger?.error(`[flags] relay to "${name}" crashed: ${(error as Error).message}`);
      return undefined;
    }
  }

  async runSchedules() {
    if (!this.options.admin) return [];
    try {
      const results = await this.options.admin.runDueSchedules();
      for (const r of results) {
        if (!r.ok) this.options.logger?.warn(`[flags] scheduled change ${r.id} failed: ${r.error}`);
      }
      return results;
    } catch (error) {
      this.options.logger?.error(`[flags] schedules crashed: ${(error as Error).message}`);
      return [];
    }
  }

  /** Recomputes and caches results for every experiment, from the config and from the console. */
  async computeAllResults(): Promise<ExperimentResults[]> {
    const { analytics, resultsCache } = this.options;
    if (!analytics || !resultsCache) return [];
    const out: ExperimentResults[] = [];
    const environments = this.options.resultsEnvironments ?? [this.#environment];
    for (const environment of environments) {
      let ruleset: Ruleset;
      try {
        ruleset = await this.#ruleset(environment);
      } catch (error) {
        this.options.logger?.error(
          `[flags] results for ${environment} failed: ${(error as Error).message}`,
        );
        continue;
      }
      for (const key of Object.keys(this.#analysis(ruleset).experiments)) {
        try {
          const result = await this.computeResults(key, environment, ruleset);
          if (result) out.push(result);
        } catch (error) {
          this.options.logger?.error(
            `[flags] results for "${key}" (${environment}) failed: ${(error as Error).message}`,
          );
        }
      }
    }
    return out;
  }

  get #environment(): string {
    return this.options.environment ?? 'production';
  }

  #ruleset(environment: string): Promise<Ruleset> {
    return environment === this.#environment || !this.options.admin
      ? Promise.resolve(this.options.source.current())
      : this.options.admin.store.readRuleset(environment);
  }

  #analysis(ruleset: Ruleset) {
    return resolveAnalysis(
      {
        ...(this.options.metrics ? { metrics: this.options.metrics } : {}),
        ...(this.options.experiments ? { experiments: this.options.experiments } : {}),
      },
      ruleset,
    );
  }

  /** Computes and caches one experiment's results for an environment (default: this process's). */
  async computeResults(
    key: string,
    environment = this.#environment,
    rulesetOf?: Ruleset,
  ): Promise<ExperimentResults | null> {
    const { analytics, resultsCache } = this.options;
    if (!analytics || !resultsCache) return null;
    const ruleset = rulesetOf ?? (await this.#ruleset(environment));
    const { metrics, experiments } = this.#analysis(ruleset);
    const experiment = experiments[key];
    if (!experiment) return null;
    const flagKey = experiment.flag ?? key;
    const definitions: Record<string, MetricDefinition> = {};
    for (const name of new Set([...experiment.metrics, ...(experiment.guardrails ?? [])])) {
      const definition = metrics[name];
      if (!definition) throw new Error(`experiment "${key}" uses unknown metric "${name}"`);
      definitions[name] = definition;
    }
    const previous = (await resultsCache.get(environment, key)) ?? undefined;
    const result = await computeResults(
      analytics,
      {
        key,
        flag: flagKey,
        environment,
        metrics: definitions,
        ...(experiment.guardrails ? { guardrails: experiment.guardrails } : {}),
        ...(experiment.control ? { control: experiment.control } : {}),
        ...(experiment.confidence ? { confidence: experiment.confidence } : {}),
      },
      ruleset.flags[flagKey],
      previous,
    );
    await resultsCache.set(environment, key, result);
    for (const metric of result.metrics) {
      if (metric.alert)
        this.options.logger?.warn(
          `[flags] guardrail "${metric.name}" regressed in experiment "${key}"`,
        );
    }
    if (result.srm?.mismatch) {
      this.options.logger?.warn(
        `[flags] experiment "${key}" has a sample ratio mismatch (p=${result.srm.pValue.toExponential(2)})`,
      );
    }
    return result;
  }

  async maintenance() {
    const db = this.options.eventsDb;
    if (!db) return;
    try {
      await ensureEventPartitions(db, Date.now());
      const sinks = this.options.relay?.sinkNames ?? [];
      const safeId = (await this.options.transport?.safePruneId?.(sinks)) ?? 0;
      const before = Date.now() - (this.options.retentionDays ?? 30) * 86_400_000;
      if (safeId > 0) await pruneEvents(db, before, safeId);
    } catch (error) {
      this.options.logger?.error(`[flags] maintenance failed: ${(error as Error).message}`);
    }
  }

  /** In-process scheduling: a 1s timer that runs what is due. */
  start() {
    this.#timer ??= setInterval(() => void this.tick(), 1000);
    this.#timer.unref();
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    // Let a tick in progress finish.
    while (this.#running) await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
