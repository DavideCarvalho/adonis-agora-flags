import type { FlagEvent } from '../events/event.js';

/**
 * A destination for events. The relay hands each sink batches from its own cursor; a sink must be
 * idempotent by `event.id`, because delivery is at-least-once.
 */
export interface Sink {
  /** Kind, for logs (`lucid`, `posthog`, …). The sink's name is its key in the config. */
  readonly kind: string;
  /** Per-sink batch size. Default: the relay's. */
  readonly batchSize?: number | undefined;
  /** Per-sink delivery interval in ms. Default: the relay's. */
  readonly intervalMs?: number | undefined;
  setup?(): Promise<void>;
  write(events: FlagEvent[]): Promise<void>;
  /** Deletes everything stored about a subject (right to erasure). */
  forget?(subject: string): Promise<void>;
  close?(): Promise<void>;
}

/** Keeps events in memory. For tests. */
export class MemorySink implements Sink {
  readonly kind = 'memory';
  readonly events: FlagEvent[] = [];
  readonly #seen = new Set<string>();

  async write(events: FlagEvent[]): Promise<void> {
    for (const event of events) {
      if (this.#seen.has(event.id)) continue;
      this.#seen.add(event.id);
      this.events.push(event);
    }
  }

  async forget(subject: string): Promise<void> {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.subject === subject) this.events.splice(i, 1);
    }
  }
}

/** Hands batches to your function (a queue, a webhook, another warehouse). */
export class CallbackSink implements Sink {
  readonly kind = 'callback';
  constructor(
    private readonly callback: (events: FlagEvent[]) => Promise<void>,
    readonly batchSize?: number,
    readonly intervalMs?: number,
  ) {}

  write(events: FlagEvent[]): Promise<void> {
    return this.callback(events);
  }
}
