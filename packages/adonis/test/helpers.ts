import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import type { SqlDatabase } from '../src/sql.js';

export interface TestDb {
  database: Database;
  db: SqlDatabase;
  close(): Promise<void>;
}

/** A Lucid database on a throwaway SQLite file (a file, not `:memory:`: every pool connection must see the same data). */
export async function sqliteDb(): Promise<TestDb> {
  const dir = mkdtempSync(join(tmpdir(), 'flags-test-'));
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  return {
    database,
    db: database.connection() as unknown as SqlDatabase,
    async close() {
      await database.manager.closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A Lucid database on Postgres from the integration container, isolated in its own schema. */
export async function postgresDb(schema: string): Promise<TestDb> {
  const url = process.env.FLAGS_TEST_PG_URL;
  if (!url)
    throw new Error('FLAGS_TEST_PG_URL is unset — run through vitest.integration.config.ts');
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'pg',
      connections: {
        pg: { client: 'pg', connection: url, searchPath: [schema], pool: { min: 0, max: 6 } },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  await database.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await database.rawQuery(`CREATE SCHEMA "${schema}"`);
  return {
    database,
    db: database.connection() as unknown as SqlDatabase,
    async close() {
      await database.rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await database.manager.closeAll();
    },
  };
}

/** A Lucid database on MySQL from the integration container, in a fresh database. */
export async function mysqlDb(name: string): Promise<TestDb> {
  const url = process.env.FLAGS_TEST_MYSQL_URL;
  if (!url)
    throw new Error('FLAGS_TEST_MYSQL_URL is unset — run through vitest.integration.config.ts');
  const parsed = new URL(url);
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const connection = {
    host: parsed.hostname,
    port: Number(parsed.port),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
  const admin = new Database(
    { connection: 'm', connections: { m: { client: 'mysql2', connection } } },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  await admin.rawQuery(`DROP DATABASE IF EXISTS \`${name}\``);
  await admin.rawQuery(`CREATE DATABASE \`${name}\``);
  await admin.manager.closeAll();
  const database = new Database(
    {
      connection: 'm',
      connections: {
        m: {
          client: 'mysql2',
          connection: { ...connection, database: name },
          pool: { min: 0, max: 6 },
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  return {
    database,
    db: database.connection() as unknown as SqlDatabase,
    async close() {
      await database.rawQuery(`DROP DATABASE IF EXISTS \`${name}\``);
      await database.manager.closeAll();
    },
  };
}

export const quietLogger = { warn: () => {}, error: () => {}, info: () => {} };
