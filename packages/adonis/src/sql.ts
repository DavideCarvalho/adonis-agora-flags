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

/** Every table this package owns. */
export const FLAGS_TABLES = [
  'flags_environments',
  'flags_entities',
  'flags_audit',
  'flags_change_requests',
  'flags_schedules',
  'flags_usage',
  'flags_declarations',
  'flags_events',
  'flags_sink_cursors',
  'flags_exposures',
  'flags_tracks',
  'flags_results',
] as const;

const SCHEMA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// A table name (or a monthly `flags_events_YYYYMM` partition) used as an identifier: not inside a
// string literal, not already qualified, not part of a longer name such as an index.
const TABLE_REF = new RegExp(
  `(?<![\\w.'"\`])(${FLAGS_TABLES.join('|')}|flags_events_\\d{6})(?![\\w'"\`])`,
  'g',
);
const IN_SCHEMA = Symbol.for('adonis-agora.flags.schema');

/** Checks a schema name from the config: a plain identifier, since it is written into SQL. */
export function assertSchemaName(schema: string): void {
  if (!SCHEMA_NAME.test(schema)) {
    throw new Error(
      `@adonis-agora/flags: invalid schema "${schema}" (letters, digits and _, not starting with a digit)`,
    );
  }
}

/** Rewrites this package's SQL so every table it owns lives in `schema`. */
export function qualifyTables(sql: string, schema: string, dialect: Dialect): string {
  const quoted = dialect === 'mysql' ? `\`${schema}\`` : `"${schema}"`;
  return sql.replace(TABLE_REF, `${quoted}.$1`).replaceAll('current_schema()', `'${schema}'`);
}

/** The schema a client was bound to with {@link inSchema}, if any. */
export function schemaOf(client: SqlClient): string | undefined {
  return (client as unknown as Record<symbol, string | undefined>)[IN_SCHEMA];
}

/**
 * Binds a client to a schema (Postgres) or database (MySQL): every query this package sends through
 * it, and through its transactions, names its tables as `schema.table`. Nothing depends on the
 * connection's `search_path`, so it is safe behind PgBouncer in transaction mode. Everything else
 * on the client (the knex instance `LISTEN` needs, the dialect) passes through untouched.
 */
export function inSchema<T extends SqlClient>(client: T, schema: string | undefined): T {
  if (!schema || schemaOf(client) === schema) return client;
  assertSchemaName(schema);
  const dialect = dialectOf(client);
  if (dialect === 'sqlite') {
    throw new Error('@adonis-agora/flags: `schema` needs Postgres or MySQL, not SQLite');
  }
  return new Proxy(client, {
    get(target, property) {
      if (property === IN_SCHEMA) return schema;
      if (property === 'rawQuery') {
        return (sql: string, bindings?: readonly unknown[]) =>
          target.rawQuery(qualifyTables(sql, schema, dialect), bindings);
      }
      if (property === 'transaction') {
        const transaction = (target as unknown as SqlDatabase).transaction.bind(target);
        return <R>(callback: (trx: SqlClient) => Promise<R>) =>
          transaction((trx) => callback(inSchema(trx, schema)));
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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
