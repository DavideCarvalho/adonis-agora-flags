import { randomUUID } from 'node:crypto';
import type { Ruleset } from '@adonis-agora/flags-core';
import { consume, sleep } from './common.js';
import {
  byteLength,
  createMessage,
  DEFAULT_MAX_MESSAGE_BYTES,
  type MessageDedupe,
} from './message.js';
import type {
  ControlPlaneLink,
  ControlPlaneLinkContext,
  RulesetChannel,
  RulesetChannelListener,
  TenantLinkContext,
  TenantPush,
  WatchTransport,
} from './types.js';

/** The ioredis commands this driver uses (what an `@adonisjs/redis` connection's `ioConnection` has). */
export interface TenantRedisClient {
  xadd(...args: Array<string | number>): Promise<unknown>;
  xgroup(...args: Array<string | number>): Promise<unknown>;
  xreadgroup(...args: Array<string | number>): Promise<unknown>;
  xautoclaim(...args: Array<string | number>): Promise<unknown>;
  xack(...args: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(...args: Array<string | number>): Promise<unknown>;
  exists(key: string): Promise<number>;
  publish(channel: string, message: string): Promise<unknown>;
  ping(): Promise<unknown>;
  duplicate(): TenantRedisClient;
  subscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  quit(): Promise<unknown>;
}

export interface RedisTenantTransportOptions {
  /** Connection from `config/redis.ts`. Default: the default connection. */
  connection?: string;
  /** A ready ioredis client instead of `connection` (outside AdonisJS, tests). */
  client?: unknown;
  /** Key prefix, the same on both sides. Default `agora:flags:tenants`. */
  prefix?: string;
  /** Approximate cap on the inbox stream (`XADD MAXLEN ~`). Default 1,000,000. */
  maxLength?: number;
  /** Largest message accepted (bytes). Default 1 MiB. */
  maxMessageBytes?: number;
  /** Tenant: how often it re-announces itself for ruleset updates (ms). Default 60000. */
  refreshMs?: number;
  /** Control-plane: deliveries before a failing message is dead-lettered. Default 5. */
  maxAttempts?: number;
  /** Control-plane: a message pending longer than this is reclaimed from a dead consumer (ms). Default 60000. */
  claimIdleMs?: number;
}

/** The keys both sides agree on. */
export function redisKeys(prefix = 'agora:flags:tenants') {
  return {
    inbox: `${prefix}:inbox`,
    dead: `${prefix}:dead`,
    group: 'flags-control-plane',
    changed: `${prefix}:changed`,
    ruleset: (partition: string) => `${prefix}:ruleset:${partition}`,
    seen: (key: string) => `${prefix}:seen:${key}`,
  };
}

const SNAPSHOT_TTL_SECONDS = 7 * 24 * 3600;

async function client(
  options: RedisTenantTransportOptions,
  ctx: { redis(connection?: string): Promise<unknown> },
): Promise<TenantRedisClient> {
  return (options.client ?? (await ctx.redis(options.connection))) as TenantRedisClient;
}

class RedisPush implements TenantPush {
  readonly driver = 'redis';
  readonly maxBytes: number;
  constructor(
    private readonly redis: TenantRedisClient,
    private readonly ctx: TenantLinkContext,
    private readonly options: RedisTenantTransportOptions,
  ) {
    this.maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  async send(kind: 'events' | 'usage' | 'declarations', body: unknown): Promise<void> {
    await xaddMessage(this.redis, this.ctx, this.options, kind, body);
  }

  async check(): Promise<void> {
    await this.redis.ping();
  }
}

async function xaddMessage(
  redis: TenantRedisClient,
  ctx: TenantLinkContext,
  options: RedisTenantTransportOptions,
  kind: 'events' | 'usage' | 'declarations' | 'ruleset',
  body: unknown,
) {
  const message = createMessage(kind, ctx.partition, await ctx.token.get(), body);
  const json = JSON.stringify(message);
  const max = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  if (byteLength(json) > max) throw new Error(`[flags] message exceeds ${max} bytes`);
  await redis.xadd(
    redisKeys(options.prefix).inbox,
    'MAXLEN',
    '~',
    options.maxLength ?? 1_000_000,
    '*',
    'm',
    json,
  );
}

/**
 * The ruleset over Redis: the control-plane keeps this partition's ruleset under a key (written
 * only for a verified token) and publishes "changed" on a channel; the tenant reads the key.
 */
class RedisRulesetChannel implements RulesetChannel {
  readonly driver = 'redis';
  #announcedAt = 0;
  readonly #keys: ReturnType<typeof redisKeys>;

  constructor(
    private readonly redis: TenantRedisClient,
    private readonly ctx: TenantLinkContext,
    private readonly options: RedisTenantTransportOptions,
  ) {
    this.#keys = redisKeys(options.prefix);
  }

  /** Asks the control-plane to (re)write this partition's ruleset key and keep it current. */
  async #announce(force = false) {
    const refresh = this.options.refreshMs ?? 60_000;
    if (!force && Date.now() - this.#announcedAt < refresh) return;
    this.#announcedAt = Date.now();
    await xaddMessage(this.redis, this.ctx, this.options, 'ruleset', {
      capabilities: this.ctx.capabilities ?? [],
    });
  }

  async fetch(knownVersion: string | undefined): Promise<Ruleset | null> {
    const first = this.#announcedAt === 0;
    await this.#announce();
    const key = this.#keys.ruleset(this.ctx.partition);
    let raw = await this.redis.get(key);
    // First boot: give the control-plane a moment to answer the announcement.
    for (let i = 0; first && raw === null && i < 20; i++) {
      await sleep(100);
      raw = await this.redis.get(key);
    }
    if (raw === null) throw new Error('no ruleset published for this partition yet');
    const ruleset = JSON.parse(raw) as Ruleset;
    return knownVersion !== undefined && ruleset.version === knownVersion ? null : ruleset;
  }

  subscribe(listener: RulesetChannelListener): () => void {
    const sub = this.redis.duplicate();
    let stopped = false;
    sub.on('message', (channel, payload) => {
      if (channel !== this.#keys.changed) return;
      try {
        const { partition } = JSON.parse(payload) as { partition?: string };
        if (partition === this.ctx.partition) listener.changed();
      } catch {
        // not ours
      }
    });
    sub.subscribe(this.#keys.changed).then(
      () => !stopped && listener.connected(true),
      (error: unknown) => listener.error(error),
    );
    // Keep the announcement fresh (a new token, a restarted control-plane).
    const timer = setInterval(
      () => void this.#announce(true).catch((error) => listener.error(error)),
      this.options.refreshMs ?? 60_000,
    );
    timer.unref();
    return () => {
      stopped = true;
      clearInterval(timer);
      listener.connected(false);
      void sub.quit().catch(() => {});
    };
  }

  async check(): Promise<void> {
    await this.redis.ping();
  }
}

type StreamReply = Array<[stream: string, entries: Array<[id: string, fields: string[]]>]> | null;

class RedisDedupe implements MessageDedupe {
  constructor(
    private readonly redis: TenantRedisClient,
    private readonly keys: ReturnType<typeof redisKeys>,
  ) {}
  async seen(key: string) {
    return (await this.redis.exists(this.keys.seen(key))) === 1;
  }
  async mark(key: string) {
    await this.redis.set(this.keys.seen(key), '1', 'EX', 24 * 3600);
  }
}

/** Control-plane side: consumes the inbox stream and maintains the per-partition ruleset keys. */
export class RedisControlPlaneLink implements ControlPlaneLink {
  readonly driver = 'redis';
  readonly #keys: ReturnType<typeof redisKeys>;
  readonly #consumer = `cp-${randomUUID().slice(0, 8)}`;
  readonly #dedupe: RedisDedupe;
  #reader: TenantRedisClient | undefined;
  #stopped = false;
  #loop: Promise<void> | undefined;
  #attempts = new Map<string, number>();
  /** partition → its verified environment. */
  #partitions = new Map<string, string>();
  #watching = new Map<string, () => void>();

  constructor(
    private readonly redis: TenantRedisClient,
    private readonly ctx: ControlPlaneLinkContext,
    private readonly options: RedisTenantTransportOptions,
  ) {
    this.#keys = redisKeys(options.prefix);
    this.#dedupe = new RedisDedupe(redis, this.#keys);
  }

  async start(): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', this.#keys.inbox, this.#keys.group, '0', 'MKSTREAM');
    } catch (error) {
      if (!String((error as Error).message).includes('BUSYGROUP')) throw error;
    }
    // XREADGROUP BLOCK holds its connection: give it its own.
    this.#reader = this.redis.duplicate();
    this.#loop = this.#run();
  }

  async #run() {
    let lastClaim = 0;
    while (!this.#stopped) {
      try {
        const now = Date.now();
        if (now - lastClaim > 10_000) {
          lastClaim = now;
          await this.#reclaim();
        }
        const reply = (await this.#reader!.xreadgroup(
          'GROUP',
          this.#keys.group,
          this.#consumer,
          'COUNT',
          100,
          'BLOCK',
          1000,
          'STREAMS',
          this.#keys.inbox,
          '>',
        )) as StreamReply;
        for (const [, entries] of reply ?? []) {
          for (const [id, fields] of entries) await this.process(id, fields);
        }
      } catch (error) {
        if (this.#stopped) break;
        this.ctx.logger?.warn(`[flags] redis tenant inbox: ${(error as Error).message}`);
        await sleep(1000);
      }
    }
  }

  async #reclaim() {
    const reply = (await this.redis.xautoclaim(
      this.#keys.inbox,
      this.#keys.group,
      this.#consumer,
      this.options.claimIdleMs ?? 60_000,
      '0',
      'COUNT',
      100,
    )) as [string, Array<[string, string[]] | null>] | null;
    for (const entry of reply?.[1] ?? []) {
      if (entry) await this.process(entry[0], entry[1]);
    }
  }

  /** Handles one stream entry. Acks it when applied or dead-lettered; leaves it pending otherwise. */
  async process(id: string, fields: string[]): Promise<void> {
    const raw = fields[fields.indexOf('m') + 1];
    const attempt = (this.#attempts.get(id) ?? 0) + 1;
    this.#attempts.set(id, attempt);
    try {
      const handled = await consume(this.ctx.handler, 'redis', raw, {
        dedupe: this.#dedupe,
        attempt,
        maxAttempts: this.options.maxAttempts ?? 5,
        onDead: async (error) => {
          await this.redis.xadd(
            this.#keys.dead,
            'MAXLEN',
            '~',
            100_000,
            '*',
            'm',
            raw ?? '',
            'error',
            error.message,
          );
        },
      });
      if (handled?.message.kind === 'ruleset' && handled.ruleset) {
        await this.#track(handled.verified.partition, handled.environment, handled.ruleset);
      }
      await this.redis.xack(this.#keys.inbox, this.#keys.group, id);
      this.#attempts.delete(id);
    } catch (error) {
      this.ctx.logger?.warn(
        `[flags] redis tenant message ${id} failed (attempt ${attempt}): ${(error as Error).message}`,
      );
    }
  }

  async #track(partition: string, environment: string, ruleset: Ruleset) {
    this.#partitions.set(partition, environment);
    await this.#write(partition, ruleset);
    if (!this.#watching.has(environment)) {
      this.#watching.set(
        environment,
        this.ctx.handler.watchEnvironment(environment, (next) => {
          for (const [p, env] of this.#partitions) {
            if (env !== environment) continue;
            void this.#write(p, next).catch((error) =>
              this.ctx.logger?.warn(`[flags] redis ruleset publish: ${(error as Error).message}`),
            );
          }
        }),
      );
    }
  }

  async #write(partition: string, ruleset: Ruleset) {
    await this.redis.set(
      this.#keys.ruleset(partition),
      JSON.stringify(ruleset),
      'EX',
      SNAPSHOT_TTL_SECONDS,
    );
    await this.redis.publish(
      this.#keys.changed,
      JSON.stringify({ partition, version: ruleset.version }),
    );
  }

  async check(): Promise<void> {
    await this.redis.ping();
  }

  async close(): Promise<void> {
    this.#stopped = true;
    for (const stop of this.#watching.values()) stop();
    this.#watching.clear();
    await this.#loop;
    await this.#reader?.quit().catch(() => {});
  }
}

/**
 * Events through a Redis stream the control-plane consumes; the ruleset through a per-partition key
 * plus pub/sub. Needs `@adonisjs/redis` (or `client`).
 */
export function redisTransport(options: RedisTenantTransportOptions = {}): WatchTransport {
  return {
    driver: 'redis',
    canWatch: true,
    async push(ctx) {
      return new RedisPush(await client(options, ctx), ctx, options);
    },
    async watch(ctx) {
      return new RedisRulesetChannel(await client(options, ctx), ctx, options);
    },
    async serve(ctx) {
      const link = new RedisControlPlaneLink(await client(options, ctx), ctx, options);
      await link.start();
      return link;
    },
  };
}
