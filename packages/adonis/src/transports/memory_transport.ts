import type { FlagEvent } from '../events/event.js';
import type { Delivery, SinkStatus, Transport } from './transport.js';

/**
 * An in-process log. For tests and local development: nothing survives a restart, and replicas do
 * not share it. Cursors and leases behave like the `db` transport's so code exercised against it
 * behaves the same in production.
 */
export class MemoryTransport implements Transport {
  readonly name = 'memory';
  readonly capabilities = { transactional: false, durable: false };
  readonly log: Array<{ id: number; event: FlagEvent }> = [];
  #nextId = 1;
  #cursors = new Map<
    string,
    {
      lastId: number;
      delivered: number;
      leasedBy: string | null;
      leaseUntil: number;
      lastError: string | null;
    }
  >();

  async publish(events: FlagEvent[]): Promise<void> {
    for (const event of events)
      this.log.push({ id: this.#nextId++, event: structuredClone(event) });
  }

  #cursor(sink: string) {
    let cursor = this.#cursors.get(sink);
    if (!cursor) {
      cursor = { lastId: 0, delivered: 0, leasedBy: null, leaseUntil: 0, lastError: null };
      this.#cursors.set(sink, cursor);
    }
    return cursor;
  }

  async consume(
    sink: string,
    options: { batchSize: number; leaseMs: number; owner: string },
  ): Promise<Delivery | null> {
    const cursor = this.#cursor(sink);
    const now = Date.now();
    if (cursor.leasedBy && cursor.leasedBy !== options.owner && cursor.leaseUntil > now)
      return null;
    cursor.leasedBy = options.owner;
    cursor.leaseUntil = now + options.leaseMs;
    const batch = this.log.filter((entry) => entry.id > cursor.lastId).slice(0, options.batchSize);
    let settled = false;
    const release = () => {
      if (cursor.leasedBy === options.owner) cursor.leaseUntil = 0;
    };
    return {
      events: batch.map((entry) => structuredClone(entry.event)),
      ack: async () => {
        if (settled) return;
        settled = true;
        if (cursor.leasedBy !== options.owner) return;
        if (batch.length > 0) {
          cursor.lastId = batch.at(-1)!.id;
          cursor.delivered += batch.length;
        }
        cursor.lastError = null;
        release();
      },
      release: async () => {
        if (settled) return;
        settled = true;
        release();
      },
      fail: async (error) => {
        if (settled) return;
        settled = true;
        cursor.lastError = error instanceof Error ? error.message : String(error);
        release();
      },
    };
  }

  async rewind(sink: string): Promise<void> {
    const cursor = this.#cursor(sink);
    cursor.lastId = 0;
    cursor.delivered = 0;
  }

  async status(sinks: string[]): Promise<SinkStatus[]> {
    const maxId = this.log.at(-1)?.id ?? 0;
    return sinks.map((sink) => {
      const cursor = this.#cursor(sink);
      return {
        sink,
        lag: Math.max(0, maxId - cursor.lastId),
        delivered: cursor.delivered,
        leasedBy: cursor.leaseUntil > Date.now() ? cursor.leasedBy : null,
        lastError: cursor.lastError,
      };
    });
  }

  async safePruneId(sinks: string[]): Promise<number> {
    if (sinks.length === 0) return this.log.at(-1)?.id ?? 0;
    return Math.min(...sinks.map((sink) => this.#cursor(sink).lastId));
  }
}
