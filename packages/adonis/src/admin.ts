import {
  type FlagDefinition,
  type JsonValue,
  RULESET_SCHEMA_VERSION,
  type Ruleset,
  type RulesetIssue,
  validateRuleset,
} from '@adonis-agora/flags-core';
import { type FlagDeclaration, fromData, toData } from './declare.js';
import {
  type Actor,
  applyChange,
  type ChangeRequest,
  type FlagsStore,
  type RulesetChange,
  type ScheduledChange,
} from './stores/store.js';

/** What an admin action is about, for authorization. */
export type AdminAction = 'read' | 'write' | 'approve';

/**
 * Decides whether `actor` may do `action`. Wire `@adonis-agora/authz` here (e.g. a `flags.write`
 * permission scoped by environment). Default: allow — protect the console and commands themselves.
 */
export type AdminAuthorizer = (
  actor: Actor,
  action: AdminAction,
  target: { environment: string; change?: RulesetChange; request?: ChangeRequest },
) => boolean | Promise<boolean>;

export interface ApprovalsConfig {
  /** Environments whose changes need a second person. `true` = all. Default: none. */
  environments: string[] | true;
}

/** Flag keys: what URLs, SQL and code can all carry safely. */
const FLAG_KEY = /^[A-Za-z0-9_.-]{1,100}$/;

export class ValidationError extends Error {
  readonly code = 'E_FLAGS_INVALID';
  constructor(readonly issues: RulesetIssue[]) {
    super(`invalid ruleset change:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`);
  }
}

export class ForbiddenError extends Error {
  readonly code = 'E_FLAGS_FORBIDDEN';
}

export type ProposeResult =
  | { status: 'applied'; version: string }
  | { status: 'pending'; request: ChangeRequest };

/** The definition a declared flag starts with when it is first edited. */
export function definitionFromDeclaration(declaration: FlagDeclaration): FlagDefinition {
  if (declaration.type === 'boolean') {
    const on = declaration.default === true;
    return {
      variants: { on: true, off: false },
      enabled: true,
      offVariant: 'off',
      fallthrough: { variant: on ? 'on' : 'off' },
    };
  }
  if (declaration.type === 'string' && declaration.variants && declaration.variants.length > 0) {
    return {
      variants: Object.fromEntries(declaration.variants.map((v) => [v, v])),
      enabled: true,
      offVariant: String(declaration.default),
      fallthrough: { variant: String(declaration.default) },
    };
  }
  return {
    variants: { default: declaration.default as JsonValue },
    enabled: true,
    offVariant: 'default',
    fallthrough: { variant: 'default' },
  };
}

/** Issues where a ruleset contradicts what the code declares (types, variant names). */
export function checkAgainstDeclarations(
  ruleset: Ruleset,
  declarations: Record<string, FlagDeclaration>,
): RulesetIssue[] {
  const issues: RulesetIssue[] = [];
  for (const [key, flag] of Object.entries(ruleset.flags)) {
    const declaration = declarations[key];
    if (!declaration) continue;
    for (const [variant, value] of Object.entries(flag.variants)) {
      const type = Array.isArray(value) ? 'json' : value === null ? 'json' : typeof value;
      const expected = declaration.type === 'json' ? 'json' : declaration.type;
      const ok = expected === 'json' ? true : type === expected;
      if (!ok) {
        issues.push({
          path: `flags.${key}.variants.${variant}`,
          message: `is ${type}, the code declares ${declaration.type}`,
        });
      }
      if (
        declaration.type === 'string' &&
        declaration.variants &&
        !declaration.variants.includes(String(value))
      ) {
        issues.push({
          path: `flags.${key}.variants.${variant}`,
          message: `value "${String(value)}" is not one of the declared variants (${declaration.variants.join(', ')})`,
        });
      }
    }
  }
  return issues;
}

export interface StaleFlag {
  key: string;
  reasons: Array<'unused' | 'expired' | 'static' | 'undeclared'>;
  lastEvaluated?: string;
  expiresAt?: string;
  owner?: string;
}

/**
 * Every write to the ruleset goes through here: validation (structure and declared types),
 * authorization, approvals, and the audit trail the store writes.
 */
export class FlagsAdmin {
  constructor(
    readonly store: FlagsStore,
    private readonly options: {
      environment: string;
      declarations: Record<string, FlagDeclaration>;
      approvals?: ApprovalsConfig;
      authorize?: AdminAuthorizer;
      onApplied?: (environment: string, version: string) => void;
    },
  ) {}

  get environment() {
    return this.options.environment;
  }

  get declarations() {
    return this.options.declarations;
  }

  requiresApproval(environment: string): boolean {
    const envs = this.options.approvals?.environments;
    return envs === true || (Array.isArray(envs) && envs.includes(environment));
  }

  /** Approvals mean nothing between anonymous actors: refuse them where approvals are on. */
  #assertIdentified(actor: Actor, environment: string) {
    if (actor.anonymous && this.requiresApproval(environment)) {
      throw new ForbiddenError(
        `changes to "${environment}" need approval, so the person acting must be identified (sign in, or set \`actor\` in the console config)`,
      );
    }
  }

  async #authorize(actor: Actor, action: AdminAction, target: Parameters<AdminAuthorizer>[2]) {
    if (!this.options.authorize) return;
    if (!(await this.options.authorize(actor, action, target))) {
      throw new ForbiddenError(`${actor.id} may not ${action} flags in ${target.environment}`);
    }
  }

  /** The ruleset after `change`, validated. Throws {@link ValidationError}. */
  async preview(change: RulesetChange, environment = this.environment): Promise<Ruleset> {
    const current = await this.store.readRuleset(environment);
    const next = applyChange(current, change);
    const issues = [...validateRuleset(next), ...checkAgainstDeclarations(next, this.declarations)];
    // Only issues the change introduces block it; pre-existing ones are reported elsewhere.
    const before = new Set(
      [...validateRuleset(current), ...checkAgainstDeclarations(current, this.declarations)].map(
        (i) => `${i.path}\u0000${i.message}`,
      ),
    );
    const introduced = issues.filter((i) => !before.has(`${i.path}\u0000${i.message}`));
    if (introduced.length > 0) throw new ValidationError(introduced);
    return next;
  }

  /** Applies a change, or files a change request when the environment needs approval. */
  async propose(
    change: RulesetChange,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ): Promise<ProposeResult> {
    const environment = options.environment ?? this.environment;
    this.#assertIdentified(actor, environment);
    await this.#authorize(actor, 'write', { environment, change });
    await this.preview(change, environment);
    if (this.requiresApproval(environment)) {
      const request = await this.store.createChangeRequest({
        environment,
        change,
        ...(options.note ? { note: options.note } : {}),
        requestedBy: actor,
        baseVersion: await this.store.version(environment),
      });
      return { status: 'pending', request };
    }
    const { version } = await this.store.apply(environment, change, actor);
    this.options.onApplied?.(environment, version);
    return { status: 'applied', version };
  }

  /** Approves and applies a pending request. The requester cannot approve their own. */
  async approve(
    id: string,
    actor: Actor,
    note?: string,
  ): Promise<{ version: string; request: ChangeRequest }> {
    const request = await this.store.getChangeRequest(id);
    if (!request) throw new Error(`change request ${id} not found`);
    if (request.status !== 'pending') throw new Error(`change request ${id} is ${request.status}`);
    this.#assertIdentified(actor, request.environment);
    if (request.requestedBy.id === actor.id) {
      throw new ForbiddenError('a change cannot be approved by the person who requested it');
    }
    await this.#authorize(actor, 'approve', {
      environment: request.environment,
      request,
      change: request.change,
    });
    // Re-validate against the CURRENT ruleset: it may have moved since the request was filed.
    await this.preview(request.change, request.environment);
    await this.store.updateChangeRequest(id, {
      status: 'approved',
      reviewedBy: actor,
      reviewedAt: new Date(),
      ...(note ? { reviewNote: note } : {}),
    });
    const { version } = await this.store.apply(
      request.environment,
      request.change,
      request.requestedBy,
      {
        changeRequestId: id,
      },
    );
    const applied = await this.store.updateChangeRequest(id, { status: 'applied' });
    this.options.onApplied?.(request.environment, version);
    return { version, request: applied };
  }

  async reject(id: string, actor: Actor, note?: string): Promise<ChangeRequest> {
    const request = await this.store.getChangeRequest(id);
    if (!request) throw new Error(`change request ${id} not found`);
    if (request.status !== 'pending') throw new Error(`change request ${id} is ${request.status}`);
    this.#assertIdentified(actor, request.environment);
    await this.#authorize(actor, 'approve', { environment: request.environment, request });
    return this.store.updateChangeRequest(id, {
      status: 'rejected',
      reviewedBy: actor,
      reviewedAt: new Date(),
      ...(note ? { reviewNote: note } : {}),
    });
  }

  async cancel(id: string, actor: Actor): Promise<ChangeRequest> {
    const request = await this.store.getChangeRequest(id);
    if (!request) throw new Error(`change request ${id} not found`);
    if (request.requestedBy.id !== actor.id)
      throw new ForbiddenError('only the requester can cancel a change request');
    if (request.status !== 'pending') throw new Error(`change request ${id} is ${request.status}`);
    return this.store.updateChangeRequest(id, { status: 'cancelled' });
  }

  /** The stored definition, or the one the declaration implies. */
  async definition(key: string, environment = this.environment): Promise<FlagDefinition> {
    const ruleset = await this.store.readRuleset(environment);
    const existing = ruleset.flags[key];
    if (existing) return existing;
    const declaration = this.declarations[key];
    if (!declaration)
      throw new Error(`flag "${key}" is neither in the ruleset nor declared in code`);
    return definitionFromDeclaration(declaration);
  }

  /**
   * Saves a flag's targeting. A console declaration already stored on the flag is kept when the new
   * definition does not carry one, so editing targeting never drops a flag's type and default.
   */
  async saveFlag(
    key: string,
    definition: FlagDefinition,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ) {
    let value = definition;
    if (!definition.declaration) {
      const current = (await this.store.readRuleset(options.environment ?? this.environment)).flags[
        key
      ];
      if (current?.declaration) value = { ...definition, declaration: current.declaration };
    }
    return this.propose({ entity: 'flag', key, value }, actor, options);
  }

  /**
   * Creates a flag from the console: its declaration (type, default, metadata) and a starting
   * targeting that serves the default to everyone. Refused when the key is declared in code or
   * already exists in this environment.
   */
  async createFlag(
    key: string,
    declaration: FlagDeclaration,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ): Promise<ProposeResult> {
    if (!FLAG_KEY.test(key)) {
      throw new ValidationError([
        { path: 'key', message: 'use letters, digits, ".", "_" or "-" (1–100 characters)' },
      ]);
    }
    if (this.declarations[key]) {
      throw new ValidationError([
        { path: 'key', message: `"${key}" is declared in code; configure it instead` },
      ]);
    }
    const environment = options.environment ?? this.environment;
    if ((await this.store.readRuleset(environment)).flags[key]) {
      throw new ValidationError([
        { path: 'key', message: `"${key}" already exists in ${environment}` },
      ]);
    }
    const definition = {
      ...definitionFromDeclaration(declaration),
      declaration: toData(declaration),
    };
    return this.propose({ entity: 'flag', key, value: definition }, actor, options);
  }

  /** Changes a console flag's declaration (description, owner, expiry, default, …). */
  async updateDeclaration(
    key: string,
    patch: Partial<FlagDeclaration>,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ): Promise<ProposeResult> {
    if (this.declarations[key]) {
      throw new ValidationError([
        { path: 'key', message: `"${key}" is declared in code; change it there` },
      ]);
    }
    const environment = options.environment ?? this.environment;
    const current = (await this.store.readRuleset(environment)).flags[key];
    if (!current?.declaration)
      throw new Error(`flag "${key}" has no console declaration in ${environment}`);
    if (patch.type !== undefined && patch.type !== current.declaration.type) {
      throw new ValidationError([
        {
          path: 'declaration.type',
          message: 'the type of an existing flag cannot change; create a new flag',
        },
      ]);
    }
    const declaration = toData({ ...fromData(current.declaration), ...patch } as FlagDeclaration);
    return this.propose(
      { entity: 'flag', key, value: { ...current, declaration } },
      actor,
      options,
    );
  }

  deleteFlag(key: string, actor: Actor, options?: { environment?: string; note?: string }) {
    return this.propose({ entity: 'flag', key, value: null }, actor, options);
  }

  /**
   * The kill switch: `false` serves `offVariant` to everyone regardless of targeting; `true` turns
   * targeting back on. To serve `on` to everyone, use {@link turnOn}.
   */
  async setEnabled(
    key: string,
    enabled: boolean,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ) {
    const definition = await this.definition(key, options.environment);
    return this.saveFlag(key, { ...definition, enabled }, actor, options);
  }

  /** Boolean flags: serves `on` to everyone (targeting rules and overrides still apply first). */
  turnOn(key: string, actor: Actor, options: { environment?: string; note?: string } = {}) {
    return this.setVariant(key, 'on', actor, options);
  }

  /** Boolean flags: serves `off` to everyone not matched by a rule or override. */
  turnOff(key: string, actor: Actor, options: { environment?: string; note?: string } = {}) {
    return this.setVariant(key, 'off', actor, options);
  }

  /** Serves one variant to everyone (clears any split on the fallthrough). */
  async setVariant(
    key: string,
    variant: string,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ) {
    const definition = await this.definition(key, options.environment);
    return this.saveFlag(
      key,
      { ...definition, enabled: true, fallthrough: { variant } },
      actor,
      options,
    );
  }

  /**
   * Percentage rollout of a boolean flag: `percent`% get `on`. Keeps the `on` arm first so raising
   * the percentage only adds people (see `pickVariant`).
   */
  async setRollout(
    key: string,
    percent: number,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ) {
    if (!(percent >= 0 && percent <= 100))
      throw new RangeError('percent must be between 0 and 100');
    const definition = await this.definition(key, options.environment);
    if (!Object.hasOwn(definition.variants, 'on') || !Object.hasOwn(definition.variants, 'off')) {
      throw new Error(`flag "${key}" is not an on/off flag; edit its split instead`);
    }
    const fallthrough =
      percent === 100
        ? { variant: 'on' }
        : percent === 0
          ? { variant: 'off' }
          : {
              split: [
                { variant: 'on', weight: Math.round(percent * 100) },
                { variant: 'off', weight: 10_000 - Math.round(percent * 100) },
              ],
            };
    return this.saveFlag(key, { ...definition, enabled: true, fallthrough }, actor, options);
  }

  /** Forces a variant for one subject (`null` removes the override). */
  async setOverride(
    key: string,
    subject: string,
    variant: string | null,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ) {
    const definition = await this.definition(key, options.environment);
    const overrides = { ...(definition.overrides ?? {}) };
    if (variant === null) delete overrides[subject];
    else overrides[subject] = variant;
    return this.saveFlag(key, { ...definition, overrides }, actor, options);
  }

  // ── Scheduling ────────────────────────────────────────────────────────────

  async schedule(
    input: Omit<ScheduledChange, 'id' | 'status' | 'createdBy' | 'environment'> & {
      environment?: string;
    },
    actor: Actor,
  ): Promise<ScheduledChange> {
    const environment = input.environment ?? this.environment;
    await this.#authorize(actor, 'write', { environment });
    if (
      input.kind === 'rollout' &&
      !(Number(input.payload.percent) >= 0 && Number(input.payload.percent) <= 100)
    ) {
      throw new RangeError('a rollout schedule needs payload.percent between 0 and 100');
    }
    return this.store.createSchedule({ ...input, environment, createdBy: actor });
  }

  /** A gradual rollout: one schedule per step (`[{ at, percent }]`). */
  async scheduleRollout(
    key: string,
    steps: Array<{ at: Date; percent: number }>,
    actor: Actor,
    options: { environment?: string } = {},
  ): Promise<ScheduledChange[]> {
    const out: ScheduledChange[] = [];
    for (const step of [...steps].sort((a, b) => a.at.getTime() - b.at.getTime())) {
      out.push(
        await this.schedule(
          {
            flag: key,
            kind: 'rollout',
            payload: { percent: step.percent },
            runAt: step.at,
            ...options,
          },
          actor,
        ),
      );
    }
    return out;
  }

  async cancelSchedule(id: string, actor: Actor): Promise<ScheduledChange> {
    const schedule = await this.store.getSchedule(id);
    if (!schedule) throw new Error(`schedule ${id} not found`);
    await this.#authorize(actor, 'write', { environment: schedule.environment });
    if (schedule.status !== 'pending') throw new Error(`schedule ${id} is ${schedule.status}`);
    return this.store.updateSchedule(id, { status: 'cancelled' });
  }

  /**
   * Executes due schedules. Each is claimed atomically, so replicas running this concurrently apply
   * each step once. Scheduled changes skip approvals: they were authorized when scheduled.
   */
  async runDueSchedules(
    now = new Date(),
  ): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const due = await this.store.listSchedules({ status: 'pending', dueBefore: now, limit: 100 });
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const schedule of due) {
      if (!(await this.store.claimSchedule(schedule.id))) continue;
      const actor: Actor = {
        id: `schedule:${schedule.id}`,
        name: `scheduled by ${schedule.createdBy.id}`,
      };
      try {
        const definition = await this.definition(schedule.flag, schedule.environment);
        let change: RulesetChange;
        if (schedule.kind === 'enable' || schedule.kind === 'disable') {
          change = {
            entity: 'flag',
            key: schedule.flag,
            value: { ...definition, enabled: schedule.kind === 'enable' },
          };
        } else if (schedule.kind === 'rollout') {
          const percent = Number(schedule.payload.percent);
          change = {
            entity: 'flag',
            key: schedule.flag,
            value: {
              ...definition,
              enabled: true,
              fallthrough:
                percent >= 100
                  ? { variant: 'on' }
                  : percent <= 0
                    ? { variant: 'off' }
                    : {
                        split: [
                          { variant: 'on', weight: Math.round(percent * 100) },
                          { variant: 'off', weight: 10_000 - Math.round(percent * 100) },
                        ],
                      },
            },
          };
        } else {
          if (!schedule.payload.change) throw new Error('a change schedule needs payload.change');
          change = schedule.payload.change;
        }
        await this.preview(change, schedule.environment);
        const { version } = await this.store.apply(schedule.environment, change, actor);
        this.options.onApplied?.(schedule.environment, version);
        await this.store.updateSchedule(schedule.id, { status: 'done', executedAt: new Date() });
        results.push({ id: schedule.id, ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.updateSchedule(schedule.id, {
          status: 'failed',
          error: message,
          executedAt: new Date(),
        });
        results.push({ id: schedule.id, ok: false, error: message });
      }
    }
    return results;
  }

  // ── Import / export / promote ─────────────────────────────────────────────

  async exportRuleset(environment = this.environment): Promise<Ruleset> {
    return this.store.readRuleset(environment);
  }

  async importRuleset(
    ruleset: Pick<Ruleset, 'flags'> & Partial<Ruleset>,
    actor: Actor,
    options: { environment?: string; note?: string } = {},
  ): Promise<ProposeResult> {
    if (ruleset.schemaVersion !== undefined && ruleset.schemaVersion > RULESET_SCHEMA_VERSION) {
      throw new ValidationError([
        { path: 'schemaVersion', message: `this version supports up to ${RULESET_SCHEMA_VERSION}` },
      ]);
    }
    return this.propose(
      {
        entity: 'ruleset',
        value: {
          flags: ruleset.flags,
          segments: ruleset.segments ?? {},
          layers: ruleset.layers ?? {},
          ...(ruleset.holdout ? { holdout: ruleset.holdout } : {}),
        },
      },
      actor,
      options,
    );
  }

  /** Copies one environment's ruleset over another's (staging → production). */
  async promote(from: string, to: string, actor: Actor, note?: string): Promise<ProposeResult> {
    await this.#authorize(actor, 'read', { environment: from });
    const source = await this.store.readRuleset(from);
    return this.importRuleset(source, actor, { environment: to, ...(note ? { note } : {}) });
  }

  // ── Hygiene ───────────────────────────────────────────────────────────────

  /**
   * Flags that probably should be removed: not evaluated for `unusedDays` (`unused`), past their
   * declared expiry (`expired`), serving one value to everyone for `staticDays` — fully rolled out
   * or killed (`static`), or in the ruleset but declared by no app (`undeclared`).
   */
  async stale(
    options: { environment?: string; unusedDays?: number; staticDays?: number; now?: Date } = {},
  ): Promise<StaleFlag[]> {
    const environment = options.environment ?? this.environment;
    const now = options.now ?? new Date();
    const unusedDays = options.unusedDays ?? 30;
    const staticDays = options.staticDays ?? 30;
    const since = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
    const [ruleset, usage, declaredRows] = await Promise.all([
      this.store.readRuleset(environment),
      this.store.usage({ environment, since }),
      this.store.declarations(),
    ]);
    const lastSeen = new Map<string, string>();
    for (const row of usage) {
      if (row.evaluations > 0 && (lastSeen.get(row.flag) ?? '') < row.day)
        lastSeen.set(row.flag, row.day);
    }
    const declared = new Map<string, FlagDeclaration>(Object.entries(this.declarations));
    for (const [key, definition] of Object.entries(ruleset.flags)) {
      if (definition.declaration && !declared.has(key))
        declared.set(key, fromData(definition.declaration));
    }
    for (const row of declaredRows)
      if (!declared.has(row.key)) declared.set(row.key, row.declaration);

    const unusedCutoff = new Date(now.getTime() - unusedDays * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const staticCutoff = now.getTime() - staticDays * 86_400_000;
    const keys = new Set([...Object.keys(ruleset.flags), ...declared.keys()]);
    const out: StaleFlag[] = [];
    for (const key of [...keys].sort()) {
      const reasons: StaleFlag['reasons'] = [];
      const declaration = declared.get(key);
      const definition = ruleset.flags[key];
      const seen = lastSeen.get(key);
      if (!seen || seen < unusedCutoff) reasons.push('unused');
      if (declaration?.expiresAt && new Date(declaration.expiresAt).getTime() < now.getTime())
        reasons.push('expired');
      if (definition && !declaration) reasons.push('undeclared');
      if (definition) {
        const isStatic =
          !definition.enabled ||
          ((definition.rules?.length ?? 0) === 0 &&
            Object.keys(definition.overrides ?? {}).length === 0 &&
            'variant' in definition.fallthrough);
        if (isStatic) {
          const lastChange = (
            await this.store.audit({ environment, entity: 'flag', key, limit: 1 })
          )[0];
          if (!lastChange || lastChange.at.getTime() < staticCutoff) reasons.push('static');
        }
      }
      if (reasons.length > 0) {
        out.push({
          key,
          reasons,
          ...(seen ? { lastEvaluated: seen } : {}),
          ...(declaration?.expiresAt ? { expiresAt: declaration.expiresAt } : {}),
          ...(declaration?.owner ? { owner: declaration.owner } : {}),
        });
      }
    }
    return out;
  }
}
