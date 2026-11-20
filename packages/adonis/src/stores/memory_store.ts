import { randomUUID } from 'node:crypto';
import { emptyRuleset, RULESET_SCHEMA_VERSION, type Ruleset } from '@adonis-agora/flags-core';
import type { FlagDeclaration } from '../declare.js';
import {
  type Actor,
  type AuditEntry,
  applyChange,
  auditAction,
  type ChangeRequest,
  currentValue,
  type DeclarationRow,
  type EntityTimestamps,
  type FlagsStore,
  type RulesetChange,
  type ScheduledChange,
  type UsageRow,
} from './store.js';

/**
 * A store that lives in process memory. For tests, local development and apps whose flags are
 * only toggled from code. Nothing survives a restart, and replicas do not share it.
 */
export class MemoryStore implements FlagsStore {
  #rulesets = new Map<string, Ruleset>();
  #versions = new Map<string, number>();
  #audit: AuditEntry[] = [];
  #requests = new Map<string, ChangeRequest>();
  #schedules = new Map<string, ScheduledChange>();
  #usage = new Map<string, UsageRow>();
  #declarations = new Map<string, DeclarationRow>();
  /** environment → `entity\0key` → when created / last changed. */
  #stamps = new Map<string, Map<string, EntityTimestamps>>();

  /** Seed environments with a ruleset (`{ production: { flags: {…} } }`). */
  constructor(seed: Record<string, Partial<Omit<Ruleset, 'version'>>> = {}) {
    for (const [environment, ruleset] of Object.entries(seed)) {
      this.#rulesets.set(environment, {
        ...emptyRuleset(),
        ...ruleset,
        schemaVersion: RULESET_SCHEMA_VERSION,
        version: '1',
      });
      this.#versions.set(environment, 1);
    }
  }

  async readRuleset(environment: string): Promise<Ruleset> {
    const ruleset = this.#rulesets.get(environment) ?? emptyRuleset('0');
    return structuredClone({ ...ruleset, version: await this.version(environment) });
  }

  async version(environment: string): Promise<string> {
    return String(this.#versions.get(environment) ?? 0);
  }

  async apply(
    environment: string,
    change: RulesetChange,
    actor: Actor,
    options: { changeRequestId?: string } = {},
  ): Promise<{ version: string }> {
    const current = this.#rulesets.get(environment) ?? emptyRuleset('0');
    const before = currentValue(current, change);
    const version = (this.#versions.get(environment) ?? 0) + 1;
    const next = applyChange(current, change);
    this.#rulesets.set(environment, { ...next, version: String(version) });
    this.#versions.set(environment, version);
    this.#stamp(environment, change, next);
    this.#audit.push({
      id: randomUUID(),
      environment,
      entity: change.entity,
      key: change.key ?? null,
      action: auditAction(before, change),
      before: structuredClone(before),
      after: structuredClone(change.value),
      actor,
      ...(options.changeRequestId ? { changeRequestId: options.changeRequestId } : {}),
      version: String(version),
      at: new Date(),
    });
    return { version: String(version) };
  }

  /** Keeps `createdAt` of entities that survive the change, stamps the written ones. */
  #stamp(environment: string, change: RulesetChange, next: Ruleset) {
    const now = new Date();
    const previous = this.#stamps.get(environment) ?? new Map<string, EntityTimestamps>();
    const stamps = new Map<string, EntityTimestamps>();
    const written = new Set<string>();
    if (change.entity === 'ruleset') {
      for (const id of entityIds(next)) written.add(id);
    } else if (change.value !== null) {
      written.add(`${change.entity}\u0000${change.key ?? HOLDOUT_KEY}`);
    }
    for (const id of entityIds(next)) {
      const before = previous.get(id);
      const [entity, key] = id.split('\u0000') as [EntityTimestamps['entity'], string];
      if (!written.has(id) && before) stamps.set(id, before);
      else stamps.set(id, { entity, key, createdAt: before?.createdAt ?? now, updatedAt: now });
    }
    this.#stamps.set(environment, stamps);
  }

  async entityTimestamps(environment: string): Promise<EntityTimestamps[]> {
    return [...(this.#stamps.get(environment)?.values() ?? [])].map((s) => ({ ...s }));
  }

  async environments(): Promise<string[]> {
    return [...this.#rulesets.keys()].sort();
  }

  async audit(query: Parameters<FlagsStore['audit']>[0]): Promise<AuditEntry[]> {
    return this.#audit
      .filter(
        (entry) =>
          (query.environment === undefined || entry.environment === query.environment) &&
          (query.entity === undefined || entry.entity === query.entity) &&
          (query.key === undefined || entry.key === query.key) &&
          (query.before === undefined || entry.at < query.before),
      )
      .reverse()
      .slice(0, query.limit ?? 100);
  }

  async createChangeRequest(
    request: Omit<ChangeRequest, 'id' | 'status' | 'requestedAt'>,
  ): Promise<ChangeRequest> {
    const now = new Date();
    const created: ChangeRequest = {
      ...structuredClone(request),
      id: randomUUID(),
      status: 'pending',
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    this.#requests.set(created.id, created);
    return structuredClone(created);
  }

  async getChangeRequest(id: string): Promise<ChangeRequest | null> {
    const found = this.#requests.get(id);
    return found ? structuredClone(found) : null;
  }

  async listChangeRequests(
    query: Parameters<FlagsStore['listChangeRequests']>[0],
  ): Promise<ChangeRequest[]> {
    return [...this.#requests.values()]
      .filter(
        (r) =>
          (query.environment === undefined || r.environment === query.environment) &&
          (query.status === undefined || r.status === query.status),
      )
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime())
      .slice(0, query.limit ?? 100)
      .map((r) => structuredClone(r));
  }

  async updateChangeRequest(
    id: string,
    patch: Parameters<FlagsStore['updateChangeRequest']>[1],
  ): Promise<ChangeRequest> {
    const found = this.#requests.get(id);
    if (!found) throw new Error(`change request ${id} not found`);
    Object.assign(found, structuredClone(patch), { updatedAt: new Date() });
    return structuredClone(found);
  }

  async createSchedule(schedule: Omit<ScheduledChange, 'id' | 'status'>): Promise<ScheduledChange> {
    const now = new Date();
    const created: ScheduledChange = {
      ...structuredClone(schedule),
      id: randomUUID(),
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    this.#schedules.set(created.id, created);
    return structuredClone(created);
  }

  async getSchedule(id: string): Promise<ScheduledChange | null> {
    const found = this.#schedules.get(id);
    return found ? structuredClone(found) : null;
  }

  async listSchedules(
    query: Parameters<FlagsStore['listSchedules']>[0],
  ): Promise<ScheduledChange[]> {
    return [...this.#schedules.values()]
      .filter(
        (s) =>
          (query.environment === undefined || s.environment === query.environment) &&
          (query.flag === undefined || s.flag === query.flag) &&
          (query.status === undefined || s.status === query.status) &&
          (query.dueBefore === undefined || s.runAt <= query.dueBefore),
      )
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, query.limit ?? 100)
      .map((s) => structuredClone(s));
  }

  async updateSchedule(
    id: string,
    patch: Parameters<FlagsStore['updateSchedule']>[1],
  ): Promise<ScheduledChange> {
    const found = this.#schedules.get(id);
    if (!found) throw new Error(`schedule ${id} not found`);
    Object.assign(found, structuredClone(patch), { updatedAt: new Date() });
    return structuredClone(found);
  }

  async claimSchedule(id: string): Promise<boolean> {
    const found = this.#schedules.get(id);
    if (found?.status !== 'pending') return false;
    found.status = 'running';
    found.updatedAt = new Date();
    return true;
  }

  async recordUsage(rows: UsageRow[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.environment}\u0000${row.app ?? ''}\u0000${row.flag}\u0000${row.day}`;
      const existing = this.#usage.get(key);
      if (existing) existing.evaluations += row.evaluations;
      else this.#usage.set(key, { ...row });
    }
  }

  async usage(query: { environment: string; since: string; apps?: string[] }): Promise<UsageRow[]> {
    const rows = [...this.#usage.values()].filter(
      (row) =>
        row.environment === query.environment &&
        row.day >= query.since &&
        (query.apps === undefined || (row.app !== undefined && query.apps.includes(row.app))),
    );
    if (query.apps !== undefined) return rows.map((row) => ({ ...row }));
    // Every app: one row per flag and day, like the SQL store.
    const merged = new Map<string, UsageRow>();
    for (const row of rows) {
      const key = `${row.flag}\u0000${row.day}`;
      const existing = merged.get(key);
      if (existing) existing.evaluations += row.evaluations;
      else
        merged.set(key, {
          environment: row.environment,
          flag: row.flag,
          day: row.day,
          evaluations: row.evaluations,
        });
    }
    return [...merged.values()];
  }

  async saveDeclarations(
    app: string,
    declarations: Record<string, FlagDeclaration>,
  ): Promise<void> {
    const now = new Date();
    for (const [key, declaration] of Object.entries(declarations)) {
      const before = this.#declarations.get(`${app}\u0000${key}`);
      const changed = !before || JSON.stringify(before.declaration) !== JSON.stringify(declaration);
      const createdAt = before ? before.createdAt : now;
      const updatedAt = changed ? now : before.updatedAt;
      this.#declarations.set(`${app}\u0000${key}`, {
        app,
        key,
        declaration: structuredClone(declaration),
        lastSeenAt: now,
        ...(createdAt ? { createdAt } : {}),
        ...(updatedAt ? { updatedAt } : {}),
      });
    }
  }

  async declarations(app?: string): Promise<DeclarationRow[]> {
    return [...this.#declarations.values()]
      .filter((row) => app === undefined || row.app === app)
      .map((row) => structuredClone(row));
  }
}

const HOLDOUT_KEY = '__holdout__';

/** `entity\0key` of every entity a ruleset stores, as the SQL store keys its rows. */
function entityIds(ruleset: Ruleset): string[] {
  return [
    ...Object.keys(ruleset.flags).map((k) => `flag\u0000${k}`),
    ...Object.keys(ruleset.segments ?? {}).map((k) => `segment\u0000${k}`),
    ...Object.keys(ruleset.layers ?? {}).map((k) => `layer\u0000${k}`),
    ...Object.keys(ruleset.metrics ?? {}).map((k) => `metric\u0000${k}`),
    ...(ruleset.holdout ? [`holdout\u0000${HOLDOUT_KEY}`] : []),
  ];
}
