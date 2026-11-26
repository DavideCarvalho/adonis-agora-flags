import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * The Redis channel the federated console talks to another app over: the console publishes a
 * command on `<prefix>-flags-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-flags-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-flags-console-reply`. Same design as `@adonis-agora/durable`'s console commands, on
 * channels of its own (`-flags-`), so both can share an app's prefix.
 *
 * Every message is authenticated with a secret both apps share (`consoleCommands.secret` on the
 * owning app, `controlPlane.secret` on the console's `apps` entry): an HMAC-SHA256 over the exact
 * payload and the channel it travels on. A command or an answer without a valid MAC is dropped, a
 * command older than {@link COMMAND_MAX_AGE_MS} is refused, and a command id runs once (the claim
 * key), so whoever can publish on the Redis but lacks the secret can neither run nor replay a
 * command, nor forge an answer.
 */

/** The shortest shared secret accepted. */
export const CONSOLE_SECRET_MIN_LENGTH = 16;
/** How old (or how far in the future) a command or answer may be. */
export const COMMAND_MAX_AGE_MS = 60_000;

/** The boot error of a `consoleCommands` without a usable secret. */
export const CONSOLE_SECRET_REQUIRED =
  '[flags] consoleCommands.secret is required (at least 16 characters, e.g. env.get("FLAGS_CONSOLE_SECRET")): console commands are authenticated with it. Set the same value as controlPlane.secret in the console app\'s flags_dashboard.ts apps entry.';

/** A secret given as a string or as an AdonisJS `Secret` (`.release()`). */
export type ConsoleSecret = string | { release(): unknown };

/** The secret as a string, or `undefined` when missing or shorter than the minimum. */
export function consoleSecretOf(value: unknown): string | undefined {
  let secret: unknown = value;
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { release?: unknown }).release === 'function'
  ) {
    try {
      secret = (value as { release(): unknown }).release();
    } catch {
      return undefined;
    }
  }
  return typeof secret === 'string' && secret.length >= CONSOLE_SECRET_MIN_LENGTH
    ? secret
    : undefined;
}

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface FlagsConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console: the owning app writes it to its audit log. */
  actor?: { id: string; name?: string; anonymous?: boolean } | undefined;
}

/** The owning app's answer to a {@link FlagsConsoleCommand}. */
export type FlagsConsoleReply =
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } };

/** An `ioredis` client: pub/sub needs a dedicated connection, made with `duplicate()`. */
export interface IoredisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  duplicate(): IoredisSubscriberLike;
}

export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(): void;
}

/** An `@adonisjs/redis` connection: it keeps its own subscriber and hands each payload over. */
export interface AdonisRedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export type RedisLike = IoredisLike | AdonisRedisLike;

/** How long a command waits for its answer by default. */
export const FLAGS_CONSOLE_TIMEOUT_MS = 15_000;
/** How long the claim on a command lives (longer than any answer is waited for). */
const CLAIM_TTL_MS = 120_000;

function isIoredis(client: RedisLike): client is IoredisLike {
  return typeof (client as IoredisLike).duplicate === 'function';
}

/** `SET key value PX ttl NX` on either client: `'OK'` for the one caller that wins the key. */
function claimOf(
  client: RedisLike,
): ((key: string, value: string) => Promise<unknown>) | undefined {
  const target =
    typeof client.set === 'function'
      ? client
      : (client as { ioConnection?: { set?: IoredisLike['set'] } }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CLAIM_TTL_MS, 'NX');
}

/** A command the owning app refused or failed, or that nobody answered. */
export class FlagsConsoleChannelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'FlagsConsoleChannelError';
    this.code = code;
  }
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  readonly #pending = new Map<string, (reply: FlagsConsoleReply) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  readonly #secret: string;
  #answering = false;
  #closed = false;

  constructor(options: { client: RedisLike; prefix: string; secret: ConsoleSecret }) {
    if (!options.prefix)
      throw new Error('[@adonis-agora/flags] console channel: prefix is required');
    const secret = consoleSecretOf(options.secret);
    if (secret === undefined) {
      throw new Error(
        `[@adonis-agora/flags] console channel "${options.prefix}": a shared secret of at least ${CONSOLE_SECRET_MIN_LENGTH} characters is required (\`consoleCommands.secret\` in the app's config/flags.ts, and the same value as \`controlPlane.secret\` in the console's flags_dashboard.ts apps entry)`,
      );
    }
    this.#client = options.client;
    this.prefix = options.prefix;
    this.#secret = secret;
  }

  #mac(channel: string, payload: string): Buffer {
    return createHmac('sha256', this.#secret).update(`${channel}\n${payload}`).digest();
  }

  /** `body` with a timestamp, MAC'd for `channel`. */
  #seal(channel: string, body: Record<string, unknown>): string {
    const p = JSON.stringify({ ...body, ts: Date.now() });
    return JSON.stringify({ v: 1, p, mac: this.#mac(channel, p).toString('base64') });
  }

  /**
   * The body of a message sealed for `channel` with this secret and still fresh, or a reason it is
   * not. Never throws.
   */
  #open(channel: string, message: string): { body: Record<string, unknown> } | { refused: string } {
    try {
      const envelope = JSON.parse(message) as { v?: unknown; p?: unknown; mac?: unknown };
      if (
        !envelope ||
        typeof envelope !== 'object' ||
        typeof envelope.p !== 'string' ||
        typeof envelope.mac !== 'string'
      ) {
        return { refused: 'not authenticated' };
      }
      const expected = this.#mac(channel, envelope.p);
      const given = Buffer.from(envelope.mac, 'base64');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { refused: 'bad MAC (is the secret the same on both apps?)' };
      }
      const body = JSON.parse(envelope.p) as Record<string, unknown>;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return { refused: 'malformed' };
      const ts = body.ts;
      if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > COMMAND_MAX_AGE_MS) {
        return { refused: 'stale or replayed' };
      }
      return { body };
    } catch {
      return { refused: 'malformed' };
    }
  }

  get commandChannel(): string {
    return `${this.prefix}-flags-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-flags-console-reply`;
  }

  /** Subscribe `handler` to `channel`; resolves once the subscription is in place. */
  async #subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    const client = this.#client;
    if (isIoredis(client)) {
      if (!this.#subscriber) {
        const sub = client.duplicate();
        this.#subscriber = sub;
        sub.on('message', (ch, payload) => this.#handlers.get(ch)?.(payload));
      }
      this.#handlers.set(channel, handler);
      await this.#subscriber.subscribe(channel);
      return;
    }
    await client.subscribe(channel, handler);
    this.#subscriptions.push(() => void client.unsubscribe?.(channel));
  }

  /**
   * Send `command` to the owning app and wait for its answer. Rejects at once when no instance
   * listens (`PUBLISH` reached nobody) and after `timeoutMs` when nobody answers.
   */
  async send(
    command: FlagsConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<FlagsConsoleReply> {
    if (this.#closed) throw new FlagsConsoleChannelError('console channel closed', APP_UNREACHABLE);
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        // An answer that is not sealed with the shared secret is ignored: a forged reply cannot
        // settle a pending command.
        const opened = this.#open(this.replyChannel, payload);
        if (!('body' in opened)) return;
        const { ts: _ts, ...reply } = opened.body;
        if (typeof reply.id !== 'string') return;
        this.#pending.get(reply.id)?.(reply as unknown as FlagsConsoleReply);
      });
      this.#replies = replies;
      // A failed subscribe (a Redis blip) is retried by the next send, not kept for good.
      replies.catch(() => {
        if (this.#replies === replies) this.#replies = undefined;
      });
    }
    try {
      await this.#replies;
    } catch (error) {
      throw new FlagsConsoleChannelError(
        `could not subscribe to the "${this.prefix}" app's console replies: ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    const timeoutMs = options.timeoutMs ?? FLAGS_CONSOLE_TIMEOUT_MS;
    return new Promise<FlagsConsoleReply>((resolve, reject) => {
      const fail = (message: string) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(new FlagsConsoleChannelError(message, APP_UNREACHABLE));
      };
      const timer = setTimeout(
        () =>
          fail(
            `no instance of the "${this.prefix}" app answered the flags console command ${command.verb} within ${timeoutMs}ms`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply) => {
        clearTimeout(timer);
        this.#pending.delete(command.id);
        resolve(reply);
      });
      const sealed = this.#seal(this.commandChannel, {
        id: command.id,
        verb: command.verb,
        args: command.args,
        ...(command.actor !== undefined ? { actor: command.actor } : {}),
      });
      this.#client.publish(this.commandChannel, sealed).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for flags console commands (is it up, with \`consoleCommands\` in config/flags.ts?)`,
            );
          }
        },
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Answer the commands other apps' consoles send this app. Every instance subscribes; the one that
   * wins `SET <prefix>-flags-console-claim:<id> NX` runs the command and publishes the answer, so a
   * command runs once however many processes the app has. Throws when the client cannot run that
   * `SET`: a command never runs without the claim.
   */
  async answer(
    handler: (command: FlagsConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so flags console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      void this.#run(payload, instance, claim, handler).catch((error) => options.onError?.(error));
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: FlagsConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    const opened = this.#open(this.commandChannel, payload);
    if (!('body' in opened)) {
      throw new Error(`dropped a flags console command on "${this.prefix}": ${opened.refused}`);
    }
    const { ts: _ts, ...body } = opened.body;
    const command = body as unknown as FlagsConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return;
    if ((await claim(`${this.prefix}-flags-console-claim:${command.id}`, instance)) !== 'OK')
      return;
    let reply: FlagsConsoleReply;
    try {
      const data = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
      });
      // `undefined` (an action with no answer) travels as `null`.
      reply = { id: command.id, ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    await this.#client.publish(
      this.replyChannel,
      this.#seal(this.replyChannel, reply as unknown as Record<string, unknown>),
    );
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle({
        id,
        ok: false,
        error: { message: 'console channel closed', code: APP_UNREACHABLE },
      });
    }
    this.#pending.clear();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#subscriber?.disconnect?.();
    this.#subscriber = undefined;
  }
}
