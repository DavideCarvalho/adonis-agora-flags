import { channel } from 'node:diagnostics_channel';
import type { EvaluationContext, EvaluationDetails } from '@adonis-agora/flags-core';
import type { FlagEvent } from './events/event.js';

/**
 * Synchronous hooks around evaluation (DESIGN §8): they attach flag state to whatever the request is
 * already reporting — a span, an error report, the telescope timeline. They never block and never
 * throw into the caller.
 */
export interface Enricher {
  readonly name: string;
  setup?(): Promise<void>;
  onEvaluation?(details: EvaluationDetails, context: EvaluationContext): void;
  onEvent?(event: FlagEvent): void;
}

/** Channel names, following the ecosystem's `agora:<lib>:<event>` convention. */
export const DIAGNOSTICS_CHANNELS = {
  evaluation: 'agora:flags:evaluation',
  exposure: 'agora:flags:exposure',
  track: 'agora:flags:track',
  change: 'agora:flags:change',
} as const;

interface SentryLike {
  getClient?(): { getIntegrationByName?(name: string): unknown } | undefined;
  getCurrentScope?(): { setTag?(key: string, value: string): void } | undefined;
}

interface OtelApi {
  trace: {
    getActiveSpan():
      | { addEvent(name: string, attributes: Record<string, unknown>): void }
      | undefined;
  };
}

export const enrichers = {
  /**
   * Publishes evaluations, exposures and tracks on `node:diagnostics_channel` (`agora:flags:*`):
   * `@adonis-agora/diagnostics` and telescope pick them up. Free when nobody subscribes.
   */
  diagnostics(): Enricher {
    const evaluation = channel(DIAGNOSTICS_CHANNELS.evaluation);
    const exposure = channel(DIAGNOSTICS_CHANNELS.exposure);
    const track = channel(DIAGNOSTICS_CHANNELS.track);
    return {
      name: 'diagnostics',
      onEvaluation(details, context) {
        if (evaluation.hasSubscribers) {
          evaluation.publish({
            flag: details.flagKey,
            variant: details.variant,
            reason: details.reason,
            errorCode: details.errorCode,
            subject: context.targetingKey,
          });
        }
      },
      onEvent(event) {
        const target = event.type === 'exposure' ? exposure : track;
        if (target.hasSubscribers) target.publish(event);
      },
    };
  },

  /**
   * OpenTelemetry: a `feature_flag.evaluation` event on the active span, with the semantic
   * convention attributes (`feature_flag.key`, `feature_flag.result.variant`, …). Needs
   * `@opentelemetry/api` (optional peer); without it this enricher does nothing.
   */
  otel(): Enricher {
    let api: OtelApi | undefined;
    return {
      name: 'otel',
      async setup() {
        try {
          api = (await import('@opentelemetry/api')) as unknown as OtelApi;
        } catch {
          api = undefined;
        }
      },
      onEvaluation(details, context) {
        const span = api?.trace.getActiveSpan();
        if (!span) return;
        span.addEvent('feature_flag.evaluation', {
          'feature_flag.key': details.flagKey,
          'feature_flag.provider.name': '@adonis-agora/flags',
          'feature_flag.result.variant': details.variant,
          'feature_flag.result.reason': details.reason.toLowerCase(),
          ...(details.errorCode ? { 'error.type': details.errorCode.toLowerCase() } : {}),
          ...(context.targetingKey ? { 'feature_flag.context.id': context.targetingKey } : {}),
          ...(typeof details.flagMetadata.rulesetVersion === 'string'
            ? { 'feature_flag.version': details.flagMetadata.rulesetVersion }
            : {}),
        });
      },
    };
  },

  /**
   * Sentry: records each evaluated flag on the current scope, so an error report lists the flags
   * the request saw. Pass your Sentry module: `enrichers.sentry(Sentry)`. Uses Sentry's
   * feature-flags integration when it is installed, and a `flag.<key>` tag otherwise.
   */
  sentry(sentry: SentryLike): Enricher {
    return {
      name: 'sentry',
      onEvaluation(details) {
        const integration = sentry.getClient?.()?.getIntegrationByName?.('FeatureFlags') as
          | { addFeatureFlag?(name: string, value: unknown): void }
          | undefined;
        if (integration?.addFeatureFlag) {
          integration.addFeatureFlag(details.flagKey, details.value);
          return;
        }
        sentry
          .getCurrentScope?.()
          ?.setTag?.(`flag.${details.flagKey}`, String(details.variant ?? details.value));
      },
    };
  },
};

/** Runs enrichers without ever letting one break evaluation. */
export function runEnrichers(list: Enricher[], fn: (enricher: Enricher) => void): void {
  for (const enricher of list) {
    try {
      fn(enricher);
    } catch {
      // Enrichers are best-effort by contract.
    }
  }
}
