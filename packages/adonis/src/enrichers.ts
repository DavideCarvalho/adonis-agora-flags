import { channel } from 'node:diagnostics_channel';
import type { EvaluationContext, EvaluationDetails } from '@adonis-agora/flags-core';
import type { FlagEvent } from './events/event.js';
import type { Actor, RulesetChange } from './stores/store.js';

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
  /** A change was applied to the ruleset by this process (console, command, approval, schedule). */
  onChange?(change: FlagsChange): void;
}

/** A ruleset change, as enrichers and `agora:flags:change` see it. */
export interface FlagsChange {
  environment: string;
  /** The ruleset version the change produced. */
  version: string;
  entity: RulesetChange['entity'];
  key?: string;
  /** `true` when the change removed the entity. */
  deleted: boolean;
  actor: Actor;
  changeRequestId?: string;
}

/** The `<event>`s published on `agora:flags:<event>`. */
export const FLAGS_DIAGNOSTIC_EVENTS = ['evaluation', 'exposure', 'track', 'change'] as const;
export type FlagsDiagnosticEvent = (typeof FLAGS_DIAGNOSTIC_EVENTS)[number];

/** The `emit` of `@adonis-agora/diagnostics`, read from its global slot: flags never imports it. */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * Diagnostics' claim registry (a reference-counted `Map<'lib:event', number>`): its generic OTel
 * bridge skips claimed events, so `enrichers.otel()` claims evaluations it already records.
 */
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');

function claimDiagnostic(key: string): void {
  const g = globalThis as Record<symbol, unknown>;
  let claims = g[CLAIMS_SLOT] as Map<string, number> | undefined;
  if (claims === undefined) {
    claims = new Map<string, number>();
    g[CLAIMS_SLOT] = claims;
  }
  claims.set(key, (claims.get(key) ?? 0) + 1);
}

function diagnosticsEmit(): EmitFn | undefined {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
  return typeof emit === 'function' ? (emit as EmitFn) : undefined;
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
   * Publishes evaluations, exposures, tracks and ruleset changes through `@adonis-agora/diagnostics`
   * (`agora:flags:<event>`), so its OpenTelemetry bridge, telescope and `onDiagnostic('flags', …)`
   * listeners see them. Always on; does nothing when diagnostics is not installed.
   */
  diagnostics(): Enricher {
    // Each event goes through diagnostics' `emit` once even with no subscriber: that call is what
    // registers the channel, and its OTel bridge only subscribes to registered channels. After that
    // the payload is built only when someone listens.
    const registered = new Set<FlagsDiagnosticEvent>();
    const channels = new Map(
      FLAGS_DIAGNOSTIC_EVENTS.map((event) => [event, channel(`agora:flags:${event}`)]),
    );
    const publish = (event: FlagsDiagnosticEvent, payload: () => unknown) => {
      if (registered.has(event) && !channels.get(event)?.hasSubscribers) return;
      const emit = diagnosticsEmit();
      if (!emit) return;
      registered.add(event);
      emit('flags', event, payload());
    };
    return {
      name: 'diagnostics',
      onEvaluation(details, context) {
        publish('evaluation', () => ({
          flag: details.flagKey,
          variant: details.variant,
          reason: details.reason,
          errorCode: details.errorCode,
          subject: context.targetingKey,
        }));
      },
      onEvent(event) {
        publish(event.type === 'exposure' ? 'exposure' : 'track', () => event);
      },
      onChange(change) {
        publish('change', () => change);
      },
    };
  },

  /**
   * OpenTelemetry: a `feature_flag.evaluation` event on the active span, with the semantic
   * convention attributes (`feature_flag.key`, `feature_flag.result.variant`, …). Needs
   * `@opentelemetry/api` (optional peer); without it this enricher does nothing. It takes over
   * evaluations from diagnostics' generic OTel bridge, so each one is recorded once.
   */
  otel(): Enricher {
    let api: OtelApi | undefined;
    return {
      name: 'otel',
      async setup() {
        try {
          api = (await import('@opentelemetry/api')) as unknown as OtelApi;
          claimDiagnostic('flags:evaluation');
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
