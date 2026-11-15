import { consume, loadPeer } from './common.js';
import { byteLength, createMessage, DEFAULT_MAX_MESSAGE_BYTES } from './message.js';
import type { PushTransport } from './types.js';

export interface BullMQTenantTransportOptions {
  /** ioredis connection options or instance, handed to BullMQ. */
  connection: unknown;
  /** BullMQ key prefix. Default `bull`. */
  prefix?: string;
  /** Queue name. Default `agora-flags-tenants`. */
  queue?: string;
  /** Attempts before a message is dead-lettered (kept in the queue's failed set). Default 6. */
  attempts?: number;
  /** Jobs the control-plane's worker runs at once. Default 4. */
  concurrency?: number;
  /** Largest message accepted (bytes). Default 1 MiB. */
  maxMessageBytes?: number;
}

/** The parts of `bullmq` this driver uses. */
export interface BullMQPeer {
  Queue: new (
    name: string,
    options: { connection: unknown; prefix?: string },
  ) => {
    add(name: string, data: unknown, options?: Record<string, unknown>): Promise<unknown>;
    waitUntilReady?(): Promise<unknown>;
    close(): Promise<void>;
  };
  Worker: new (
    name: string,
    processor: (job: { data: unknown; attemptsMade: number }) => Promise<unknown>,
    options: { connection: unknown; prefix?: string; concurrency?: number },
  ) => { close(): Promise<void>; on?(event: string, fn: (...args: unknown[]) => void): unknown };
  UnrecoverableError: new (message?: string) => Error;
}

/**
 * Tenant messages as BullMQ jobs: retried with exponential backoff, dead-lettered into the queue's
 * failed set. Push only. Needs `bullmq` (and `ioredis`).
 */
export function bullmqTransport(
  options: BullMQTenantTransportOptions,
  /** @internal tests */
  load: () => Promise<BullMQPeer> = () => loadPeer<BullMQPeer>('bullmq', 'bullmq'),
): PushTransport {
  const name = options.queue ?? 'agora-flags-tenants';
  const maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const attempts = options.attempts ?? 6;
  const common = {
    connection: options.connection,
    ...(options.prefix ? { prefix: options.prefix } : {}),
  };
  return {
    driver: 'bullmq',
    canWatch: false,
    async push(ctx) {
      const { Queue } = await load();
      const queue = new Queue(name, common);
      return {
        driver: 'bullmq',
        maxBytes,
        async send(kind, body) {
          const message = createMessage(kind, ctx.partition, await ctx.token.get(), body);
          if (byteLength(JSON.stringify(message)) > maxBytes)
            throw new Error(`[flags] message exceeds ${maxBytes} bytes`);
          await queue.add(kind, message, {
            jobId: message.id,
            attempts,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: true,
            removeOnFail: false,
          });
        },
        async check() {
          await queue.waitUntilReady?.();
        },
        async close() {
          await queue.close();
        },
      };
    },
    async serve(ctx) {
      const { Worker, UnrecoverableError } = await load();
      const worker = new Worker(
        name,
        async (job) => {
          const handled = await consume(ctx.handler, 'bullmq', job.data, {
            attempt: job.attemptsMade + 1,
            maxAttempts: attempts,
          });
          // Dead-lettered: fail it for good so it stays in the failed set without more attempts.
          if (handled === null) throw new UnrecoverableError('dead-lettered');
        },
        { ...common, concurrency: options.concurrency ?? 4 },
      );
      return {
        driver: 'bullmq',
        async close() {
          await worker.close();
        },
      };
    },
  };
}
