import { consume, loadPeer } from './common.js';
import { byteLength, createMessage, DEFAULT_MAX_MESSAGE_BYTES } from './message.js';
import type { ControlPlaneLinkContext, PushTransport, TenantLinkContext } from './types.js';

export interface QueueTenantTransportOptions {
  /**
   * Queue the messages go to. Run `node ace queue:work --queue=<it>` on the control-plane only.
   * Default `agora-flags-tenants`.
   */
  queue?: string;
  /** Adapter from `config/queue.ts`. Default: the queue's default adapter. */
  connection?: string;
  /** Attempts after the first failure before a message is dead-lettered. Default 5. */
  maxRetries?: number;
  /** Largest message accepted (bytes). Default 1 MiB. */
  maxMessageBytes?: number;
  /** The job's registered name. Default `agora_flags_tenant_message`. */
  jobName?: string;
}

/** The parts of `@adonisjs/queue` this driver uses. */
export interface QueuePeer {
  Job: abstract new () => {
    readonly payload: unknown;
    readonly context: { jobId: string; attempt: number };
  };
  Locator: { register(name: string, JobClass: unknown): void };
  exponentialBackoff(config?: Record<string, unknown>): () => unknown;
}

interface JobClass {
  dispatchMany(payloads: unknown[]): { run(): Promise<unknown> };
}

/** The handler of the control-plane in this process, per job name (set by `serve`). */
const handlers = new Map<string, ControlPlaneLinkContext>();

async function jobClass(
  options: QueueTenantTransportOptions,
  load: () => Promise<QueuePeer>,
  cache: { job?: JobClass },
): Promise<JobClass> {
  if (cache.job) return cache.job;
  const queue = await load();
  const name = options.jobName ?? 'agora_flags_tenant_message';
  const maxRetries = options.maxRetries ?? 5;
  class FlagsTenantMessageJob extends queue.Job {
    static options = {
      name,
      queue: options.queue ?? 'agora-flags-tenants',
      ...(options.connection !== undefined ? { adapter: options.connection } : {}),
      maxRetries,
      retry: { backoff: queue.exponentialBackoff({ baseDelay: '1s', maxDelay: '5m' }) },
      removeOnFail: false,
    };

    async execute(): Promise<void> {
      const cp = handlers.get(name);
      if (!cp) {
        throw new Error(
          `[flags] ${name} ran in a process that is not a flags control-plane: run its queue worker on the control-plane only`,
        );
      }
      await consume(cp.handler, 'queue', this.payload, {
        attempt: this.context.attempt,
        maxAttempts: maxRetries + 1,
      });
    }
  }
  queue.Locator.register(name, FlagsTenantMessageJob);
  cache.job = FlagsTenantMessageJob as unknown as JobClass;
  return cache.job;
}

async function ensureQueue(ctx: { app?: TenantLinkContext['app'] }) {
  const container = ctx.app?.container;
  if (!container) return;
  if (!container.hasBinding('queue.manager'))
    throw new Error(
      '[flags] the "queue" tenant transport needs @adonisjs/queue configured (node ace add @adonisjs/queue)',
    );
  await container.make('queue.manager' as never);
}

/**
 * Tenant messages as `@adonisjs/queue` jobs: the control-plane's queue workers apply them with the
 * queue's retries. Push only: the ruleset still comes over `http` (or `tenant.watch`).
 */
export function queueTransport(
  options: QueueTenantTransportOptions = {},
  /** @internal tests */
  load: () => Promise<QueuePeer> = () => loadPeer<QueuePeer>('@adonisjs/queue', 'queue'),
): PushTransport {
  const cache: { job?: JobClass } = {};
  const maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  return {
    driver: 'queue',
    canWatch: false,
    passive: true,
    async push(ctx) {
      await ensureQueue(ctx);
      const Job = await jobClass(options, load, cache);
      return {
        driver: 'queue',
        maxBytes,
        async send(kind, body) {
          const message = createMessage(kind, ctx.partition, await ctx.token.get(), body);
          if (byteLength(JSON.stringify(message)) > maxBytes)
            throw new Error(`[flags] message exceeds ${maxBytes} bytes`);
          await Job.dispatchMany([message]).run();
        },
      };
    },
    async serve(ctx) {
      await ensureQueue(ctx);
      handlers.set(options.jobName ?? 'agora_flags_tenant_message', ctx);
      await jobClass(options, load, cache);
      return {
        driver: 'queue',
        async close() {
          handlers.delete(options.jobName ?? 'agora_flags_tenant_message');
        },
      };
    },
  };
}
