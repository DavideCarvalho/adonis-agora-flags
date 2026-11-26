import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type OkpJwk, openWith, sealTo } from '../crypto-kit/index.js';
import { resolveTenantToken, type TenantTokenSource } from '../topology/token.js';
import {
  resolveTenantVerifier,
  type TenantVerifierOption,
  type VerifiedTenant,
} from '../topology/verify.js';

/**
 * The Redis channel the federated console talks to another app over: the console publishes a
 * command on `<prefix>-flags-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-flags-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-flags-console-reply`. Same design as `@adonis-agora/durable`'s and
 * `@adonis-agora/config`'s console commands, on channels of its own (`-flags-`), so all of them can
 * share an app's prefix. Redis is not a trust boundary: every command is authenticated (see
 * {@link RedisConsoleChannel}).
 */

/** This package's part of the channel names. */
export const CONSOLE_TOPIC = 'flags';
const PACKAGE = `@adonis-agora/${CONSOLE_TOPIC}`;

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface FlagsConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console: the owning app writes it to its audit log. */
  actor?: { id: string; name?: string; anonymous?: boolean } | undefined;
  /**
   * The capabilities the console grants its viewer (the full console set when its `authorize`
   * does not narrow). Always sent: the owning app refuses a command without them. In token mode
   * they only narrow the token's capabilities.
   */
  capabilities?: string[] | undefined;
  /** When it was sent (ms since the epoch): a command older than a minute is refused. */
  ts?: number | undefined;
  /** HMAC of every field above under the pair's shared secret (shared-secret mode). */
  mac?: string | undefined;
  /**
   * Token mode: who the owning app verified the console as (its token's partition and
   * capabilities). Set by the channel after verification, never taken from the wire.
   */
  verified?: ConsoleVerified | undefined;
}

/** Who the owning app verified the console as (token mode). Set by the channel only. */
export interface ConsoleVerified {
  /** The token's partition: the app it is for (service-tenant tokens), or the caller (app calls). */
  partition: string;
  capabilities: string[];
  /**
   * An authkit app-call token (`aud` = this app): its audience already binds it to this app, so
   * `partition` is the calling (console) app and is not compared with this app.
   */
  appCall?: boolean | undefined;
  /** The authkit client the token was issued to, when the verifier says (for the audit). */
  clientId?: string | undefined;
}

/** The owning app's answer to a {@link FlagsConsoleCommand}. */
export type FlagsConsoleReply = (
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } }
) & { mac?: string };

/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ChannelSecret = string | { release(): string };

/** JSON with sorted keys, so both sides MAC the same bytes. */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return 'null';
}

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

function replyFields(reply: FlagsConsoleReply) {
  return [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
}

/**
 * Signs and checks the messages of one channel. Anyone who can publish on the Redis channel can
 * otherwise send a command (with any actor) or answer one: both sides share `secret`, and every
 * command and reply carries an HMAC over its fields, bound to this channel's prefix.
 */
class ChannelSigner {
  readonly #key: Buffer;
  constructor(secret: ChannelSecret, prefix: string) {
    const raw = typeof secret === 'string' ? secret : secret?.release?.();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console channel: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #mac(kind: 'command' | 'reply', fields: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\n${canonicalJson(fields)}`)
      .digest('base64url');
  }

  #commandFields(command: FlagsConsoleCommand) {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.ts ?? null,
    ];
  }

  signCommand(command: FlagsConsoleCommand): FlagsConsoleCommand {
    const { mac: _mac, verified: _verified, ...rest } = command;
    const stamped = { ...rest, ts: Date.now() };
    return { ...stamped, mac: this.#mac('command', this.#commandFields(stamped)) };
  }

  /** `undefined` when the command is signed and fresh, else why not. */
  verifyCommand(command: FlagsConsoleCommand): 'stale' | 'bad signature' | undefined {
    if (!sameMac(this.#mac('command', this.#commandFields(command)), command.mac)) {
      return 'bad signature';
    }
    return fresh(command.ts) ? undefined : 'stale';
  }

  signReply(reply: FlagsConsoleReply): FlagsConsoleReply {
    const { mac: _mac, ...rest } = reply;
    return {
      ...rest,
      mac: this.#mac('reply', replyFields(rest as FlagsConsoleReply)),
    } as FlagsConsoleReply;
  }

  verifyReply(reply: FlagsConsoleReply): boolean {
    return sameMac(this.#mac('reply', replyFields(reply)), reply.mac);
  }
}

/** The owning app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';

/** What one sent command needs from the channel's authentication. */
interface OutgoingMessage {
  wire: unknown;
  verifyReply(reply: FlagsConsoleReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
interface IncomingMessage {
  /** The command to run, or `undefined` when it must be refused with `error`. */
  command?: FlagsConsoleCommand;
  error?: { message: string; code: string; status: number };
  id: string;
  signReply(reply: FlagsConsoleReply): FlagsConsoleReply;
}

interface ChannelAuth {
  /** The mode this receiver accepts, as refusals name it. */
  readonly label?: string;
  wrap?(command: FlagsConsoleCommand): Promise<OutgoingMessage>;
  unwrap?(wire: Record<string, unknown>): Promise<IncomingMessage | null>;
  unauthorized?(): void;
}

/** Shared-secret mode: both sides hold the same secret and HMAC every command and reply. */
class SecretAuth implements ChannelAuth {
  readonly label = 'secret';
  readonly #signer: ChannelSigner;
  constructor(secret: ChannelSecret, prefix: string) {
    this.#signer = new ChannelSigner(secret, prefix);
  }

  async wrap(command: FlagsConsoleCommand): Promise<OutgoingMessage> {
    return {
      wire: this.#signer.signCommand(command),
      verifyReply: (reply) => this.#signer.verifyReply(reply),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as FlagsConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Unsigned, stale (over a minute) or tampered: not from the console that holds the secret. A
    // replay inside the window reuses the id, and the claim (kept 2 minutes) refuses it.
    const refusal = this.#signer.verifyCommand(command);
    if (refusal) throw refused(refusal);
    const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
    return {
      id: command.id,
      command: fields,
      signReply: (reply) => this.#signer.signReply(reply),
    };
  }
}

/**
 * How a sealed command is encrypted: to the app's command key derived from its `APP_KEY`, or with a
 * key of `@adonis-agora/crypto` (the Hub's, or the app's own). Either way only the owning app opens
 * it, and the AAD binds it to this channel and this command id.
 */
export interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/flags.ts` is read before `@adonis-agora/crypto` is
 * ready, so `() => crypto.client!` (or `() => serviceCipher(crypto.service, 'app')`) defers it to
 * the first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/** The `@adonis-agora/crypto` key console commands are sealed with, unless another is named. */
export const CONSOLE_CRYPTO_KEY = 'console-flags';

/** `crypto` of a channel: a cipher, the key, and (for another KMS's format) which ciphertext is its. */
export interface ConsoleCryptoOption {
  cipher: ConsoleCipherSource;
  key?: string | undefined;
  /**
   * Whether a ciphertext is this cipher's. Default: `@adonis-agora/crypto`'s format for the key
   * (`agora:ct1:<key>:`). Set it when the cipher is another service (AWS KMS, Vault transit, an HSM).
   */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** Seals with an `@adonis-agora/crypto` key: whoever may `encrypt` with it sends, the app opens. */
export function cryptoConsoleSealer(options: ConsoleCryptoOption): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console channel: \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command.
    owns: options.owns ?? ((sealed) => sealed.startsWith(`agora:ct1:${key}:`)),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** Seals to the app's X25519 command key: the console side (the app's public key, given to it). */
export function appKeySealerTo(recipient: () => Promise<OkpJwk>): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(await recipient(), plaintext, { aad }),
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** Opens with the app's X25519 command key pair (derived from its `APP_KEY`): the app side. */
export function appKeySealer(keys: { publicKey: OkpJwk; privateKey: OkpJwk }): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith('agora:pk1:'),
    seal: async (plaintext, aad) => sealTo(keys.publicKey, plaintext, { aad }),
    open: async (sealed, aad) => openWith(keys.privateKey, sealed, { aad }),
  };
}

/** The key that MACs the replies to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

function replyMac(key: Buffer, reply: FlagsConsoleReply): string {
  return createHmac('sha256', key)
    .update(`reply\n${canonicalJson(replyFields(reply))}`)
    .digest('base64url');
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to
 * lift and replay, no command to alter. The sealed payload also carries a one-off secret the app
 * MACs its answer with, so a forged answer (from someone who cannot open the command) is ignored.
 */
class SealedSenderAuth implements ChannelAuth {
  readonly #token: ReturnType<typeof resolveTenantToken> | undefined;
  constructor(
    readonly sealer: ConsoleSealer,
    token: TenantTokenSource | undefined,
    readonly prefix: string,
  ) {
    this.#token = token === undefined ? undefined : resolveTenantToken(token);
  }

  async wrap(command: FlagsConsoleCommand): Promise<OutgoingMessage> {
    const token = this.#token ? await this.#token.get() : undefined;
    const secret = randomBytes(32).toString('base64url');
    const { mac: _mac, verified: _verified, ...fields } = command;
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...fields, ts: Date.now() },
        // An optional token that could not be minted comes back empty: the command goes without.
        ...(typeof token === 'string' && token !== '' ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(replyMac(key, reply), reply.mac),
    };
  }

  unauthorized(): void {
    this.#token?.invalidate?.();
  }
}

/**
 * Sealed mode (owning app side): open, check freshness, and verify the token the command carries.
 * With a token, the console's app and capabilities come from it, and a token that does not verify
 * is refused. A command without a token is accepted only when `tokenRequired` is off (crypto mode:
 * whoever may encrypt with the key is the console, like a shared secret).
 */
class SealedReceiverAuth implements ChannelAuth {
  readonly #verify: ReturnType<typeof resolveTenantVerifier> | undefined;
  get label(): string {
    return this.tokenRequired && !this.crypto ? 'token' : 'crypto';
  }
  constructor(
    readonly sealer: ConsoleSealer,
    verifyTenant: TenantVerifierOption | undefined,
    readonly prefix: string,
    readonly partition: string | undefined,
    readonly tokenRequired: boolean,
    readonly crypto: boolean = true,
  ) {
    this.#verify = verifyTenant === undefined ? undefined : resolveTenantVerifier(verifyTenant);
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: FlagsConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw refused("did not open with this app's key");
    }
    const command = payload?.command;
    if (
      !command ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string'
    ) {
      throw refused(
        typeof command?.id !== 'string' ? 'no command id' : "did not open with this app's key",
      );
    }
    if (!fresh(command.ts)) throw refused('stale');
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: FlagsConsoleReply): FlagsConsoleReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: replyMac(key, rest as FlagsConsoleReply) } as FlagsConsoleReply;
    };
    const { mac: _mac, ts: _ts, verified: _claimed, ...fields } = command;
    const hasToken = typeof payload.token === 'string' && payload.token !== '';
    if (!this.#verify || (!hasToken && !this.tokenRequired)) {
      return { id, signReply, command: fields };
    }

    let verified: (VerifiedTenant & { appCall?: unknown; clientId?: unknown }) | null = null;
    try {
      verified = hasToken
        ? await this.#verify({
            token: payload.token as string,
            partition: this.partition,
            tenant: this.partition,
          })
        : null;
    } catch {
      verified = null;
    }
    if (!verified) {
      return {
        id,
        signReply,
        error: {
          message: `the console's token was refused by the "${this.prefix}" app`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    return {
      id,
      signReply,
      command: {
        ...fields,
        verified: {
          partition: verified.partition,
          capabilities: [...verified.capabilities],
          ...(verified.appCall === true ? { appCall: true } : {}),
          ...(typeof verified.clientId === 'string' ? { clientId: verified.clientId } : {}),
        },
      },
    };
  }
}

/** How one channel authenticates: what it sends with, and every way it accepts commands. */
export interface ConsoleChannelAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ChannelSecret | undefined;
  /**
   * Sealed mode with `@adonis-agora/crypto` (or any cipher with `encrypt`/`decrypt`), both sides:
   * the cipher and the key (`console-flags` by default). The console needs `encrypt` on it, the
   * app `decrypt`. `owns` recognizes another service's ciphertext.
   */
  crypto?: ConsoleCryptoOption | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: TenantTokenSource | undefined;
  /** Console side, without `crypto`: the app's command public key (given to the console). */
  recipient?: (() => Promise<OkpJwk>) | undefined;
  /** App side, without `crypto`: this app's command key pair (derived from its `APP_KEY`). */
  keys?: { publicKey: OkpJwk; privateKey: OkpJwk } | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: TenantVerifierOption | undefined;
  /** App side: the partition a console's token is checked for (this app's name). */
  partition?: string | undefined;
  /**
   * App side, with `crypto` and `verifyTenant`: whether a crypto-sealed command must carry a token
   * `verifyTenant` accepts. Default `true`. When `false`, a token is still verified when the command
   * carries one (and refused when it does not verify), but a command without one is accepted. The
   * provider sets `false` when `verifyTenant` was not configured explicitly (a control plane's
   * own, or authkit's app-call verifier).
   */
  cryptoTokenRequired?: boolean | undefined;
}

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

/** `GET key` on either client, when it has one (to tell this instance's replay from a peer's claim). */
function readerOf(client: RedisLike): ((key: string) => Promise<unknown>) | undefined {
  const target =
    typeof (client as { get?: unknown }).get === 'function'
      ? client
      : (client as { ioConnection?: unknown }).ioConnection;
  const get = (target as { get?: (key: string) => Promise<unknown> } | undefined)?.get;
  if (typeof get !== 'function') return undefined;
  return (key) => get.call(target, key);
}

/** A command the owning app refused or failed, or that nobody answered. */
export class FlagsConsoleChannelError extends Error {
  readonly code: string;
  /** Set when the app refused a command: why, in the uniform words (§11b). */
  readonly reason?: string;
  constructor(message: string, code: string, reason?: string) {
    super(message);
    this.name = 'FlagsConsoleChannelError';
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }
}

/** The app refused a command: `[@adonis-agora/flags] console commands: refused a command (…)`. */
export function refused(reason: string): FlagsConsoleChannelError {
  return new FlagsConsoleChannelError(
    `[${PACKAGE}] console commands: refused a command (${reason})`,
    UNSIGNED_CHANNEL,
    reason,
  );
}

/** How a command on the wire came: the mode a refusal names. */
function modeOf(wire: Record<string, unknown>): string {
  if (typeof wire.mac === 'string') return 'secret';
  if (typeof wire.sealed === 'string') {
    return wire.sealed.startsWith('agora:pk1:') ? 'token' : 'crypto';
  }
  return 'unsigned';
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';

/** Token mode: the token the command must carry could not be minted (§13a falls back to crypto). */
export const TOKEN_UNAVAILABLE = 'federated-console-token-unavailable';
/** The channel has no authentication, so it neither sends nor answers commands. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  readonly #pending = new Map<string, (reply: FlagsConsoleReply) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #closed = false;
  /** How commands are sent (one mode). */
  readonly #sender: ChannelAuth | undefined;
  /** How commands are accepted (each configured mode; an app may accept several while migrating). */
  readonly #receivers: ChannelAuth[];

  /**
   * Redis is not a trust boundary, so a channel neither sends nor answers commands without one of:
   *
   * - `crypto` — commands sealed with an `@adonis-agora/crypto` key (the console may encrypt with it,
   *   the app decrypt), optionally with a `token` the app checks with `verifyTenant`;
   * - a `token` sealed to the app's command key (`recipient` / `keys`, from its `APP_KEY`), checked
   *   with `verifyTenant` (authkit, typically);
   * - `secret` — shared by the console and the app (the same value on both sides).
   */
  constructor(options: { client: RedisLike; prefix: string } & ConsoleChannelAuthOptions) {
    if (!options.prefix) throw new Error(`[${PACKAGE}] console channel: prefix is required`);
    this.#client = options.client;
    this.prefix = options.prefix;
    const secret =
      options.secret === undefined ? undefined : new SecretAuth(options.secret, options.prefix);
    const crypto = options.crypto ? cryptoConsoleSealer(options.crypto) : undefined;

    // Sending: crypto when configured, else a token sealed to the app's key, else the secret.
    if (options.token !== undefined && !crypto && !options.recipient) {
      throw new Error(
        `[${PACKAGE}] console channel: a \`token\` needs \`crypto\` or the app's public key (\`recipient\`)`,
      );
    }
    const sendSealer =
      crypto ?? (options.recipient ? appKeySealerTo(options.recipient) : undefined);
    const sealedSender =
      sendSealer && (crypto || options.token !== undefined)
        ? new SealedSenderAuth(sendSealer, options.token, options.prefix)
        : undefined;
    this.#sender = sealedSender ?? secret;

    // Answering: every configured way. Without crypto, sealed commands need a token check.
    const receivers: ChannelAuth[] = [];
    if (crypto) {
      receivers.push(
        new SealedReceiverAuth(
          crypto,
          options.verifyTenant,
          options.prefix,
          options.partition,
          options.cryptoTokenRequired !== false,
        ),
      );
    }
    if (options.keys && options.verifyTenant !== undefined) {
      receivers.push(
        new SealedReceiverAuth(
          appKeySealer(options.keys),
          options.verifyTenant,
          options.prefix,
          options.partition,
          true,
          false,
        ),
      );
    }
    if (secret) receivers.push(secret);
    this.#receivers = receivers;
  }

  /** Whether this channel can send commands (crypto, a token and the app's key, or a secret). */
  get signed(): boolean {
    return this.#sender !== undefined;
  }

  /** Whether this channel can answer commands (at least one way to authenticate them). */
  get answers(): boolean {
    return this.#receivers.length > 0;
  }

  #unsigned(): FlagsConsoleChannelError {
    return new FlagsConsoleChannelError(
      `the "${this.prefix}" ${CONSOLE_TOPIC} console channel has no authentication; use @adonis-agora/crypto (\`crypto\` on both sides), a token (\`token\` + \`publicKey\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
      UNSIGNED_CHANNEL,
    );
  }

  get commandChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console-reply`;
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
   * listens (`PUBLISH` reached nobody) and after `timeoutMs` when nobody answers. Answers that do
   * not authenticate as the app's are ignored.
   */
  async send(
    command: FlagsConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<FlagsConsoleReply> {
    if (this.#closed) throw new FlagsConsoleChannelError('console channel closed', APP_UNREACHABLE);
    const sender = this.#sender;
    if (!sender?.wrap) throw this.#unsigned();
    let outgoing: OutgoingMessage;
    try {
      outgoing = await sender.wrap(command);
    } catch (error) {
      if (error instanceof FlagsConsoleChannelError) throw error;
      throw new FlagsConsoleChannelError(
        `could not prepare the ${CONSOLE_TOPIC} console command for "${this.prefix}": ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        let reply: FlagsConsoleReply;
        try {
          reply = JSON.parse(payload) as FlagsConsoleReply;
        } catch {
          return;
        }
        if (typeof reply?.id !== 'string') return;
        this.#pending.get(reply.id)?.(reply);
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
            `no instance of "${this.prefix}" answered within ${Math.round(timeoutMs / 100) / 10}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
          ),
        timeoutMs,
      );
      timer.unref?.();
      this.#pending.set(command.id, (reply) => {
        // `close()` settles waiting commands with its own (unsigned) answer.
        const local = !reply.ok && reply.error.code === APP_UNREACHABLE && this.#closed;
        // A reply without this command's MAC is someone else's (or forged): wait for the real one.
        if (!local && !outgoing.verifyReply(reply)) return;
        clearTimeout(timer);
        this.#pending.delete(command.id);
        if (!reply.ok && reply.error.code === UNAUTHORIZED_CONSOLE) sender.unauthorized?.();
        resolve(reply);
      });
      this.#client.publish(this.commandChannel, JSON.stringify(outgoing.wire)).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for ${CONSOLE_TOPIC} console commands (is it up, with \`consoleCommands\` in config/${CONSOLE_TOPIC}.ts?)`,
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
   * command runs once however many processes the app has. Throws when the channel has no
   * authentication, or when the client cannot run that `SET`: a command never runs without both.
   */
  async answer(
    handler: (command: FlagsConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    if (this.#receivers.length === 0) throw this.#unsigned();
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so ${CONSOLE_TOPIC} console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      const report = (error: unknown) => {
        try {
          options.onError?.(error);
        } catch {
          // A failing logger never takes the channel down.
        }
      };
      void this.#run(payload, instance, claim, handler, report).catch(report);
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: FlagsConsoleCommand) => Promise<unknown>,
    report: (error: unknown) => void,
  ): Promise<void> {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw refused('not JSON');
    }
    if (!wire || typeof wire !== 'object' || Array.isArray(wire) || typeof wire.id !== 'string') {
      throw refused('no command id');
    }
    let incoming: IncomingMessage | null = null;
    for (const receiver of this.#receivers) {
      incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) break;
    }
    if (!incoming) {
      const accepts = [...new Set(this.#receivers.map((r) => r.label ?? 'unknown'))].join(', ');
      throw refused(
        `mode not accepted here (this app accepts: ${accepts}; the command came as ${modeOf(wire)})`,
      );
    }
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and
    // the claim (kept 2 minutes) refuses it.
    const claimKey = `${this.prefix}-${CONSOLE_TOPIC}-console-claim:${incoming.id}`;
    const claimed = await claim(claimKey, instance);
    if (claimed !== 'OK') {
      // Another instance's claim is the normal case; this instance's own claim is a replay.
      const holder = await readerOf(this.#client)?.(claimKey).catch(() => undefined);
      if (holder === instance) throw refused('replayed');
      return;
    }
    if (!incoming.command) {
      if (incoming.error?.code === UNAUTHORIZED_CONSOLE) report(refused('token refused'));
      await this.#client.publish(
        this.replyChannel,
        JSON.stringify(incoming.signReply({ id: incoming.id, ok: false, error: incoming.error! })),
      );
      return;
    }
    const command = incoming.command;
    let reply: FlagsConsoleReply;
    try {
      const { capabilities, ...rest } = command;
      const data = await handler({
        ...rest,
        args: Array.isArray(command.args) ? command.args : [],
        // Anything but an array of strings is dropped, and the handler refuses a command without
        // capabilities: a malformed list never widens anything.
        ...(Array.isArray(capabilities)
          ? { capabilities: capabilities.filter((c) => typeof c === 'string') }
          : {}),
      });
      // `undefined` (an action with no answer) travels as `null`. The answer is MACed as the
      // console will parse it (dates as strings, no `undefined`), so both sides sign the same.
      reply = {
        id: command.id,
        ok: true,
        data: data === undefined ? null : JSON.parse(JSON.stringify(data)),
      };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      if (code === 'capabilities-required') report(refused('capabilities-required'));
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
    await this.#client.publish(this.replyChannel, JSON.stringify(incoming.signReply(reply)));
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
