import type { Transport } from '../transports/transport.js';
import type { FlagEvent } from './event.js';

export interface BufferOptions {
  /** Flush when this many events are waiting. Default 500. */
  maxSize?: number;
  /** Flush at least this often (ms). Default 1000. */
  flushMs?: number;
  /**
   * Hard cap while the transport is failing. Beyond it the OLDEST events are dropped (and counted)
   * so a long outage cannot exhaust memory. Default 50,000.
   */
  maxQueue?: number;
  /** Exposure ids remembered to skip repeats in this process. Default 100,000. */
  dedupeSize?: number;
  onError?: (error: unknown) => void;
}

/**
 * Batches events in process before they reach the transport, so a busy page does not turn into
 * one INSERT per exposure. Exposures are also deduped here: the same subject seeing the same
 * experiment on every request produces one event per process, not one per request (the sinks
 * dedupe the rest).
 */
export class EventBuffer {
  #queue: FlagEvent[] = [];
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;
  #seen = new Map<string, true>();
  dropped = 0;
  published = 0;

  constructor(
    private readonly transport: Transport,
    private readonly options: BufferOptions = {},
  ) {}

  start() {
    this.#timer ??= setInterval(() => void this.flush(), this.options.flushMs ?? 1000);
    this.#timer.unref();
  }

  /** Queues an event. Returns `false` for an exposure this process already sent. */
  push(event: FlagEvent): boolean {
    if (event.type === 'exposure') {
      if (this.#seen.has(event.id)) return false;
      this.#seen.set(event.id, true);
      const cap = this.options.dedupeSize ?? 100_000;
      if (this.#seen.size > cap) {
        // Map iteration order is insertion order: drop the oldest tenth.
        let drop = Math.ceil(cap / 10);
        for (const key of this.#seen.keys()) {
          this.#seen.delete(key);
          if (--drop === 0) break;
        }
      }
    }
    this.#queue.push(event);
    const maxQueue = this.options.maxQueue ?? 50_000;
    if (this.#queue.length > maxQueue) {
      const excess = this.#queue.length - maxQueue;
      this.#queue.splice(0, excess);
      this.dropped += excess;
    }
    if (this.#queue.length >= (this.options.maxSize ?? 500)) void this.flush();
    return true;
  }

  get pending(): number {
    return this.#queue.length;
  }

  flush(): Promise<void> {
    this.#flushing ??= this.#flush().finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.slice(0, this.options.maxSize ?? 500);
      const droppedBefore = this.dropped;
      try {
        await this.transport.publish(batch);
      } catch (error) {
        // Keep the batch for the next tick; the transport may be back by then.
        this.options.onError?.(error);
        return;
      }
      // Overflow while publishing drops from the front, i.e. from this batch first.
      this.#queue.splice(0, Math.max(0, batch.length - (this.dropped - droppedBefore)));
      this.published += batch.length;
    }
  }

  /** Stops the timer and sends what is left. */
  async close(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
  }
}
