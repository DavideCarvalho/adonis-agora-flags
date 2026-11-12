import type { FlagEvent } from '../events/event.js';
import type { Sink } from '../sinks/sink.js';
import type { Transport } from './transport.js';

export interface QueueTransportOptions {
  /** Queue the delivery jobs go to. Default: the job's default (`default`). */
  queue?: string;
  /** Adapter from `config/queue.ts` (`adapters`). Default: the queue's default adapter. */
  adapter?: string;
  /** Events per job. Default: the sink's `batchSize`, else 500. */
  batchSize?: number;
  /** Attempts after the first failure before a sink's batch is given up. Default 10. */
  maxRetries?: number;
  /**
   * Delay between attempts: a backoff from `@adonisjs/queue` (`exponentialBackoff()`, …). Default:
   * exponential from 1s, capped at 5 minutes.
   */
  backoff?: () => unknown;
  /**
   * Keep jobs that ran out of attempts in the queue's storage, so they can be inspected and retried.
   * Default `true`.
   */
  keepFailed?: boolean;
  /** The job's registered name. Default `agora_flags_deliver`. */
  jobName?: string;
}

/** What one delivery job carries: a batch of events for one sink. */
export interface DeliveryPayload {
  sink: string;
  events: FlagEvent[];
}

/** The parts of `@adonisjs/queue` (re-exporting `@boringnode/queue`) this transport uses. */
interface QueueModule {
  Job: abstract new () => QueueJob;
  Locator: { register(name: string, JobClass: unknown): void };
  exponentialBackoff(config?: {
    baseDelay?: string | number;
    maxDelay?: string | number;
    multiplier?: number;
    jitter?: boolean;
  }): () => unknown;
}

interface QueueJob {
  readonly payload: unknown;
  readonly context: { jobId: string; attempt: number };
}

interface DeliveryJobClass {
  dispatchMany(payloads: DeliveryPayload[]): { run(): Promise<unknown> };
}

interface QueueLogger {
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Events as `@adonisjs/queue` jobs: each published batch becomes one job per sink, so every sink
 * succeeds, retries and fails on its own, with the queue's retry and backoff. The job runs in your
 * queue workers (`node ace queue:work`) and writes the batch to that sink; there is no relay.
 *
 * A job queue forgets a job once it ran, so there is no log to replay (`rewind`), no per-sink
 * cursor to report, and nothing to prune. Durability is the queue adapter's (Redis, database).
 */
export class QueueTransport implements Transport {
  readonly name = 'queue';
  readonly capabilities = { transactional: false, durable: true };
  readonly jobName: string;
  #sinks: ReadonlyMap<string, Sink> | undefined;
  #job: DeliveryJobClass | undefined;
  #closed = false;

  constructor(
    private readonly options: QueueTransportOptions = {},
    private readonly logger?: QueueLogger,
    private readonly load: () => Promise<QueueModule> = loadQueue,
  ) {
    this.jobName = options.jobName ?? 'agora_flags_deliver';
  }

  /** Registers the delivery job, so this process's queue workers can run it. */
  async setup(): Promise<void> {
    await this.#jobClass();
  }

  attachSinks(sinks: ReadonlyMap<string, Sink>): void {
    this.#sinks = sinks;
  }

  async publish(events: FlagEvent[]): Promise<void> {
    if (events.length === 0) return;
    if (!this.#sinks) throw new Error('the "queue" transport has no sinks attached');
    const payloads: DeliveryPayload[] = [];
    for (const [sink, instance] of this.#sinks) {
      const size = Math.max(1, this.options.batchSize ?? instance.batchSize ?? 500);
      for (let i = 0; i < events.length; i += size)
        payloads.push({ sink, events: events.slice(i, i + size) });
    }
    if (payloads.length === 0) return;
    const Job = await this.#jobClass();
    await Job.dispatchMany(payloads).run();
  }

  /** Writes one job's batch to its sink. A throw fails the attempt; the queue retries it. */
  async deliver(payload: DeliveryPayload): Promise<void> {
    if (this.#closed || !this.#sinks) {
      throw new Error('the flags runtime is not running in this process; the job will be retried');
    }
    const sink = this.#sinks.get(payload.sink);
    if (!sink) {
      this.logger?.warn(
        `[flags] dropping ${payload.events.length} events for sink "${payload.sink}": it is no longer configured`,
      );
      return;
    }
    await sink.write(payload.events);
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #jobClass(): Promise<DeliveryJobClass> {
    if (this.#job) return Promise.resolve(this.#job);
    return this.load().then((queue) => {
      if (this.#job) return this.#job;
      const transport = this;
      const options = this.options;
      class FlagsDeliveryJob extends queue.Job {
        static options = {
          name: transport.jobName,
          ...(options.queue !== undefined ? { queue: options.queue } : {}),
          ...(options.adapter !== undefined ? { adapter: options.adapter } : {}),
          maxRetries: options.maxRetries ?? 10,
          retry: {
            backoff:
              options.backoff ?? queue.exponentialBackoff({ baseDelay: '1s', maxDelay: '5m' }),
          },
          removeOnFail: options.keepFailed === false,
        };

        async execute(): Promise<void> {
          await transport.deliver(this.payload as DeliveryPayload);
        }

        async failed(error: Error): Promise<void> {
          const payload = this.payload as DeliveryPayload;
          transport.logger?.error(
            `[flags] gave up delivering ${payload.events.length} events to sink "${payload.sink}" (job ${this.context.jobId}): ${error.message}`,
          );
        }
      }
      queue.Locator.register(this.jobName, FlagsDeliveryJob);
      this.#job = FlagsDeliveryJob as unknown as DeliveryJobClass;
      return this.#job;
    });
  }
}

async function loadQueue(): Promise<QueueModule> {
  try {
    return (await import('@adonisjs/queue')) as unknown as QueueModule;
  } catch (error) {
    throw new Error(
      `the "queue" transport needs @adonisjs/queue (npm install @adonisjs/queue): ${(error as Error).message}`,
    );
  }
}
