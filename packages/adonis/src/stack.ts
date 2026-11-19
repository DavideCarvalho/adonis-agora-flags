import app from '@adonisjs/core/services/app';

/**
 * What a store, transport or sink runs on, read by telescope's Architecture page from the config
 * (`flags: exposures → ClickHouse`). Shared through a global symbol, so flags does not depend on
 * telescope.
 */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

export interface StackUse {
  /** `postgres`, `mysql`, `sqlite`, `redis`, `clickhouse`, `duckdb`, `s3`, … */
  tech: string;
  /** The Lucid or Redis connection it goes through. */
  connection?: string;
  /** What it is for, in a few words. */
  purpose?: string;
  /** For what has no Lucid/Redis connection: a name (a database, a bucket). Never a secret. */
  label?: string;
  /** Tells two servers apart; hashed by telescope, never sent. */
  host?: string;
}

type Uses = StackUse | StackUse[] | (() => StackUse | StackUse[] | undefined);

/**
 * Attaches `uses` to `target` (non-enumerable). A function is resolved when read, after boot, so a
 * default connection is named as the app resolves it. Returns `target`.
 */
export function describeStackUse<T extends object>(target: T, uses: Uses): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      get() {
        try {
          const value = typeof uses === 'function' ? uses() : uses;
          return value === undefined ? [] : Array.isArray(value) ? value : [value];
        } catch {
          return [];
        }
      },
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen object: nothing to describe.
  }
  return target;
}

const SQL_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  sqlite: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

function appConfig(key: string): Record<string, unknown> | undefined {
  try {
    const value = (
      app as { config?: { get(key: string, fallback?: unknown): unknown } } | undefined
    )?.config?.get(key, undefined);
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function named(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Whether the app has a Lucid connection to fall back on (`config/database.ts`). */
export function hasLucidConnection(): boolean {
  return named(appConfig('database')?.connection) !== undefined;
}

/** A Lucid connection: `connection`, or the app's default connection when omitted. */
export function lucidUse(connection: string | undefined, purpose: string): StackUse {
  const database = appConfig('database');
  const name = connection ?? named(database?.connection);
  const connections = database?.connections as Record<string, { client?: unknown }> | undefined;
  const client = name ? connections?.[name]?.client : undefined;
  return {
    tech: SQL_TECH[String(client ?? '')] ?? 'sql',
    ...(name ? { connection: name } : {}),
    purpose,
  };
}

/** A Redis connection from `config/redis.ts`: `connection`, or the default one when omitted. */
export function redisUse(connection: string | undefined, purpose: string): StackUse {
  const name = connection ?? named(appConfig('redis')?.connection);
  return { tech: 'redis', ...(name ? { connection: name } : {}), purpose };
}

/** Host (and port) of a URL, without credentials; `undefined` when it does not parse. */
export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** A file location: `s3://bucket/prefix` → s3 + `bucket/prefix`, a local path → fs. */
export function fileUse(path: string, purpose: string): StackUse {
  const match = /^([a-z0-9]+):\/\/([^/?#]*)([^?#]*)/i.exec(path);
  if (!match) return { tech: 'fs', label: path, purpose };
  const scheme = (match[1] as string).toLowerCase();
  const tech =
    scheme === 's3' || scheme === 's3a' || scheme === 'r2'
      ? 's3'
      : scheme === 'gs' || scheme === 'gcs'
        ? 'gcs'
        : scheme === 'az' || scheme === 'azure' || scheme === 'abfss'
          ? 'azure-blob'
          : scheme;
  // Drop any `user:pass@` in the authority: the label is sent.
  const bucket = (match[2] as string).replace(/^.*@/, '');
  const prefix = (match[3] as string).replace(/\/+$/, '');
  return { tech, label: `${bucket}${prefix}`, purpose };
}
