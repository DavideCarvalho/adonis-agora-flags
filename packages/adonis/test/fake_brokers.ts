import type { BullMQPeer } from '../src/tenant_transports/bullmq.js';
import type { DurableBroadcast, DurableTenantEngine } from '../src/tenant_transports/durable.js';
import type { QueuePeer } from '../src/tenant_transports/queue.js';
import type { TenantRedisClient } from '../src/tenant_transports/redis.js';

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

interface Entry {
  id: string;
  fields: string[];
}

/** The Redis commands the tenant transport uses, in memory. Duplicates share the data. */
export class FakeRedis implements TenantRedisClient {
  constructor(
    readonly state = {
      streams: new Map<string, Entry[]>(),
      groups: new Map<string, { last: number; pending: Map<string, number> }>(),
      keys: new Map<string, string>(),
      subscribers: new Set<FakeRedis>(),
      seq: 0,
      down: false,
    },
  ) {}
  #channels = new Set<string>();
  #handlers: Array<(channel: string, message: string) => void> = [];

  #check() {
    if (this.state.down) throw new Error('connect ECONNREFUSED');
  }

  async xadd(...args: Array<string | number>) {
    this.#check();
    const key = String(args[0]);
    const star = args.indexOf('*');
    const fields = args.slice(star + 1).map(String);
    const list = this.state.streams.get(key) ?? [];
    const id = `${Date.now()}-${this.state.seq++}`;
    list.push({ id, fields });
    this.state.streams.set(key, list);
    return id;
  }

  async xgroup(...args: Array<string | number>) {
    const key = `${args[1]}|${args[2]}`;
    if (this.state.groups.has(key)) throw new Error('BUSYGROUP Consumer Group name already exists');
    this.state.groups.set(key, { last: 0, pending: new Map() });
    return 'OK';
  }

  async xreadgroup(...args: Array<string | number>) {
    const group = String(args[1]);
    const block = Number(args[args.indexOf('BLOCK') + 1]);
    const count = Number(args[args.indexOf('COUNT') + 1]);
    const stream = String(args[args.indexOf('STREAMS') + 1]);
    const deadline = Date.now() + block;
    for (;;) {
      this.#check();
      const g = this.state.groups.get(`${stream}|${group}`)!;
      const list = this.state.streams.get(stream) ?? [];
      const fresh = list.slice(g.last, g.last + count);
      if (fresh.length) {
        g.last += fresh.length;
        for (const e of fresh) g.pending.set(e.id, Date.now());
        return [[stream, fresh.map((e) => [e.id, e.fields])]];
      }
      if (Date.now() >= deadline) return null;
      await tick();
    }
  }

  async xautoclaim(...args: Array<string | number>) {
    const [stream, group, , idle] = args;
    const g = this.state.groups.get(`${stream}|${group}`)!;
    const list = this.state.streams.get(String(stream)) ?? [];
    const claimed = [...g.pending]
      .filter(([, at]) => Date.now() - at >= Number(idle))
      .map(([id]) => {
        g.pending.set(id, Date.now());
        const e = list.find((x) => x.id === id)!;
        return [e.id, e.fields];
      });
    return ['0-0', claimed];
  }

  async xack(...args: Array<string | number>) {
    this.state.groups.get(`${args[0]}|${args[1]}`)!.pending.delete(String(args[2]));
    return 1;
  }

  async get(key: string) {
    this.#check();
    return this.state.keys.get(key) ?? null;
  }

  async set(...args: Array<string | number>) {
    this.state.keys.set(String(args[0]), String(args[1]));
    return 'OK';
  }

  async exists(key: string) {
    return this.state.keys.has(key) ? 1 : 0;
  }

  async publish(channel: string, message: string) {
    for (const sub of this.state.subscribers) sub.#deliver(channel, message);
    return 1;
  }

  #deliver(channel: string, message: string) {
    if (!this.#channels.has(channel)) return;
    for (const fn of this.#handlers) fn(channel, message);
  }

  async ping() {
    this.#check();
    return 'PONG';
  }

  duplicate(): FakeRedis {
    return new FakeRedis(this.state);
  }

  async subscribe(channel: string) {
    this.#channels.add(channel);
    this.state.subscribers.add(this);
    return 1;
  }

  on(_event: 'message', listener: (channel: string, message: string) => void) {
    this.#handlers.push(listener);
    return this;
  }

  async quit() {
    this.state.subscribers.delete(this);
    return 'OK';
  }

  stream(key: string): Entry[] {
    return this.state.streams.get(key) ?? [];
  }
}

/** `@adonisjs/queue` in memory: jobs run right after dispatch, retried up to `maxRetries`. */
export function fakeQueue() {
  const jobs: Record<string, new () => { execute(): Promise<void> }> = {};
  const failed: Array<{ name: string; payload: unknown; error: string }> = [];
  const completed: unknown[] = [];
  const pending: Promise<void>[] = [];
  abstract class Job {
    payload: unknown;
    context = { jobId: '', attempt: 1 };
    static options: { name: string; maxRetries: number };
    static dispatchMany(this: never, payloads: unknown[]) {
      const Cls = this as unknown as (new () => Job & { execute(): Promise<void> }) & {
        options: { name: string; maxRetries: number };
      };
      return {
        async run() {
          for (const payload of payloads) {
            pending.push(
              (async () => {
                await tick(1);
                for (let attempt = 1; attempt <= Cls.options.maxRetries + 1; attempt++) {
                  const job = new Cls();
                  job.payload = JSON.parse(JSON.stringify(payload));
                  job.context = { jobId: `j${attempt}`, attempt };
                  try {
                    await job.execute();
                    completed.push(payload);
                    return;
                  } catch (error) {
                    if (attempt === Cls.options.maxRetries + 1)
                      failed.push({
                        name: Cls.options.name,
                        payload,
                        error: (error as Error).message,
                      });
                  }
                }
              })(),
            );
          }
        },
      };
    }
  }
  const peer: QueuePeer = {
    Job: Job as never,
    Locator: {
      register(name, cls) {
        jobs[name] = cls as never;
      },
    },
    exponentialBackoff: () => () => 0,
  };
  return { peer, jobs, failed, completed, settle: () => Promise.all(pending.splice(0)) };
}

/** `bullmq` in memory: added jobs go to the worker of the same queue name. */
export function fakeBullMQ() {
  class UnrecoverableError extends Error {}
  const workers = new Map<
    string,
    (job: { data: unknown; attemptsMade: number }) => Promise<unknown>
  >();
  const failed: Array<{ data: unknown; error: string; unrecoverable: boolean }> = [];
  const added: Array<{ name: string; data: unknown; options: Record<string, unknown> }> = [];
  const pending: Promise<void>[] = [];
  const ids = new Set<string>();
  const peer: BullMQPeer = {
    Queue: class {
      constructor(private readonly name: string) {}
      async add(name: string, data: unknown, options: Record<string, unknown> = {}) {
        const id = String(options.jobId);
        if (ids.has(id)) return; // BullMQ ignores a duplicate jobId
        ids.add(id);
        added.push({ name, data, options });
        const queue = this.name;
        pending.push(
          (async () => {
            await tick(1);
            const attempts = Number(options.attempts ?? 1);
            for (let made = 0; made < attempts; made++) {
              try {
                await workers.get(queue)!({
                  data: JSON.parse(JSON.stringify(data)),
                  attemptsMade: made,
                });
                return;
              } catch (error) {
                const unrecoverable = error instanceof UnrecoverableError;
                if (unrecoverable || made === attempts - 1) {
                  failed.push({ data, error: (error as Error).message, unrecoverable });
                  return;
                }
              }
            }
          })(),
        );
      }
      async waitUntilReady() {}
      async close() {}
    },
    Worker: class {
      constructor(
        name: string,
        processor: (job: { data: unknown; attemptsMade: number }) => Promise<unknown>,
      ) {
        workers.set(name, processor);
      }
      async close() {}
    },
    UnrecoverableError,
  };
  return { peer, failed, added, settle: () => Promise.all(pending.splice(0)) };
}

/** A durable engine shared by a tenant and a control-plane: runs workflows inline. */
export function fakeDurable() {
  const workflows = new Map<string, (ctx: unknown, input: never) => Promise<unknown>>();
  const runs = new Map<
    string,
    Promise<{ status: string; output?: unknown; error?: { message: string } }>
  >();
  const engine: DurableTenantEngine = {
    register(name, _version, fn) {
      workflows.set(name, fn);
    },
    async start(workflow, input, runId) {
      if (runs.has(runId)) return;
      const fn = workflows.get(workflow);
      runs.set(
        runId,
        (async () => {
          await tick(1);
          if (!fn) return { status: 'failed', error: { message: 'unknown workflow' } };
          try {
            return {
              status: 'completed',
              output: await fn({}, JSON.parse(JSON.stringify(input)) as never),
            };
          } catch (error) {
            return { status: 'failed', error: { message: (error as Error).message } };
          }
        })(),
      );
    },
    async waitForRun(runId) {
      return runs.get(runId)!;
    },
  };
  const handlers: Array<(msg: { kind: string }) => void> = [];
  const broadcast: DurableBroadcast & { published: unknown[] } = {
    published: [],
    async publishControl(msg) {
      broadcast.published.push(msg);
      for (const h of handlers) h(JSON.parse(JSON.stringify(msg)));
    },
    onControl(handler) {
      handlers.push(handler);
    },
  };
  return { engine, broadcast, runs, settle: () => Promise.all(runs.values()) };
}
