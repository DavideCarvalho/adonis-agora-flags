import { describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import { createRuntime, lucidContext } from '../../src/runtime.js';
import { inSchema, qualifyTables, type SqlDatabase, schemaOf } from '../../src/sql.js';
import { quietLogger, sqliteDb } from '../helpers.js';

describe('qualifyTables', () => {
  it('qualifies table identifiers, and nothing else', () => {
    expect(
      qualifyTables(
        "SELECT * FROM flags_events e JOIN flags_sink_cursors c ON 1=1 WHERE c.sink = 'flags_events'",
        'flags',
        'postgres',
      ),
    ).toBe(
      'SELECT * FROM "flags".flags_events e JOIN "flags".flags_sink_cursors c ON 1=1 WHERE c.sink = \'flags_events\'',
    );
    // Index names start with a table name; they stay as they are.
    expect(
      qualifyTables(
        'CREATE INDEX IF NOT EXISTS flags_events_ts_idx ON flags_events (ts)',
        'flags',
        'postgres',
      ),
    ).toBe('CREATE INDEX IF NOT EXISTS flags_events_ts_idx ON "flags".flags_events (ts)');
    // Monthly partitions are tables of the schema too.
    expect(qualifyTables('DROP TABLE flags_events_202601', 'flags', 'postgres')).toBe(
      'DROP TABLE "flags".flags_events_202601',
    );
    expect(qualifyTables('SELECT 1 FROM "flags".flags_audit', 'flags', 'postgres')).toBe(
      'SELECT 1 FROM "flags".flags_audit',
    );
    expect(
      qualifyTables('WHERE relnamespace = to_regnamespace(current_schema())', 'flags', 'postgres'),
    ).toBe("WHERE relnamespace = to_regnamespace('flags')");
    expect(qualifyTables('INSERT IGNORE INTO flags_usage (a) VALUES (?)', 'ff', 'mysql')).toBe(
      'INSERT IGNORE INTO `ff`.flags_usage (a) VALUES (?)',
    );
  });
});

describe('inSchema', () => {
  const fake = () => {
    const sent: string[] = [];
    const client = {
      dialect: { name: 'postgres' },
      marker: 'kept',
      rawQuery: async (sql: string) => {
        sent.push(sql);
        return [];
      },
      transaction: async <T>(callback: (trx: unknown) => Promise<T>) =>
        callback({
          dialect: { name: 'postgres' },
          rawQuery: async (sql: string) => {
            sent.push(`trx:${sql}`);
            return [];
          },
        }),
    };
    return { client, sent };
  };

  it('qualifies queries on the client and inside its transactions', async () => {
    const { client, sent } = fake();
    const bound = inSchema(client as unknown as SqlDatabase, 'flags');
    await bound.rawQuery('SELECT * FROM flags_audit');
    await bound.transaction(async (trx) => {
      await trx.rawQuery('DELETE FROM flags_entities');
    });
    expect(sent).toEqual([
      'SELECT * FROM "flags".flags_audit',
      'trx:DELETE FROM "flags".flags_entities',
    ]);
    expect(schemaOf(bound)).toBe('flags');
    expect((bound as unknown as { marker: string }).marker).toBe('kept');
    // Binding twice does not qualify twice.
    expect(inSchema(bound, 'flags')).toBe(bound);
  });

  it('leaves the client alone without a schema, and refuses bad names and SQLite', async () => {
    const { client } = fake();
    expect(inSchema(client as unknown as SqlDatabase, undefined)).toBe(client);
    expect(() => inSchema(client as unknown as SqlDatabase, 'flags; DROP TABLE x')).toThrow(
      /invalid schema/,
    );
    const db = await sqliteDb();
    try {
      await expect(
        createRuntime(
          defineConfig({ flags: {}, schema: 'flags' }),
          lucidContext(db.database as never),
          { logger: quietLogger },
        ),
      ).rejects.toThrow(/Postgres or MySQL/);
    } finally {
      await db.close();
    }
  });
});
