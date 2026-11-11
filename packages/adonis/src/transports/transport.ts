import type { FlagEvent } from '../events/event.js';
import type { SqlClient } from '../sql.js';

/** What a transport guarantees. The provider warns once at boot about what it does not. */
export interface TransportCapabilities {
  /**
   * Can write inside the caller's database transaction, so a conversion and the business write it
   * belongs to commit or roll back together. Only `db` can.
   */
  transactional: boolean;
  /** Survives a process crash once `publish` resolved. */
  durable: boolean;
}

/** A leased batch for one sink. Exactly one of `ack`/`release`/`fail` must be called. */
export interface Delivery {
  events: FlagEvent[];
  /** Marks the batch delivered and moves the sink's cursor past it. */
  ack(): Promise<void>;
  /** Gives the lease back without moving the cursor (nothing to deliver, or shutting down). */
  release(): Promise<void>;
  /** Records the error and gives the lease back; the same batch is retried later. */
  fail(error: unknown): Promise<void>;
}

export interface SinkStatus {
  sink: string;
  /** Events waiting for this sink (approximate on some transports). */
  lag: number;
  delivered: number;
  leasedBy: string | null;
  lastError: string | null;
}

export interface PublishOptions {
  /** A database transaction to write in (transactional transports only). */
  client?: SqlClient;
}

/**
 * Moves events from the process that produced them to the relay that delivers them to sinks.
 * DESIGN §8: the transport is the log, and each sink reads it at its own pace through its own
 * cursor.
 */
export interface Transport {
  readonly name: string;
  readonly capabilities: TransportCapabilities;
  setup?(): Promise<void>;
  publish(events: FlagEvent[], options?: PublishOptions): Promise<void>;
  /**
   * Leases the next batch for `sink`. Resolves `null` when another process holds the lease, and a
   * delivery with no events when the sink is caught up. Transports without a consumer side (`http`
   * on a tenant) do not implement it.
   */
  consume?(
    sink: string,
    options: { batchSize: number; leaseMs: number; owner: string },
  ): Promise<Delivery | null>;
  /** Moves a sink's cursor back to the beginning (replay / backfill a new destination). */
  rewind?(sink: string): Promise<void>;
  status?(sinks: string[]): Promise<SinkStatus[]>;
  /** The newest id every listed sink has delivered (what is safe to prune). */
  safePruneId?(sinks: string[]): Promise<number>;
  close?(): Promise<void>;
}
