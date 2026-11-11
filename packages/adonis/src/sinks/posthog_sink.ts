import type { FlagEvent } from '../events/event.js';
import type { Sink } from './sink.js';

export interface PostHogSinkOptions {
  /** Project API key (the public `phc_…` key). */
  apiKey: string;
  /** Default `https://us.i.posthog.com`. */
  host?: string;
  batchSize?: number;
  intervalMs?: number;
  fetch?: typeof fetch;
}

/**
 * Sends exposures as PostHog's `$feature_flag_called` events (so PostHog's experiment tooling
 * recognises them) and tracks as regular events, through the `/batch/` endpoint. Every event
 * carries its id as `uuid`, which PostHog uses to dedupe re-sends.
 *
 * Erasure (`forget`) is not implemented here: deleting a person in PostHog goes through its
 * private API with a personal key. Do it there.
 */
export class PostHogSink implements Sink {
  readonly kind = 'posthog';
  readonly #fetch: typeof fetch;

  constructor(private readonly options: PostHogSinkOptions) {
    this.#fetch = options.fetch ?? fetch;
  }

  get batchSize() {
    return this.options.batchSize ?? 500;
  }

  get intervalMs() {
    return this.options.intervalMs;
  }

  async write(events: FlagEvent[]): Promise<void> {
    if (events.length === 0) return;
    const batch = events.map((e) =>
      e.type === 'exposure'
        ? {
            event: '$feature_flag_called',
            distinct_id: e.subject,
            uuid: e.id,
            timestamp: new Date(e.ts).toISOString(),
            properties: {
              $feature_flag: e.flag ?? e.experiment,
              $feature_flag_response: e.variant,
              experiment: e.experiment,
              app: e.app,
              environment: e.environment,
              subject_type: e.subjectType,
              ...e.props,
            },
          }
        : {
            event: e.name,
            distinct_id: e.subject,
            uuid: e.id,
            timestamp: new Date(e.ts).toISOString(),
            properties: {
              ...(e.value !== undefined ? { value: e.value } : {}),
              app: e.app,
              environment: e.environment,
              subject_type: e.subjectType,
              ...e.props,
            },
          },
    );
    const host = (this.options.host ?? 'https://us.i.posthog.com').replace(/\/$/, '');
    const response = await this.#fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ api_key: this.options.apiKey, historical_migration: false, batch }),
    });
    if (!response.ok)
      throw new Error(`PostHog answered ${response.status}: ${await response.text()}`);
  }
}
