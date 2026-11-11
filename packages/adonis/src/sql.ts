/**
 * The slice of Lucid this package needs: raw SQL and transactions. Typed structurally so the
 * package does not import `@adonisjs/lucid` at module load (it is an optional peer), and so a
 * `Database`, a `QueryClient` or a `TransactionClient` all fit.
 */
export interface SqlClient {
  rawQuery(sql: string, bindings?: readonly unknown[]): PromiseLike<unknown>;
  dialect?: { name?: string };
}

export interface SqlDatabase extends SqlClient {
  transaction<T>(callback: (trx: SqlClient) => Promise<T>): Promise<T>;
}

export type Dialect = 'postgres' | 'mysql' | 'sqlite';

export function dialectOf(client: SqlClient): Dialect {
  const name = client.dialect?.name ?? '';
  if (/postgres|pg|redshift/i.test(name)) return 'postgres';
  if (/mysql|mariadb/i.test(name)) return 'mysql';
  if (/sqlite/i.test(name)) return 'sqlite';
  throw new Error(`@adonis-agora/flags: unsupported database dialect "${name}"`);
}

/** Normalizes `rawQuery` results across drivers into an array of row objects. */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) {
    // mysql2: [rows, fields]; better-sqlite3 through knex: rows.
    if (result.length === 2 && Array.isArray(result[0]) && Array.isArray(result[1])) {
      return result[0] as T[];
    }
    return result as T[];
  }
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

export async function query<T = Record<string, unknown>>(
  client: SqlClient,
  sql: string,
  bindings: readonly unknown[] = [],
): Promise<T[]> {
  return rowsOf<T>(await client.rawQuery(sql, bindings));
}

/** JSON column values come back parsed on Postgres/MySQL and as text on SQLite. */
export function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T;
  return value as T;
}

/** Bindings for JSON columns: always a string, which every driver accepts. */
export function jsonValue(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

/** Numbers come back as strings for BIGINT on pg/mysql. */
export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return Number(value);
  return 0;
}

/**
 * Every timestamp this package stores is a BIGINT of epoch milliseconds: no time zone handling,
 * identical in every dialect and in the analytics backends.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  return new Date(toNumber(value));
}

/** `INSERT … ON CONFLICT DO NOTHING` in each dialect. */
export function insertIgnore(dialect: Dialect, table: string, columns: string[], rows: number) {
  const placeholders = `(${columns.map(() => '?').join(', ')})`;
  const values = Array.from({ length: rows }, () => placeholders).join(', ');
  const cols = columns.join(', ');
  if (dialect === 'mysql') return `INSERT IGNORE INTO ${table} (${cols}) VALUES ${values}`;
  return `INSERT INTO ${table} (${cols}) VALUES ${values} ON CONFLICT DO NOTHING`;
}
