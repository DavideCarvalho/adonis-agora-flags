import type { EvaluationDetails, JsonValue } from '@adonis-agora/flags-core';
import type {
  EvaluationContext,
  JsonValue as OFJsonValue,
  Provider,
  ResolutionDetails,
  TrackingEventDetails,
} from '@openfeature/server-sdk';
import type { FlagsManager } from '../manager.js';
import { getRuntime } from '../services/accessor.js';
import type { Subject } from '../subject.js';

/**
 * An OpenFeature provider backed by the same engine as `flags.for()`: same ruleset, same buckets,
 * same exposures. Use it when your code talks to `@openfeature/server-sdk` (to stay vendor-neutral
 * or to share code with services in other stacks).
 *
 * ```ts
 * import { OpenFeature } from '@openfeature/server-sdk'
 * import { AgoraFlagsProvider } from '@adonis-agora/flags/openfeature'
 *
 * await OpenFeature.setProviderAndWait(new AgoraFlagsProvider())
 * const client = OpenFeature.getClient()
 * await client.getBooleanValue('new_player', false, { targetingKey: user.id })
 * ```
 *
 * The context's `targetingKey` is the subject id; `subjectType` sets the subject type; every other
 * attribute is a targeting attribute. Tracking is OpenFeature's experimental `track()`.
 */
export class AgoraFlagsProvider implements Provider {
  readonly metadata = { name: '@adonis-agora/flags' } as const;
  readonly runsOn = 'server' as const;
  readonly hooks = [];

  /** Pass a manager explicitly, or let it resolve the booted one. */
  constructor(private readonly manager?: FlagsManager) {}

  get #manager(): FlagsManager {
    return this.manager ?? getRuntime().manager;
  }

  #subject(context: EvaluationContext): Subject | undefined {
    const key = context.targetingKey;
    if (key === undefined || key === '') return undefined;
    return {
      id: key,
      ...(typeof context.subjectType === 'string' ? { type: context.subjectType } : {}),
    };
  }

  #resolve<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): ResolutionDetails<T> {
    const manager = this.#manager;
    const { targetingKey: _key, ...attributes } = context;
    const details: EvaluationDetails<T> = manager.evaluateFor(
      flagKey,
      defaultValue,
      {
        ...(attributes as Record<string, unknown>),
        ...(context.targetingKey ? { targetingKey: context.targetingKey } : {}),
      },
      {},
    );
    const subject = this.#subject(context);
    if (subject) manager.expose(subject, details);
    return {
      value: details.value,
      reason: details.reason,
      ...(details.variant !== undefined ? { variant: details.variant } : {}),
      ...(details.errorCode ? { errorCode: details.errorCode as never } : {}),
      ...(details.errorMessage ? { errorMessage: details.errorMessage } : {}),
      flagMetadata: details.flagMetadata,
    };
  }

  async resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ) {
    return this.#resolve(flagKey, defaultValue, context);
  }

  async resolveStringEvaluation(flagKey: string, defaultValue: string, context: EvaluationContext) {
    return this.#resolve(flagKey, defaultValue, context);
  }

  async resolveNumberEvaluation(flagKey: string, defaultValue: number, context: EvaluationContext) {
    return this.#resolve(flagKey, defaultValue, context);
  }

  async resolveObjectEvaluation<T extends OFJsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ) {
    return this.#resolve(
      flagKey,
      defaultValue as unknown as JsonValue,
      context,
    ) as unknown as ResolutionDetails<T>;
  }

  track(
    trackingEventName: string,
    context: EvaluationContext,
    details?: TrackingEventDetails,
  ): void {
    const subject = this.#subject(context);
    if (!subject) return;
    const { value, ...props } = details ?? {};
    void this.#manager.track(subject, trackingEventName, {
      ...(typeof value === 'number' ? { value } : {}),
      ...(Object.keys(props).length > 0 ? { props: props as Record<string, unknown> } : {}),
    });
  }
}
