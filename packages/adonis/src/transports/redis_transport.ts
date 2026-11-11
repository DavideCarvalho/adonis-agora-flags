import type { FlagEvent } from '../events/event.js';
import type { Delivery, SinkStatus, Transport } from './transport.js';

/** The ioredis commands this transport uses (what `@adonisjs/redis` connections expose). */
export interface RedisStreamClient {
  xadd(...args: Array<string | number>): Promise<unknown>;
  xgroup(...args: Array<string | number>): Promise<unknown>;
  xreadgroup(...args: Array<string | number>): Promise<unknown>;
  xautoclaim(...args: Array<string | number>): Promise<unknown>;
  xack(...args: Array<string | number>): Promise<unknown>;
  xinfo(...args: Array<string | number>): Promise<unknown>;
  xpending(...args: Array<string | number>): Promise<unknown>;
  pipeline?(): { xadd(...args: Array<string | number>): unknown; exec(): Promise<unknown> };
}

export interface RedisTransportOptions {
  /** Stream key. Default `agora:flags:events`. */
  stream?: string;
  /**
   * Approximate cap on the stream length (`XADD MAXLEN ~`). Entries beyond it are trimmed even if a
   * sink has not read them, so size it for the longest outage you want to absorb. Default 1,000,000.
   */
  maxLength?: number;
}

type StreamEntry = [id: string, fields: string[]];

/**
 * Redis Streams: one consumer group per sink, so each sink reads at its own pace and a message is
 * delivered to one consumer of the group. A consumer that dies mid-batch leaves its messages
 * pending; they are reclaimed (`XAUTOCLAIM`) once idle for longer than the lease. Durability is
 * whatever the Redis server's persistence (AOF) gives; it is never transactional with the database.
 */
export class RedisTransport implements Transport {
  readonly name = 'redis';
  readonly capabilities = { transactional: false, durable: true };
  readonly stream: string;
  readonly #maxLength: number;
  #groups = new Set<string>();

  constructor(
    private readonly redis: RedisStreamClient,
    options: RedisTransportOptions = {},
  ) {
    this.stream = options.stream ?? 'agora:flags:events';
    this.#maxLength = options.maxLength ?? 1_000_000;
  }

  async publish(events: FlagEvent[]): Promise<void> {
    if (events.length === 0) return;
    const pipeline = this.redis.pipeline?.();
    for (const event of events) {
      const args = [this.stream, 'MAXLEN', '~', this.#maxLength, '*', 'e', JSON.stringify(event)];
      if (pipeline) pipeline.xadd(...args);
      else await this.redis.xadd(...args);
    }
    if (pipeline) {
      const results = (await pipeline.exec()) as Array<[Error | null, unknown]> | null;
      const failed = results?.find(([error]) => error);
      if (failed) throw failed[0];
    }
  }

  async #ensureGroup(sink: string) {
    if (this.#groups.has(sink)) return;
    try {
      // `0`: a new sink starts from the oldest retained entry (backfill), like a db cursor at 0.
      await this.redis.xgroup('CREATE', this.stream, sink, '0', 'MKSTREAM');
    } catch (error) {
      if (!/BUSYGROUP/.test(String((error as Error).message))) throw error;
    }
    this.#groups.add(sink);
  }

  async consume(
    sink: string,
    options: { batchSize: number; leaseMs: number; owner: string },
  ): Promise<Delivery | null> {
    await this.#ensureGroup(sink);
    // Reclaim entries another consumer leased and abandoned, then read new ones.
    const claimed = (await this.redis.xautoclaim(
      this.stream,
      sink,
      options.owner,
      options.leaseMs,
      '0-0',
      'COUNT',
      options.batchSize,
    )) as [string, StreamEntry[] | null, ...unknown[]];
    let entries = (claimed?.[1] ?? []).filter((entry): entry is StreamEntry =>
      Array.isArray(entry),
    );
    if (entries.length < options.batchSize) {
      const read = (await this.redis.xreadgroup(
        'GROUP',
        sink,
        options.owner,
        'COUNT',
        options.batchSize - entries.length,
        'STREAMS',
        this.stream,
        '>',
      )) as Array<[string, StreamEntry[]]> | null;
      entries = entries.concat(read?.[0]?.[1] ?? []);
    }
    const ids = entries.map(([id]) => id);
    const events = entries.map(
      ([, fields]) => JSON.parse(fields[fields.indexOf('e') + 1]!) as FlagEvent,
    );
    let settled = false;
    const settle = async (fn: () => Promise<void>) => {
      if (settled) return;
      settled = true;
      await fn();
    };
    return {
      events,
      ack: () =>
        settle(async () => {
          if (ids.length > 0) await this.redis.xack(this.stream, sink, ...ids);
        }),
      // Unacked entries stay pending and are reclaimed after the lease; nothing to undo.
      release: () => settle(async () => {}),
      fail: () => settle(async () => {}),
    };
  }

  async status(sinks: string[]): Promise<SinkStatus[]> {
    const out: SinkStatus[] = [];
    let groups: Array<Record<string, unknown>> = [];
    try {
      const raw = (await this.redis.xinfo('GROUPS', this.stream)) as unknown[][];
      groups = raw.map((pairs) => {
        const record: Record<string, unknown> = {};
        for (let i = 0; i < pairs.length; i += 2) record[String(pairs[i])] = pairs[i + 1];
        return record;
      });
    } catch {
      // No stream yet.
    }
    for (const sink of sinks) {
      const group = groups.find((g) => g.name === sink);
      out.push({
        sink,
        lag: Number(group?.lag ?? 0) + Number(group?.pending ?? 0),
        delivered: Number(group?.['entries-read'] ?? 0),
        leasedBy: null,
        lastError: null,
      });
    }
    return out;
  }
}
