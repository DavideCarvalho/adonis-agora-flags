import type { FlagDefinition, Holdout, Layer, Ruleset, Segment } from '@adonis-agora/flags-core';
import type { FlagDeclaration } from '../declare.js';

/** What a change targets. */
export type EntityType = 'flag' | 'segment' | 'layer' | 'holdout' | 'ruleset';

/** One change to the ruleset of an environment. `value: null` deletes. */
export type RulesetChange =
  | { entity: 'flag'; key: string; value: FlagDefinition | null }
  | { entity: 'segment'; key: string; value: Segment | null }
  | { entity: 'layer'; key: string; value: Layer | null }
  | { entity: 'holdout'; key?: undefined; value: Holdout | null }
  /** Replaces every flag, segment, layer and the holdout (import, promote). */
  | { entity: 'ruleset'; key?: undefined; value: Omit<Ruleset, 'version' | 'schemaVersion'> };

/** Who did something: the authkit `sub`, a user id, `cli`, `schedule`… */
export interface Actor {
  id: string;
  name?: string;
}

export interface AuditEntry {
  id: string;
  environment: string;
  entity: EntityType;
  key: string | null;
  action: 'create' | 'update' | 'delete' | 'replace';
  before: unknown;
  after: unknown;
  actor: Actor;
  /** Change request that carried the change, when approvals are on. */
  changeRequestId?: string;
  /** The ruleset version this change produced. */
  version: string;
  at: Date;
}

export type ChangeRequestStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'cancelled';

export interface ChangeRequest {
  id: string;
  environment: string;
  change: RulesetChange;
  /** Why the change is wanted. */
  note?: string;
  requestedBy: Actor;
  requestedAt: Date;
  status: ChangeRequestStatus;
  reviewedBy?: Actor;
  reviewedAt?: Date;
  reviewNote?: string;
  /** The ruleset version the request was made against; applying on a newer one warns. */
  baseVersion: string;
}

export type ScheduleKind = 'enable' | 'disable' | 'rollout' | 'change';

/** A change to apply at a given time (DESIGN §14: scheduling and gradual rollout). */
export interface ScheduledChange {
  id: string;
  environment: string;
  flag: string;
  kind: ScheduleKind;
  /** `rollout`: the share (0 … 100) the `on` arm should reach. `change`: a full RulesetChange. */
  payload: { percent?: number; variant?: string; change?: RulesetChange };
  runAt: Date;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  createdBy: Actor;
  error?: string;
  executedAt?: Date;
}

/** Evaluations of a flag on one day, for stale-flag detection. */
export interface UsageRow {
  environment: string;
  flag: string;
  day: string;
  evaluations: number;
}

export interface DeclarationRow {
  app: string;
  key: string;
  declaration: FlagDeclaration;
  lastSeenAt: Date;
}

/**
 * Where the ruleset lives. Every write bumps the environment's version in the same transaction,
 * which is what readers poll (or are notified about) to know the ruleset changed.
 */
export interface FlagsStore {
  /** Creates the tables if needed. Idempotent. */
  setup?(): Promise<void>;
  /** The assembled ruleset of an environment. */
  readRuleset(environment: string): Promise<Ruleset>;
  /** The current version string of an environment — cheap, polled. */
  version(environment: string): Promise<string>;
  /** Applies a change, bumps the version and writes the audit entry atomically. */
  apply(
    environment: string,
    change: RulesetChange,
    actor: Actor,
    options?: { changeRequestId?: string },
  ): Promise<{ version: string }>;
  environments(): Promise<string[]>;
  audit(query: {
    environment?: string;
    entity?: EntityType;
    key?: string;
    limit?: number;
    before?: Date;
  }): Promise<AuditEntry[]>;

  createChangeRequest(
    request: Omit<ChangeRequest, 'id' | 'status' | 'requestedAt'>,
  ): Promise<ChangeRequest>;
  getChangeRequest(id: string): Promise<ChangeRequest | null>;
  listChangeRequests(query: {
    environment?: string;
    status?: ChangeRequestStatus;
    limit?: number;
  }): Promise<ChangeRequest[]>;
  updateChangeRequest(
    id: string,
    patch: Partial<Pick<ChangeRequest, 'status' | 'reviewedBy' | 'reviewedAt' | 'reviewNote'>>,
  ): Promise<ChangeRequest>;

  getSchedule(id: string): Promise<ScheduledChange | null>;
  createSchedule(schedule: Omit<ScheduledChange, 'id' | 'status'>): Promise<ScheduledChange>;
  listSchedules(query: {
    environment?: string;
    flag?: string;
    status?: ScheduledChange['status'];
    dueBefore?: Date;
    limit?: number;
  }): Promise<ScheduledChange[]>;
  updateSchedule(
    id: string,
    patch: Partial<Pick<ScheduledChange, 'status' | 'error' | 'executedAt'>>,
  ): Promise<ScheduledChange>;
  /**
   * Atomically claims a due schedule (pending → running) so one replica executes it. Returns
   * `false` when another replica got it first.
   */
  claimSchedule(id: string): Promise<boolean>;

  /** Adds evaluation counts (stale-flag detection). */
  recordUsage(rows: UsageRow[]): Promise<void>;
  usage(query: { environment: string; since: string }): Promise<UsageRow[]>;

  /** Records the flags an app declares in code (schema push). */
  saveDeclarations(app: string, declarations: Record<string, FlagDeclaration>): Promise<void>;
  declarations(app?: string): Promise<DeclarationRow[]>;
}

/** Apply a change to an in-memory ruleset (shared by the stores and the console preview). */
export function applyChange(ruleset: Ruleset, change: RulesetChange): Ruleset {
  const next: Ruleset = structuredClone(ruleset);
  const upsert = <T>(map: Record<string, T> | undefined, key: string, value: T | null) => {
    const out = { ...(map ?? {}) };
    if (value === null) delete out[key];
    else out[key] = value;
    return out;
  };
  switch (change.entity) {
    case 'flag':
      next.flags = upsert(next.flags, change.key, change.value);
      break;
    case 'segment':
      next.segments = upsert(next.segments, change.key, change.value);
      break;
    case 'layer':
      next.layers = upsert(next.layers, change.key, change.value);
      break;
    case 'holdout':
      if (change.value === null) delete next.holdout;
      else next.holdout = change.value;
      break;
    case 'ruleset':
      next.flags = structuredClone(change.value.flags);
      next.segments = structuredClone(change.value.segments ?? {});
      next.layers = structuredClone(change.value.layers ?? {});
      if (change.value.holdout) next.holdout = structuredClone(change.value.holdout);
      else delete next.holdout;
      break;
  }
  return next;
}

/** The value a change replaces, for the audit `before` column. */
export function currentValue(ruleset: Ruleset, change: RulesetChange): unknown {
  switch (change.entity) {
    case 'flag':
      return ruleset.flags[change.key] ?? null;
    case 'segment':
      return ruleset.segments?.[change.key] ?? null;
    case 'layer':
      return ruleset.layers?.[change.key] ?? null;
    case 'holdout':
      return ruleset.holdout ?? null;
    case 'ruleset':
      return {
        flags: ruleset.flags,
        segments: ruleset.segments ?? {},
        layers: ruleset.layers ?? {},
        ...(ruleset.holdout ? { holdout: ruleset.holdout } : {}),
      };
  }
}

export function auditAction(before: unknown, change: RulesetChange): AuditEntry['action'] {
  if (change.entity === 'ruleset') return 'replace';
  if (change.value === null) return 'delete';
  return before === null || before === undefined ? 'create' : 'update';
}
