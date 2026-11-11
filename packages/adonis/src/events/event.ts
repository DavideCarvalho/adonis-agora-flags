import { createHash, randomBytes } from 'node:crypto';

/** Version of the event contract below. Bumped only for incompatible changes. */
export const EVENT_SCHEMA_VERSION = 1;

/**
 * The one event shape every transport and sink speaks (DESIGN §7). Timestamps are epoch
 * milliseconds so every backend (Postgres, MySQL, SQLite, DuckDB, ClickHouse) compares them as
 * plain numbers.
 */
export interface FlagEvent {
  /** UUID. Exposures use a deterministic id per (experiment, subject) so re-sends dedupe. */
  id: string;
  schemaVersion: number;
  /** The app that produced it (a tenant's `partition`, or the standalone app name). */
  app: string;
  /** The environment whose ruleset assigned it (`production`, `staging`, …). */
  environment: string;
  type: 'exposure' | 'track';
  /** Exposure: the flag. Track: absent. */
  flag?: string;
  /** Exposure: the experiment key. */
  experiment?: string;
  /** Exposure: the variant served. */
  variant?: string;
  /** Track: the event name (`purchase`, `signup`). */
  name?: string;
  subject: string;
  subjectType: string;
  /** Track: the numeric value (revenue, duration). */
  value?: number;
  props?: Record<string, unknown>;
  /** Epoch milliseconds. */
  ts: number;
}

/** A UUIDv7: time-ordered, so ids sort roughly by creation in every store. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = BigInt(now);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return format(bytes);
}

/**
 * The id of the exposure of `subject` to `experiment`: a UUIDv5-style hash, identical on every
 * send, so a destination that dedupes by id keeps one row however often the relay retries.
 */
export function exposureId(
  app: string,
  environment: string,
  experiment: string,
  subject: string,
): string {
  const bytes = createHash('sha1')
    .update(`flags:exposure:${app}:${environment}:${experiment}:${subject}`)
    .digest();
  const out = Buffer.from(bytes.subarray(0, 16));
  out[6] = (out[6]! & 0x0f) | 0x50;
  out[8] = (out[8]! & 0x3f) | 0x80;
  return format(out);
}

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Light structural validation for events arriving over HTTP from a tenant. */
export function parseEvents(input: unknown, app: string, environment: string): FlagEvent[] {
  if (!Array.isArray(input)) throw new TypeError('events must be an array');
  return input.map((raw, i) => {
    const e = raw as Partial<FlagEvent>;
    const fail = (message: string) => {
      throw new TypeError(`events[${i}]: ${message}`);
    };
    if (typeof e.id !== 'string' || e.id.length > 64) fail('id must be a string');
    if (e.type !== 'exposure' && e.type !== 'track') fail('type must be exposure or track');
    if (typeof e.subject !== 'string' || e.subject.length === 0) fail('subject is required');
    if (typeof e.ts !== 'number' || !Number.isFinite(e.ts)) fail('ts must be epoch milliseconds');
    if (
      e.type === 'exposure' &&
      (typeof e.experiment !== 'string' || typeof e.variant !== 'string')
    ) {
      fail('an exposure needs experiment and variant');
    }
    if (e.type === 'track' && typeof e.name !== 'string') fail('a track needs a name');
    if (e.value !== undefined && (typeof e.value !== 'number' || !Number.isFinite(e.value))) {
      fail('value must be a finite number');
    }
    return {
      id: e.id!,
      schemaVersion: typeof e.schemaVersion === 'number' ? e.schemaVersion : EVENT_SCHEMA_VERSION,
      // The tenant's identity and environment come from its verified token, never the payload.
      app,
      environment,
      type: e.type!,
      ...(e.flag !== undefined ? { flag: String(e.flag) } : {}),
      ...(e.experiment !== undefined ? { experiment: String(e.experiment) } : {}),
      ...(e.variant !== undefined ? { variant: String(e.variant) } : {}),
      ...(e.name !== undefined ? { name: String(e.name) } : {}),
      subject: e.subject!,
      subjectType: typeof e.subjectType === 'string' ? e.subjectType : 'user',
      ...(e.value !== undefined ? { value: e.value } : {}),
      ...(e.props !== undefined && typeof e.props === 'object' && e.props !== null
        ? { props: e.props as Record<string, unknown> }
        : {}),
      ts: e.ts!,
    };
  });
}
