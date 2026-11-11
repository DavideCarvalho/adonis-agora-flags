import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Sink } from '../sinks/sink.js';
import type { Transport } from '../transports/transport.js';

export interface RelayOptions {
  /** Events per batch. Default 1000 (a sink can ask for its own). */
  batchSize?: number;
  /** How long a lease lasts (ms) before another process may take over. Default 60000. */
  leaseMs?: number;
}

export interface DrainResult {
  sink: string;
  delivered: number;
  batches: number;
  /** Another process holds the lease. */
  busy: boolean;
  error?: string;
}

/** A process-unique owner id for leases. */
export function relayOwner(): string {
  return `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
}

/**
 * Moves events from the transport to one sink: lease, read a batch, write it, ack (which moves the
 * cursor). Errors leave the cursor where it was, so the batch is retried next time. The lease makes
 * it safe for every replica to run the relay: one of them delivers per sink at a time.
 */
export class Relay {
  readonly owner: string;

  constructor(
    private readonly transport: Transport,
    private readonly sinks: Map<string, Sink>,
    private readonly options: RelayOptions = {},
    owner?: string,
  ) {
    this.owner = owner ?? relayOwner();
    if (!transport.consume) {
      throw new Error(
        `the "${transport.name}" transport has no consumer side; there is nothing to relay here`,
      );
    }
  }

  get sinkNames(): string[] {
    return [...this.sinks.keys()];
  }

  sink(name: string): Sink | undefined {
    return this.sinks.get(name);
  }

  /** Delivers up to `maxBatches` batches to `name`. */
  async drain(name: string, maxBatches = 20): Promise<DrainResult> {
    const sink = this.sinks.get(name);
    if (!sink) throw new Error(`unknown sink "${name}"`);
    const result: DrainResult = { sink: name, delivered: 0, batches: 0, busy: false };
    for (let i = 0; i < maxBatches; i++) {
      const delivery = await this.transport.consume!(name, {
        batchSize: sink.batchSize ?? this.options.batchSize ?? 1000,
        leaseMs: this.options.leaseMs ?? 60_000,
        owner: this.owner,
      });
      if (!delivery) {
        result.busy = result.batches === 0;
        break;
      }
      if (delivery.events.length === 0) {
        await delivery.release();
        break;
      }
      try {
        await sink.write(delivery.events);
        await delivery.ack();
        result.delivered += delivery.events.length;
        result.batches++;
      } catch (error) {
        await delivery.fail(error);
        result.error = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    return result;
  }

  async drainAll(maxBatches = 20): Promise<DrainResult[]> {
    const out: DrainResult[] = [];
    for (const name of this.sinks.keys()) out.push(await this.drain(name, maxBatches));
    return out;
  }
}
