import { randomUUID } from 'node:crypto';
import {
  type FlagDefinition,
  type Holdout,
  type Layer,
  type MetricDefinition,
  RULESET_SCHEMA_VERSION,
  type Ruleset,
  type Segment,
} from '@adonis-agora/flags-core';
import type { FlagDeclaration } from '../declare.js';
import { createFlagsTables, type SchemaOptions } from '../schema.js';
import {
  type Dialect,
  dialectOf,
  insertIgnore,
  jsonValue,
  parseJson,
  query,
  type SqlClient,
  type SqlDatabase,
  toDate,
  toNumber,
} from '../sql.js';
import {
  type Actor,
  type AuditEntry,
  applyChange,
  auditAction,
  type ChangeRequest,
  currentValue,
  type DeclarationRow,
  type EntityType,
  type FlagsStore,
  type RulesetChange,
  type ScheduledChange,
  type UsageRow,
} from './store.js';

interface KnexLike {
  client: {
    acquireConnection(): Promise<unknown>;
    releaseConnection(connection: unknown): Promise<unknown>;
  };
}

interface PgConnection {
  query(sql: string): Promise<unknown>;
  on(
    event: 'notification',
    handler: (message: { channel: string; payload?: string }) => void,
  ): void;
  removeListener(
    event: 'notification',
    handler: (message: { channel: string; payload?: string }) => void,
  ): void;
}

/** Postgres channel notified on every ruleset change (payload: `environment:version`). */
export const RULESET_CHANNEL = 'adonis_agora_flags';

const HOLDOUT_KEY = '__holdout__';

/**
 * The ruleset in your database, through Lucid. Works on Postgres, MySQL and SQLite. Every write
 * runs in one transaction that also bumps the environment version and writes the audit row, and on
 * Postgres sends `NOTIFY` so other replicas reload immediately instead of at the next poll.
 */
export class LucidStore implements FlagsStore {
  readonly dialect: Dialect;

  constructor(
    readonly db: SqlDatabase,
    private readonly options: SchemaOptions & { autoCreateSchema?: boolean } = {},
  ) {
    this.dialect = dialectOf(db);
  }

  async setup(): Promise<void> {
    if (this.options.autoCreateSchema === false) return;
    await createFlagsTables(this.db, this.options);
  }

  /**
   * Postgres `LISTEN` on {@link RULESET_CHANNEL}: holds one connection from the pool for the life of
   * the process. Other dialects have no notifications; the source falls back to polling.
   */
  async listen(onMessage: (payload: string) => void): Promise<() => Promise<void>> {
    if (this.dialect !== 'postgres') throw new Error('notifications need Postgres');
    // A QueryClient exposes getWriteClient(); a Database exposes connection() returning one.
    const holder = this.db as unknown as {
      connection?: unknown;
      getWriteClient?: () => KnexLike;
    };
    const knex =
      typeof holder.getWriteClient === 'function'
        ? holder.getWriteClient()
        : typeof holder.connection === 'function'
          ? (holder.connection as () => { getWriteClient(): KnexLike })().getWriteClient()
          : undefined;
    if (!knex) throw new Error('cannot reach the underlying knex client to LISTEN');
    const connection = (await knex.client.acquireConnection()) as PgConnection;
    const handler = (message: { channel: string; payload?: string }) => {
      if (message.channel === RULESET_CHANNEL) onMessage(message.payload ?? '');
    };
    connection.on('notification', handler);
    await connection.query(`LISTEN ${RULESET_CHANNEL}`);
    return async () => {
      connection.removeListener('notification', handler);
      try {
        await connection.query(`UNLISTEN ${RULESET_CHANNEL}`);
      } finally {
        await knex.client.releaseConnection(connection);
      }
    };
  }

  async readRuleset(environment: string): Promise<Ruleset> {
    // One snapshot: the version and the entities must come from the same moment.
    return this.db.transaction(async (trx) => {
      const version = await this.#version(trx, environment);
      const rows = await query<{ entity: string; entity_key: string; definition: unknown }>(
        trx,
        'SELECT entity, entity_key, definition FROM flags_entities WHERE environment = ?',
        [environment],
      );
      const ruleset: Ruleset = {
        schemaVersion: RULESET_SCHEMA_VERSION,
        version,
        flags: {},
        segments: {},
        layers: {},
      };
      for (const row of rows) {
        const definition = parseJson<unknown>(row.definition);
        if (row.entity === 'flag') ruleset.flags[row.entity_key] = definition as FlagDefinition;
        else if (row.entity === 'segment')
          ruleset.segments![row.entity_key] = definition as Segment;
        else if (row.entity === 'layer') ruleset.layers![row.entity_key] = definition as Layer;
        else if (row.entity === 'metric') {
          ruleset.metrics = {
            ...ruleset.metrics,
            [row.entity_key]: definition as MetricDefinition,
          };
        } else if (row.entity === 'holdout') ruleset.holdout = definition as Holdout;
      }
      return ruleset;
    });
  }

  async version(environment: string): Promise<string> {
    return this.#version(this.db, environment);
  }

  async #version(client: SqlClient, environment: string): Promise<string> {
    const rows = await query<{ version: unknown }>(
      client,
      'SELECT version FROM flags_environments WHERE name = ?',
      [environment],
    );
    return String(toNumber(rows[0]?.version ?? 0));
  }

  async apply(
    environment: string,
    change: RulesetChange,
    actor: Actor,
    options: { changeRequestId?: string } = {},
  ): Promise<{ version: string }> {
    const result = await this.db.transaction(async (trx) => {
      const now = Date.now();
      await this.#ensureEnvironment(trx, environment, now);
      // Row lock on the environment serializes concurrent writers (SQLite is single-writer).
      if (this.dialect !== 'sqlite') {
        await trx.rawQuery('SELECT version FROM flags_environments WHERE name = ? FOR UPDATE', [
          environment,
        ]);
      }
      const before = currentValue(await this.#readIn(trx, environment), change);
      await this.#write(trx, environment, change, actor, now);
      await trx.rawQuery(
        'UPDATE flags_environments SET version = version + 1, updated_at = ? WHERE name = ?',
        [now, environment],
      );
      const version = await this.#version(trx, environment);
      await trx.rawQuery(
        `INSERT INTO flags_audit (id, environment, entity, entity_key, action, before_value, after_value, actor_id, actor_name, change_request_id, version, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          environment,
          change.entity,
          change.key ?? null,
          auditAction(before, change),
          jsonValue(before),
          jsonValue(change.value),
          actor.id,
          actor.name ?? null,
          options.changeRequestId ?? null,
          Number(version),
          now,
        ],
      );
      if (this.dialect === 'postgres') {
        await trx.rawQuery('SELECT pg_notify(?, ?)', [
          RULESET_CHANNEL,
          `${environment}:${version}`,
        ]);
      }
      return { version };
    });
    return result;
  }

  async #readIn(trx: SqlClient, environment: string): Promise<Ruleset> {
    const rows = await query<{ entity: string; entity_key: string; definition: unknown }>(
      trx,
      'SELECT entity, entity_key, definition FROM flags_entities WHERE environment = ?',
      [environment],
    );
    let ruleset: Ruleset = {
      schemaVersion: RULESET_SCHEMA_VERSION,
      version: '0',
      flags: {},
      segments: {},
      layers: {},
    };
    for (const row of rows) {
      const value = parseJson<never>(row.definition);
      ruleset =
        row.entity === 'holdout'
          ? applyChange(ruleset, { entity: 'holdout', value })
          : applyChange(ruleset, { entity: row.entity as 'flag', key: row.entity_key, value });
    }
    return ruleset;
  }

  async #ensureEnvironment(trx: SqlClient, environment: string, now: number) {
    await trx.rawQuery(
      insertIgnore(this.dialect, 'flags_environments', ['name', 'version', 'updated_at'], 1),
      [environment, 0, now],
    );
  }

  async #write(
    trx: SqlClient,
    environment: string,
    change: RulesetChange,
    actor: Actor,
    now: number,
  ) {
    const upsert = async (entity: EntityType, key: string, value: unknown) => {
      await trx.rawQuery(
        'DELETE FROM flags_entities WHERE environment = ? AND entity = ? AND entity_key = ?',
        [environment, entity, key],
      );
      if (value === null) return;
      await trx.rawQuery(
        'INSERT INTO flags_entities (environment, entity, entity_key, definition, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)',
        [environment, entity, key, jsonValue(value), now, actor.id],
      );
    };
    switch (change.entity) {
      case 'flag':
      case 'segment':
      case 'layer':
      case 'metric':
        await upsert(change.entity, change.key, change.value);
        return;
      case 'holdout':
        await upsert('holdout', HOLDOUT_KEY, change.value);
        return;
      case 'ruleset': {
        await trx.rawQuery('DELETE FROM flags_entities WHERE environment = ?', [environment]);
        const value = change.value;
        for (const [key, def] of Object.entries(value.flags)) await upsert('flag', key, def);
        for (const [key, def] of Object.entries(value.segments ?? {}))
          await upsert('segment', key, def);
        for (const [key, def] of Object.entries(value.layers ?? {}))
          await upsert('layer', key, def);
        for (const [key, def] of Object.entries(value.metrics ?? {}))
          await upsert('metric', key, def);
        if (value.holdout) await upsert('holdout', HOLDOUT_KEY, value.holdout);
      }
    }
  }

  async environments(): Promise<string[]> {
    const rows = await query<{ name: string }>(
      this.db,
      'SELECT name FROM flags_environments ORDER BY name',
    );
    return rows.map((row) => row.name);
  }

  async audit(q: Parameters<FlagsStore['audit']>[0]): Promise<AuditEntry[]> {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (q.environment !== undefined) where.push('environment = ?') && bindings.push(q.environment);
    if (q.entity !== undefined) where.push('entity = ?') && bindings.push(q.entity);
    if (q.key !== undefined) where.push('entity_key = ?') && bindings.push(q.key);
    if (q.before !== undefined) where.push('at < ?') && bindings.push(q.before.getTime());
    bindings.push(q.limit ?? 100);
    const rows = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM flags_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY version DESC, at DESC LIMIT ?`,
      bindings,
    );
    return rows.map((row) => ({
      id: String(row.id),
      environment: String(row.environment),
      entity: row.entity as EntityType,
      key: (row.entity_key as string | null) ?? null,
      action: row.action as AuditEntry['action'],
      before: row.before_value === null ? null : parseJson(row.before_value),
      after: row.after_value === null ? null : parseJson(row.after_value),
      actor: {
        id: String(row.actor_id),
        ...(row.actor_name ? { name: String(row.actor_name) } : {}),
      },
      ...(row.change_request_id ? { changeRequestId: String(row.change_request_id) } : {}),
      version: String(toNumber(row.version)),
      at: toDate(row.at),
    }));
  }

  async createChangeRequest(
    request: Omit<ChangeRequest, 'id' | 'status' | 'requestedAt'>,
  ): Promise<ChangeRequest> {
    const id = randomUUID();
    const now = Date.now();
    await this.db.rawQuery(
      `INSERT INTO flags_change_requests (id, environment, change_value, note, requested_by, requested_at, status, base_version)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        request.environment,
        jsonValue(request.change),
        request.note ?? null,
        jsonValue(request.requestedBy),
        now,
        request.baseVersion,
      ],
    );
    return (await this.getChangeRequest(id))!;
  }

  async getChangeRequest(id: string): Promise<ChangeRequest | null> {
    const rows = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM flags_change_requests WHERE id = ?',
      [id],
    );
    return rows[0] ? toChangeRequest(rows[0]) : null;
  }

  async listChangeRequests(
    q: Parameters<FlagsStore['listChangeRequests']>[0],
  ): Promise<ChangeRequest[]> {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (q.environment !== undefined) where.push('environment = ?') && bindings.push(q.environment);
    if (q.status !== undefined) where.push('status = ?') && bindings.push(q.status);
    bindings.push(q.limit ?? 100);
    const rows = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM flags_change_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC LIMIT ?`,
      bindings,
    );
    return rows.map(toChangeRequest);
  }

  async updateChangeRequest(
    id: string,
    patch: Parameters<FlagsStore['updateChangeRequest']>[1],
  ): Promise<ChangeRequest> {
    const sets: string[] = [];
    const bindings: unknown[] = [];
    if (patch.status !== undefined) sets.push('status = ?') && bindings.push(patch.status);
    if (patch.reviewedBy !== undefined)
      sets.push('reviewed_by = ?') && bindings.push(jsonValue(patch.reviewedBy));
    if (patch.reviewedAt !== undefined)
      sets.push('reviewed_at = ?') && bindings.push(patch.reviewedAt.getTime());
    if (patch.reviewNote !== undefined)
      sets.push('review_note = ?') && bindings.push(patch.reviewNote);
    if (sets.length > 0) {
      await this.db.rawQuery(`UPDATE flags_change_requests SET ${sets.join(', ')} WHERE id = ?`, [
        ...bindings,
        id,
      ]);
    }
    const updated = await this.getChangeRequest(id);
    if (!updated) throw new Error(`change request ${id} not found`);
    return updated;
  }

  async createSchedule(schedule: Omit<ScheduledChange, 'id' | 'status'>): Promise<ScheduledChange> {
    const id = randomUUID();
    await this.db.rawQuery(
      `INSERT INTO flags_schedules (id, environment, flag, kind, payload, run_at, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        id,
        schedule.environment,
        schedule.flag,
        schedule.kind,
        jsonValue(schedule.payload),
        schedule.runAt.getTime(),
        jsonValue(schedule.createdBy),
      ],
    );
    return (await this.#schedule(id))!;
  }

  getSchedule(id: string): Promise<ScheduledChange | null> {
    return this.#schedule(id);
  }

  /** Whether this store can push change notifications (Postgres `LISTEN/NOTIFY`). */
  get canListen(): boolean {
    return this.dialect === 'postgres';
  }

  async #schedule(id: string): Promise<ScheduledChange | null> {
    const rows = await query<Record<string, unknown>>(
      this.db,
      'SELECT * FROM flags_schedules WHERE id = ?',
      [id],
    );
    return rows[0] ? toSchedule(rows[0]) : null;
  }

  async listSchedules(q: Parameters<FlagsStore['listSchedules']>[0]): Promise<ScheduledChange[]> {
    const where: string[] = [];
    const bindings: unknown[] = [];
    if (q.environment !== undefined) where.push('environment = ?') && bindings.push(q.environment);
    if (q.flag !== undefined) where.push('flag = ?') && bindings.push(q.flag);
    if (q.status !== undefined) where.push('status = ?') && bindings.push(q.status);
    if (q.dueBefore !== undefined)
      where.push('run_at <= ?') && bindings.push(q.dueBefore.getTime());
    bindings.push(q.limit ?? 100);
    const rows = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM flags_schedules ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY run_at ASC LIMIT ?`,
      bindings,
    );
    return rows.map(toSchedule);
  }

  async updateSchedule(
    id: string,
    patch: Parameters<FlagsStore['updateSchedule']>[1],
  ): Promise<ScheduledChange> {
    const sets: string[] = [];
    const bindings: unknown[] = [];
    if (patch.status !== undefined) sets.push('status = ?') && bindings.push(patch.status);
    if (patch.error !== undefined) sets.push('error = ?') && bindings.push(patch.error);
    if (patch.executedAt !== undefined)
      sets.push('executed_at = ?') && bindings.push(patch.executedAt.getTime());
    if (sets.length > 0) {
      await this.db.rawQuery(`UPDATE flags_schedules SET ${sets.join(', ')} WHERE id = ?`, [
        ...bindings,
        id,
      ]);
    }
    const updated = await this.#schedule(id);
    if (!updated) throw new Error(`schedule ${id} not found`);
    return updated;
  }

  async claimSchedule(id: string): Promise<boolean> {
    // Compare-and-set in one statement: only one replica's UPDATE matches the pending row, and the
    // token it writes tells it apart from a replica that lost the race.
    const token = `claim:${randomUUID()}`;
    await this.db.rawQuery(
      "UPDATE flags_schedules SET status = 'running', error = ? WHERE id = ? AND status = 'pending'",
      [token, id],
    );
    const rows = await query<{ error: string | null }>(
      this.db,
      'SELECT error FROM flags_schedules WHERE id = ?',
      [id],
    );
    if (rows[0]?.error !== token) return false;
    await this.db.rawQuery('UPDATE flags_schedules SET error = NULL WHERE id = ?', [id]);
    return true;
  }

  async recordUsage(rows: UsageRow[]): Promise<void> {
    if (rows.length === 0) return;
    for (const row of rows) {
      const sql =
        this.dialect === 'mysql'
          ? 'INSERT INTO flags_usage (environment, flag, day, evaluations) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE evaluations = evaluations + VALUES(evaluations)'
          : 'INSERT INTO flags_usage (environment, flag, day, evaluations) VALUES (?, ?, ?, ?) ON CONFLICT (environment, flag, day) DO UPDATE SET evaluations = flags_usage.evaluations + excluded.evaluations';
      await this.db.rawQuery(sql, [row.environment, row.flag, row.day, row.evaluations]);
    }
  }

  async usage(q: { environment: string; since: string }): Promise<UsageRow[]> {
    const rows = await query<Record<string, unknown>>(
      this.db,
      'SELECT environment, flag, day, evaluations FROM flags_usage WHERE environment = ? AND day >= ?',
      [q.environment, q.since],
    );
    return rows.map((row) => ({
      environment: String(row.environment),
      flag: String(row.flag),
      day: String(row.day),
      evaluations: toNumber(row.evaluations),
    }));
  }

  async saveDeclarations(
    app: string,
    declarations: Record<string, FlagDeclaration>,
  ): Promise<void> {
    const now = Date.now();
    await this.db.transaction(async (trx) => {
      for (const [key, declaration] of Object.entries(declarations)) {
        await trx.rawQuery('DELETE FROM flags_declarations WHERE app = ? AND flag = ?', [app, key]);
        await trx.rawQuery(
          'INSERT INTO flags_declarations (app, flag, declaration, last_seen_at) VALUES (?, ?, ?, ?)',
          [app, key, jsonValue(declaration), now],
        );
      }
    });
  }

  async declarations(app?: string): Promise<DeclarationRow[]> {
    const rows = await query<Record<string, unknown>>(
      this.db,
      `SELECT * FROM flags_declarations ${app !== undefined ? 'WHERE app = ?' : ''} ORDER BY app, flag`,
      app !== undefined ? [app] : [],
    );
    return rows.map((row) => ({
      app: String(row.app),
      key: String(row.flag),
      declaration: parseJson<FlagDeclaration>(row.declaration),
      lastSeenAt: toDate(row.last_seen_at),
    }));
  }
}

function toChangeRequest(row: Record<string, unknown>): ChangeRequest {
  return {
    id: String(row.id),
    environment: String(row.environment),
    change: parseJson<RulesetChange>(row.change_value),
    ...(row.note ? { note: String(row.note) } : {}),
    requestedBy: parseJson<Actor>(row.requested_by),
    requestedAt: toDate(row.requested_at),
    status: row.status as ChangeRequest['status'],
    ...(row.reviewed_by ? { reviewedBy: parseJson<Actor>(row.reviewed_by) } : {}),
    ...(row.reviewed_at !== null && row.reviewed_at !== undefined
      ? { reviewedAt: toDate(row.reviewed_at) }
      : {}),
    ...(row.review_note ? { reviewNote: String(row.review_note) } : {}),
    baseVersion: String(row.base_version),
  };
}

function toSchedule(row: Record<string, unknown>): ScheduledChange {
  return {
    id: String(row.id),
    environment: String(row.environment),
    flag: String(row.flag),
    kind: row.kind as ScheduledChange['kind'],
    payload: parseJson<ScheduledChange['payload']>(row.payload),
    runAt: toDate(row.run_at),
    status: row.status as ScheduledChange['status'],
    createdBy: parseJson<Actor>(row.created_by),
    ...(row.error && !String(row.error).startsWith('claim:') ? { error: String(row.error) } : {}),
    ...(row.executed_at !== null && row.executed_at !== undefined
      ? { executedAt: toDate(row.executed_at) }
      : {}),
  };
}
