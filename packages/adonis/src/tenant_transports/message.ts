import { randomUUID } from 'node:crypto';

/** What a tenant sends to its control-plane over a broker. */
export type TenantMessageKind =
  | 'events'
  | 'usage'
  | 'declarations'
  /** Watch: "send me my ruleset (and keep me posted)". The body carries the version the tenant has. */
  | 'ruleset';

export const TENANT_MESSAGE_KINDS: readonly TenantMessageKind[] = [
  'events',
  'usage',
  'declarations',
  'ruleset',
];

/**
 * One tenant → control-plane message. Every broker driver carries exactly this JSON. The token is
 * verified on every message: `partition` is only the claim a shared-secret verifier needs, the
 * verified token decides the partition, environment and capabilities.
 */
export interface TenantMessage {
  v: 1;
  /** Unique per message; the control-plane dedupes on `<verified partition>:<id>`. */
  id: string;
  kind: TenantMessageKind;
  partition: string;
  token: string;
  /** Epoch ms. */
  sentAt: number;
  body: unknown;
}

/** Default cap on one serialized message (1 MiB). */
export const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

/**
 * A message that will never succeed (malformed, too big, refused token, missing capability). The
 * control-plane dead-letters it instead of retrying it.
 */
export class PoisonMessageError extends Error {
  readonly poison = true;
  constructor(
    message: string,
    /** `unauthorized` | `forbidden` | `invalid` | `too_large` */
    readonly reason: 'unauthorized' | 'forbidden' | 'invalid' | 'too_large',
  ) {
    super(message);
    this.name = 'PoisonMessageError';
  }
}

export function isPoison(error: unknown): error is PoisonMessageError {
  return !!error && typeof error === 'object' && (error as { poison?: unknown }).poison === true;
}

export function createMessage(
  kind: TenantMessageKind,
  partition: string,
  token: string,
  body: unknown,
): TenantMessage {
  return { v: 1, id: randomUUID(), kind, partition, token, sentAt: Date.now(), body };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Parses a raw broker payload (a JSON string or an already-decoded object) into a message, refusing
 * anything bigger than `maxBytes` or not shaped like a message.
 */
export function decodeMessage(raw: unknown, maxBytes = DEFAULT_MAX_MESSAGE_BYTES): TenantMessage {
  let value = raw;
  if (typeof raw === 'string') {
    if (byteLength(raw) > maxBytes)
      throw new PoisonMessageError(`message exceeds ${maxBytes} bytes`, 'too_large');
    try {
      value = JSON.parse(raw);
    } catch {
      throw new PoisonMessageError('message is not JSON', 'invalid');
    }
  } else {
    let size: number;
    try {
      size = byteLength(JSON.stringify(raw) ?? '');
    } catch {
      throw new PoisonMessageError('message is not serializable', 'invalid');
    }
    if (size > maxBytes)
      throw new PoisonMessageError(`message exceeds ${maxBytes} bytes`, 'too_large');
  }
  const m = value as Partial<TenantMessage> | null;
  if (
    !m ||
    typeof m !== 'object' ||
    m.v !== 1 ||
    typeof m.id !== 'string' ||
    !m.id ||
    m.id.length > 200 ||
    typeof m.kind !== 'string' ||
    !TENANT_MESSAGE_KINDS.includes(m.kind as TenantMessageKind) ||
    typeof m.partition !== 'string' ||
    m.partition.length > 200 ||
    typeof m.token !== 'string' ||
    !m.token
  ) {
    throw new PoisonMessageError('not a flags tenant message', 'invalid');
  }
  return m as TenantMessage;
}

/** Remembers handled message ids so a redelivered message is applied once. */
export interface MessageDedupe {
  /** True when `key` was already handled. */
  seen(key: string): Promise<boolean>;
  /** Records `key` as handled. */
  mark(key: string): Promise<void>;
}

/** In-process dedupe: the most recent `max` keys for `ttlMs`. */
export class MemoryDedupe implements MessageDedupe {
  #keys = new Map<string, number>();
  constructor(
    private readonly max = 100_000,
    private readonly ttlMs = 24 * 3600_000,
  ) {}

  async seen(key: string): Promise<boolean> {
    const at = this.#keys.get(key);
    if (at === undefined) return false;
    if (Date.now() - at > this.ttlMs) {
      this.#keys.delete(key);
      return false;
    }
    return true;
  }

  async mark(key: string): Promise<void> {
    this.#keys.delete(key);
    this.#keys.set(key, Date.now());
    while (this.#keys.size > this.max) {
      const oldest = this.#keys.keys().next().value as string;
      this.#keys.delete(oldest);
    }
  }
}

/** A message the control-plane gave up on, handed to `controlPlane.onDeadLetter`. */
export interface DeadLetter {
  driver: string;
  /** The message id, when it could be read. */
  id?: string | undefined;
  kind?: string | undefined;
  /** The claimed partition (unverified). */
  partition?: string | undefined;
  reason: string;
  error: string;
  at: string;
}
