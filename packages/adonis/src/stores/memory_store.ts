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
    this.#rulesets.set(environment, { ...applyChange(current, change), version: String(version) });
    this.#versions.set(environment, version);
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
    const created: ChangeRequest = {
      ...structuredClone(request),
      id: randomUUID(),
      status: 'pending',
      requestedAt: new Date(),
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
    Object.assign(found, structuredClone(patch));
    return structuredClone(found);
  }

  async createSchedule(schedule: Omit<ScheduledChange, 'id' | 'status'>): Promise<ScheduledChange> {
    const created: ScheduledChange = {
      ...structuredClone(schedule),
      id: randomUUID(),
      status: 'pending',
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
    Object.assign(found, structuredClone(patch));
    return structuredClone(found);
  }

  async claimSchedule(id: string): Promise<boolean> {
    const found = this.#schedules.get(id);
    if (found?.status !== 'pending') return false;
    found.status = 'running';
    return true;
  }

  async recordUsage(rows: UsageRow[]): Promise<void> {
    for (const row of rows) {
      const key = `${row.environment}\u0000${row.flag}\u0000${row.day}`;
      const existing = this.#usage.get(key);
      if (existing) existing.evaluations += row.evaluations;
      else this.#usage.set(key, { ...row });
    }
  }

  async usage(query: { environment: string; since: string }): Promise<UsageRow[]> {
    return [...this.#usage.values()]
      .filter((row) => row.environment === query.environment && row.day >= query.since)
      .map((row) => ({ ...row }));
  }

  async saveDeclarations(
    app: string,
    declarations: Record<string, FlagDeclaration>,
  ): Promise<void> {
    const now = new Date();
    for (const [key, declaration] of Object.entries(declarations)) {
      this.#declarations.set(`${app}\u0000${key}`, {
        app,
        key,
        declaration: structuredClone(declaration),
        lastSeenAt: now,
      });
    }
  }

  async declarations(app?: string): Promise<DeclarationRow[]> {
    return [...this.#declarations.values()]
      .filter((row) => app === undefined || row.app === app)
      .map((row) => structuredClone(row));
  }
}
