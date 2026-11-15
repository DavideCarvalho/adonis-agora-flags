import type { FlagEvent } from '../events/event.js';
import type { Transport } from '../transports/transport.js';
import { type BullMQTenantTransportOptions, bullmqTransport } from './bullmq.js';
import { type DurableTenantTransportOptions, durableTransport } from './durable.js';
import { type HttpTenantTransportOptions, httpTransport } from './http.js';
import { byteLength } from './message.js';
import { type QueueTenantTransportOptions, queueTransport } from './queue.js';
import { type RedisTenantTransportOptions, redisTransport } from './redis.js';
import type { PushTransport, TenantPush, WatchTransport } from './types.js';

/**
 * How a tenant and its control-plane talk (server to server only: browsers and OFREP always use
 * the control-plane's HTTP routes). Set `tenant.transport` on the app and list the same driver in
 * `controlPlane.transports` on the flags server. Not the owned-state `transports.*` (the event log).
 */
export const tenantTransports = {
  /** The default: HTTP POST for events, ETag + server-sent events for the ruleset. */
  http(options: HttpTenantTransportOptions = {}): WatchTransport {
    return httpTransport(options);
  },
  /** `@adonisjs/queue` jobs the control-plane's workers apply. Push only. */
  queue(options: QueueTenantTransportOptions = {}): PushTransport {
    return queueTransport(options);
  },
  /** BullMQ jobs (`bullmq` + `ioredis`). Push only. */
  bullmq(options: BullMQTenantTransportOptions): PushTransport {
    return bullmqTransport(options);
  },
  /** A Redis stream for events; a per-partition key + pub/sub for the ruleset (`@adonisjs/redis`). */
  redis(options: RedisTenantTransportOptions = {}): WatchTransport {
    return redisTransport(options);
  },
  /** Durable runs for events; a durable run + durable's control plane for the ruleset. */
  durable(options: DurableTenantTransportOptions = {}): WatchTransport {
    return durableTransport(options);
  },
};

/**
 * The tenant's event log: each batch goes out through the push channel, split so every message
 * fits the driver's size limit.
 */
export class PushEventTransport implements Transport {
  readonly name: string;
  readonly capabilities = { transactional: false, durable: false };

  constructor(private readonly push: TenantPush) {
    this.name = push.driver;
  }

  async publish(events: FlagEvent[]): Promise<void> {
    if (events.length === 0) return;
    // Envelope overhead (token, ids) is small; keep a margin.
    const limit = this.push.maxBytes - 16 * 1024;
    if (
      events.length > 1 &&
      (events.length > 5000 || byteLength(JSON.stringify({ events })) > limit)
    ) {
      const half = Math.ceil(events.length / 2);
      await this.publish(events.slice(0, half));
      await this.publish(events.slice(half));
      return;
    }
    await this.push.send('events', { events });
  }

  async close(): Promise<void> {
    await this.push.close?.();
  }
}

export { type DeadLetter, PoisonMessageError, type TenantMessage } from './message.js';
export type { PushTransport, TenantTransport, WatchTransport } from './types.js';
export type {
  BullMQTenantTransportOptions,
  DurableTenantTransportOptions,
  HttpTenantTransportOptions,
  QueueTenantTransportOptions,
  RedisTenantTransportOptions,
};
