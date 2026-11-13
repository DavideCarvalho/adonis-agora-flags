import type { MetricDefinition, Ruleset } from '@adonis-agora/flags-core';
import type { ExperimentConfig } from '../define_config.js';

/** Where a metric or an experiment's analysis was defined. */
export type DefinitionSource = 'config' | 'console';

export interface ResolvedExperiment extends ExperimentConfig {
  source: DefinitionSource;
}

export interface ResolvedAnalysis {
  metrics: Record<string, MetricDefinition>;
  metricSources: Record<string, DefinitionSource>;
  experiments: Record<string, ResolvedExperiment>;
}

/**
 * The metrics and experiments that apply to one environment: those in `config/flags.ts` plus those
 * the console stored in the ruleset. On a name clash the config wins — it shipped with the code
 * that tracks the events.
 *
 * A ruleset experiment is a flag marked as an experiment with at least one metric or guardrail; its
 * key is `experiment.key`, or the flag key.
 */
export function resolveAnalysis(
  config: {
    metrics?: Record<string, MetricDefinition>;
    experiments?: Record<string, ExperimentConfig>;
  },
  ruleset: Pick<Ruleset, 'flags' | 'metrics'> | undefined,
): ResolvedAnalysis {
  const metrics: Record<string, MetricDefinition> = {};
  const metricSources: Record<string, DefinitionSource> = {};
  for (const [name, definition] of Object.entries(ruleset?.metrics ?? {})) {
    metrics[name] = definition;
    metricSources[name] = 'console';
  }
  for (const [name, definition] of Object.entries(config.metrics ?? {})) {
    metrics[name] = definition;
    metricSources[name] = 'config';
  }

  const experiments: Record<string, ResolvedExperiment> = {};
  for (const [flag, definition] of Object.entries(ruleset?.flags ?? {})) {
    const settings = definition.experiment;
    if (!settings) continue;
    const decide = settings.metrics ?? [];
    const guardrails = settings.guardrails ?? [];
    if (decide.length === 0 && guardrails.length === 0) continue;
    const key = settings.key ?? flag;
    experiments[key] = {
      source: 'console',
      metrics: decide,
      ...(guardrails.length > 0 ? { guardrails } : {}),
      ...(settings.control !== undefined ? { control: settings.control } : {}),
      ...(settings.confidence !== undefined ? { confidence: settings.confidence } : {}),
      ...(key !== flag ? { flag } : {}),
    };
  }
  for (const [key, experiment] of Object.entries(config.experiments ?? {})) {
    experiments[key] = { ...experiment, source: 'config' };
  }
  return { metrics, metricSources, experiments };
}
