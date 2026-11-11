import {
  type EvaluationContext,
  evaluate,
  type FlagDefinition,
  type Holdout,
  type JsonValue,
  type Layer,
  OPERATORS,
  type Ruleset,
  type RulesetIssue,
  type Segment,
  type Serve,
} from '@adonis-agora/flags-core';
import { type FlagsAdmin, ForbiddenError, type ProposeResult, ValidationError } from '../admin.js';
import type { FlagDeclaration } from '../declare.js';
import { knownTenants } from '../http/control_plane.js';
import type { FlagsRuntime } from '../runtime.js';
import { getRuntime } from '../services/accessor.js';
import {
  type Actor,
  applyChange,
  type ChangeRequestStatus,
  type EntityType,
  type FlagsStore,
  type RulesetChange,
  type ScheduledChange,
} from '../stores/store.js';
import type { SinkStatus } from '../transports/transport.js';
import {
  flagDefinitionIssues,
  holdoutIssues,
  layerIssues,
  rulesetIssues,
  segmentIssues,
} from './shape.js';

/**
 * Framework-light JSON handlers for the flags console.
 *
 * Each handler takes {@link Deps} (the runtime — `getRuntime()` unless a test hands one over — and
 * the acting person) and a plain {@link ApiRequest}, and returns a plain {@link ApiResponse}. No
 * AdonisJS types leak in, so they are unit-testable against a real runtime with no HTTP server.
 * Same `Deps` / `ApiRequest` / `ApiResponse` convention as the payments and durable consoles.
 *
 * Every WRITE goes through `FlagsAdmin` — never the store directly — so the console gets exactly
 * the validation, authorization, approvals and audit trail the commands get. Errors map to HTTP:
 * `ValidationError` → `422 { error, issues }`, `ForbiddenError` → `403`, a missing change request
 * → `404`, one that is no longer pending → `409`.
 *
 * Every call takes an `environment` (query string for reads, body for writes); omitted, it is the
 * environment this app evaluates.
 */

/** What the handlers need to answer a request. */
export interface Deps {
  /** The booted runtime. Default: {@link getRuntime}. */
  runtime?: FlagsRuntime;
  /** Who is acting — the audit log and the two-person rule are keyed on `actor.id`. */
  actor: Actor;
  /** Injectable clock (stale report). */
  now?: () => Date;
}

/** The subset of an HTTP request the handlers read. */
export interface ApiRequest {
  params: Record<string, string | undefined>;
  query: Record<string, string | string[] | undefined>;
  body?: unknown;
}

/** A plain JSON response: an HTTP status and a serializable body. */
export interface ApiResponse {
  status: number;
  body: unknown;
}

export const ok = (body: unknown): ApiResponse => ({ status: 200, body });

/** An error that already knows its HTTP answer. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const invalid = (issues: RulesetIssue[]) =>
  new HttpError(422, 'invalid change', { issues } as Record<string, unknown>);

/** Map anything a handler threw to the answer the SPA can show. */
export function errorResponse(error: unknown): ApiResponse {
  if (error instanceof HttpError) {
    return { status: error.status, body: { error: error.message, ...error.extra } };
  }
  if (error instanceof ValidationError) {
    return { status: 422, body: { error: 'invalid change', issues: error.issues } };
  }
  if (error instanceof ForbiddenError) return { status: 403, body: { error: error.message } };
  if (error instanceof RangeError) return { status: 400, body: { error: error.message } };
  const message = error instanceof Error ? error.message : String(error);
  // `FlagsAdmin` reports these as plain errors; their wording is the contract.
  if (/ not found$|neither in the ruleset nor declared/.test(message)) {
    return { status: 404, body: { error: message } };
  }
  if (/^change request \S+ is \w+$/.test(message)) return { status: 409, body: { error: message } };
  if (/is not an on\/off flag|needs payload/.test(message)) {
    return { status: 400, body: { error: message } };
  }
  return { status: 500, body: { error: message || 'internal error' } };
}

interface Owned {
  runtime: FlagsRuntime;
  admin: FlagsAdmin;
  store: FlagsStore;
}

/** The runtime, and its admin + store — a tenant has neither (it edits on its control-plane). */
function owned(deps: Deps): Owned {
  const runtime = deps.runtime ?? getRuntime();
  if (runtime.topology === 'tenant' || !runtime.admin || !runtime.store) {
    throw new HttpError(
      503,
      'This app is a flags tenant: flags are edited on the control-plane console, not here.',
    );
  }
  return { runtime, admin: runtime.admin, store: runtime.store };
}

/** Runs a handler body and maps whatever it throws. */
async function handle(
  deps: Deps,
  fn: (o: Owned) => Promise<ApiResponse> | ApiResponse,
): Promise<ApiResponse> {
  try {
    return await fn(owned(deps));
  } catch (error) {
    return errorResponse(error);
  }
}

// ── Request parsing ─────────────────────────────────────────────────────────

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === '' ? undefined : v;
}

function bodyOf(req: ApiRequest): Record<string, unknown> {
  const body = req.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

const ENVIRONMENT = /^[A-Za-z0-9_.-]{1,64}$/;

function checkEnvironment(value: unknown, field = 'environment'): string {
  if (typeof value !== 'string' || !ENVIRONMENT.test(value)) {
    throw new HttpError(400, `${field} must be 1–64 letters, digits, "_", "-" or "."`);
  }
  return value;
}

/** `environment` from the body (writes) or the query string (reads); the app's own by default. */
function environmentOf(req: ApiRequest, runtime: FlagsRuntime): string {
  const value = bodyOf(req).environment ?? first(req.query.environment);
  return value === undefined ? runtime.manager.environment : checkEnvironment(value);
}

function keyParam(req: ApiRequest, name = 'key'): string {
  const key = req.params[name];
  if (key === undefined || key === '' || key.length > 200) {
    throw new HttpError(400, `${name} is required`);
  }
  return key;
}

function noteOf(req: ApiRequest): string | undefined {
  const note = bodyOf(req).note;
  if (note === undefined || note === null || note === '') return undefined;
  if (typeof note !== 'string') throw new HttpError(400, 'note must be a string');
  return note.slice(0, 2000);
}

function intQuery(req: ApiRequest, name: string, fallback: number, max: number): number {
  const raw = first(req.query[name]);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} must be a positive integer`);
  return Math.min(n, max);
}

/** Options for `FlagsAdmin.propose` and friends, without `undefined` keys. */
function writeOptions(environment: string, note: string | undefined) {
  return note !== undefined ? { environment, note } : { environment };
}

/** `200` when applied, `202` when it became a change request waiting for a second person. */
function proposed(result: ProposeResult): ApiResponse {
  return { status: result.status === 'applied' ? 200 : 202, body: result };
}

// ── Declarations and summaries ──────────────────────────────────────────────

/** A declaration as the console shows it: what the code says, and which apps say it. */
export interface DeclaredFlag extends FlagDeclaration {
  apps: string[];
}

/** This app's declarations plus every app's pushed ones (a control-plane hears from tenants). */
async function declarationsOf(o: Owned): Promise<Map<string, DeclaredFlag>> {
  const out = new Map<string, DeclaredFlag>();
  const app = o.runtime.manager.app;
  for (const [key, declaration] of Object.entries(o.admin.declarations)) {
    out.set(key, { ...declaration, apps: [app] });
  }
  for (const row of await o.store.declarations()) {
    const existing = out.get(row.key);
    if (existing) {
      if (!existing.apps.includes(row.app)) existing.apps.push(row.app);
    } else {
      out.set(row.key, { ...row.declaration, apps: [row.app] });
    }
  }
  return out;
}

/** What a flag serves to someone no rule or override matches. */
export type Serving =
  /** Not in the ruleset: everyone gets the default declared in code. */
  | { kind: 'default'; value: JsonValue | null }
  /** Kill switch: everyone gets `offVariant`. */
  | { kind: 'off'; variant: string }
  | { kind: 'fixed'; variant: string }
  /** An on/off split: `percent`% get `on`. */
  | { kind: 'rollout'; percent: number }
  | { kind: 'split'; arms: Array<{ variant: string; percent: number }>; bucketBy?: string };

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function serveSummary(serve: Serve): Serving {
  if ('variant' in serve) return { kind: 'fixed', variant: serve.variant };
  const total = serve.split.reduce((sum, arm) => sum + Math.max(0, arm.weight), 0);
  const arms = serve.split.map((arm) => ({
    variant: arm.variant,
    percent: total > 0 ? round((Math.max(0, arm.weight) / total) * 100) : 0,
  }));
  const names = arms.map((arm) => arm.variant).sort();
  if (
    serve.bucketBy === undefined &&
    names.length === 2 &&
    names[0] === 'off' &&
    names[1] === 'on'
  ) {
    return { kind: 'rollout', percent: arms.find((arm) => arm.variant === 'on')?.percent ?? 0 };
  }
  return { kind: 'split', arms, ...(serve.bucketBy ? { bucketBy: serve.bucketBy } : {}) };
}

/** The one-line "what does this serve" every flag row shows. */
export function servingSummary(
  definition: FlagDefinition | undefined,
  declaration?: FlagDeclaration,
): Serving {
  if (!definition) return { kind: 'default', value: declaration?.default ?? null };
  if (!definition.enabled) return { kind: 'off', variant: definition.offVariant };
  return serveSummary(definition.fallthrough);
}

function flagTags(
  definition: FlagDefinition | undefined,
  declaration: FlagDeclaration | undefined,
) {
  return [...new Set([...(declaration?.tags ?? []), ...(definition?.tags ?? [])])].sort();
}

// ── Meta ────────────────────────────────────────────────────────────────────

/** `GET /api/meta` — what the shell needs: environments, approvals, who you are. */
export function meta(deps: Deps, _req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const current = o.runtime.manager.environment;
    const environments = [...new Set([current, ...(await o.store.environments())])].sort();
    const experiments =
      o.runtime.config.topology !== 'tenant' ? Object.keys(o.runtime.config.experiments ?? {}) : [];
    return ok({
      app: o.runtime.manager.app,
      topology: o.runtime.topology,
      environment: current,
      environments,
      approvals: Object.fromEntries(environments.map((e) => [e, o.admin.requiresApproval(e)])),
      actor: deps.actor,
      operators: OPERATORS,
      analytics: o.runtime.analytics !== undefined,
      experiments,
    });
  });
}

// ── Flags ───────────────────────────────────────────────────────────────────

/** `GET /api/flags` — every flag in the ruleset or declared in code, with what it serves. */
export function listFlags(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const [ruleset, declared, stale] = await Promise.all([
      o.store.readRuleset(environment),
      declarationsOf(o),
      o.admin.stale({ environment, ...(deps.now ? { now: deps.now() } : {}) }),
    ]);
    const staleByKey = new Map(stale.map((s) => [s.key, s.reasons]));
    const keys = [...new Set([...Object.keys(ruleset.flags), ...declared.keys()])].sort();
    const flags = keys.map((key) => {
      const definition = ruleset.flags[key];
      const declaration = declared.get(key);
      return {
        key,
        declaration: declaration ?? null,
        inRuleset: definition !== undefined,
        enabled: definition ? definition.enabled : null,
        serving: servingSummary(definition, declaration),
        tags: flagTags(definition, declaration),
        owner: declaration?.owner ?? null,
        expiresAt: declaration?.expiresAt ?? null,
        experiment: definition?.experiment !== undefined,
        rules: definition?.rules?.length ?? 0,
        overrides: Object.keys(definition?.overrides ?? {}).length,
        stale: staleByKey.get(key) ?? [],
      };
    });
    return ok({ environment, version: ruleset.version, flags });
  });
}

/** `GET /api/flags/:key` — one flag: its definition (stored, or what the declaration implies), its
 *  audit trail, schedules and pending requests, plus the names the editor offers. */
export function flagDetail(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const [ruleset, declared] = await Promise.all([
      o.store.readRuleset(environment),
      declarationsOf(o),
    ]);
    const stored = ruleset.flags[key];
    const declaration = declared.get(key);
    if (!stored && !declaration) {
      throw new HttpError(404, `flag "${key}" is neither in the ruleset nor declared in code`);
    }
    const [audit, schedules, pending] = await Promise.all([
      o.store.audit({ environment, entity: 'flag', key, limit: 50 }),
      o.store.listSchedules({ environment, flag: key, limit: 100 }),
      o.store.listChangeRequests({ environment, status: 'pending', limit: 200 }),
    ]);
    return ok({
      environment,
      version: ruleset.version,
      key,
      declaration: declaration ?? null,
      stored: stored ?? null,
      definition: stored ?? (await o.admin.definition(key, environment)),
      serving: servingSummary(stored, declaration),
      audit,
      schedules,
      pendingRequests: pending.filter((r) => r.change.entity === 'flag' && r.change.key === key),
      requiresApproval: o.admin.requiresApproval(environment),
      segments: Object.keys(ruleset.segments ?? {}).sort(),
      layers: Object.keys(ruleset.layers ?? {}).sort(),
      flags: Object.fromEntries(
        Object.entries(ruleset.flags)
          .filter(([other]) => other !== key)
          .map(([other, def]) => [other, Object.keys(def.variants)]),
      ),
    });
  });
}

/** `PUT /api/flags/:key` `{ definition, note? }` — save the whole definition. */
export function saveFlag(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const definition = bodyOf(req).definition;
    const issues = flagDefinitionIssues(definition);
    if (issues.length > 0) throw invalid(issues);
    return proposed(
      await o.admin.saveFlag(
        key,
        definition as FlagDefinition,
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

/** `DELETE /api/flags/:key` — remove the flag from the ruleset (the code default takes over). */
export function deleteFlag(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const ruleset = await o.store.readRuleset(environment);
    if (!ruleset.flags[key]) throw new HttpError(404, `flag "${key}" is not in the ruleset`);
    return proposed(
      await o.admin.deleteFlag(key, deps.actor, writeOptions(environment, noteOf(req))),
    );
  });
}

/** `POST /api/flags/:key/enabled` `{ enabled }` — the kill switch. */
export function setEnabled(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const enabled = bodyOf(req).enabled;
    if (typeof enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean');
    return proposed(
      await o.admin.setEnabled(key, enabled, deps.actor, writeOptions(environment, noteOf(req))),
    );
  });
}

/** `POST /api/flags/:key/rollout` `{ percent }` — on/off flags only. */
export function setRollout(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const percent = bodyOf(req).percent;
    if (typeof percent !== 'number' || !Number.isFinite(percent)) {
      throw new HttpError(400, 'percent must be a number between 0 and 100');
    }
    return proposed(
      await o.admin.setRollout(key, percent, deps.actor, writeOptions(environment, noteOf(req))),
    );
  });
}

/** `POST /api/flags/:key/variant` `{ variant }` — serve one variant to everyone. */
export function setVariant(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const variant = bodyOf(req).variant;
    if (typeof variant !== 'string' || variant === '') {
      throw new HttpError(400, 'variant must be a non-empty string');
    }
    return proposed(
      await o.admin.setVariant(key, variant, deps.actor, writeOptions(environment, noteOf(req))),
    );
  });
}

/** `POST /api/flags/:key/overrides` `{ subject, variant | null }` — force (or clear) one subject. */
export function setOverride(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const { subject, variant } = bodyOf(req);
    if (typeof subject !== 'string' || subject === '') {
      throw new HttpError(400, 'subject must be a non-empty string');
    }
    if (variant !== null && (typeof variant !== 'string' || variant === '')) {
      throw new HttpError(400, 'variant must be a variant name, or null to remove the override');
    }
    return proposed(
      await o.admin.setOverride(
        key,
        subject,
        variant,
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

// ── Preview and evaluate ────────────────────────────────────────────────────

const PREVIEW_ENTITIES = new Set<EntityType>(['flag', 'segment', 'layer', 'holdout']);

/** Parse `{ entity, key, value }` into a {@link RulesetChange}, shape-checked. */
function changeOf(raw: unknown): RulesetChange {
  if (typeof raw !== 'object' || raw === null) throw new HttpError(400, 'change is required');
  const { entity, key, value } = raw as { entity?: unknown; key?: unknown; value?: unknown };
  if (typeof entity !== 'string' || !PREVIEW_ENTITIES.has(entity as EntityType)) {
    throw new HttpError(400, 'change.entity must be flag, segment, layer or holdout');
  }
  if (entity === 'holdout') {
    const issues = holdoutIssues(value ?? null, 'change.value');
    if (issues.length > 0) throw invalid(issues);
    return { entity: 'holdout', value: (value ?? null) as Holdout | null };
  }
  if (typeof key !== 'string' || key === '') throw new HttpError(400, 'change.key is required');
  if (value === null) return { entity, key, value: null } as RulesetChange;
  const issues =
    entity === 'flag'
      ? flagDefinitionIssues(value, 'change.value')
      : entity === 'segment'
        ? segmentIssues(value, 'change.value')
        : layerIssues(value, 'change.value');
  if (issues.length > 0) throw invalid(issues);
  return { entity, key, value } as RulesetChange;
}

/**
 * `POST /api/preview` `{ environment, change }` — would this edit be accepted? Answers `200` either
 * way (`{ valid, issues }`): the editor calls it on every keystroke, and an invalid draft is the
 * normal state of a form being typed into, not an error.
 */
export function preview(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    let change: RulesetChange;
    try {
      change = changeOf(bodyOf(req).change);
    } catch (error) {
      if (error instanceof HttpError && error.status === 422) {
        return ok({ valid: false, issues: error.extra.issues });
      }
      throw error;
    }
    try {
      const next = await o.admin.preview(change, environment);
      const serving =
        change.entity === 'flag' && change.value
          ? servingSummary(next.flags[change.key], o.admin.declarations[change.key])
          : null;
      return ok({ valid: true, issues: [], serving });
    } catch (error) {
      if (error instanceof ValidationError) return ok({ valid: false, issues: error.issues });
      throw error;
    }
  });
}

function contextOf(raw: unknown): EvaluationContext {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'context must be an object of attributes');
  }
  const context = raw as EvaluationContext;
  if (context.targetingKey !== undefined && typeof context.targetingKey !== 'string') {
    throw new HttpError(400, 'context.targetingKey must be a string');
  }
  return context;
}

/**
 * `POST /api/evaluate` `{ environment, context, flag?, definition? }` — what a context would get.
 *
 * Evaluates with the engine directly against the environment's STORED ruleset, so it records no
 * exposure and counts no usage: testing a rule must not enrol a fake user in an experiment. With
 * `definition`, the unsaved draft is evaluated in place of the stored flag. Without `flag`, every
 * flag is evaluated.
 */
export function evaluateContext(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const body = bodyOf(req);
    const context = contextOf(body.context);
    let ruleset: Ruleset = await o.store.readRuleset(environment);
    const declared = await declarationsOf(o);
    const flag = body.flag;
    if (flag !== undefined && (typeof flag !== 'string' || flag === '')) {
      throw new HttpError(400, 'flag must be a flag key');
    }
    if (body.definition !== undefined) {
      if (typeof flag !== 'string') throw new HttpError(400, 'a draft definition needs a flag');
      const issues = flagDefinitionIssues(body.definition);
      if (issues.length > 0) throw invalid(issues);
      ruleset = applyChange(ruleset, {
        entity: 'flag',
        key: flag,
        value: body.definition as FlagDefinition,
      });
    }
    const one = (key: string) =>
      evaluate(ruleset, key, (declared.get(key)?.default ?? null) as JsonValue, context);
    if (typeof flag === 'string') return ok({ environment, result: one(flag) });
    const keys = [...new Set([...Object.keys(ruleset.flags), ...declared.keys()])].sort();
    return ok({ environment, results: keys.map(one) });
  });
}

// ── Segments, layers, holdout ───────────────────────────────────────────────

function referencingFlags(ruleset: Ruleset, segment: string): string[] {
  const out: string[] = [];
  for (const [key, flag] of Object.entries(ruleset.flags)) {
    const uses = (flag.rules ?? []).some((rule) =>
      rule.conditions.some((c) => 'segment' in c && c.segment === segment),
    );
    if (uses) out.push(key);
  }
  return out.sort();
}

/** `GET /api/segments` — every segment and the flags whose rules reference it. */
export function listSegments(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const ruleset = await o.store.readRuleset(environment);
    const segments = Object.entries(ruleset.segments ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, segment]) => ({ key, segment, usedBy: referencingFlags(ruleset, key) }));
    return ok({ environment, version: ruleset.version, segments });
  });
}

/** `PUT /api/segments/:key` `{ segment, note? }`. */
export function saveSegment(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const segment = bodyOf(req).segment;
    const issues = segmentIssues(segment);
    if (issues.length > 0) throw invalid(issues);
    return proposed(
      await o.admin.propose(
        { entity: 'segment', key, value: segment as Segment },
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

/** `DELETE /api/segments/:key` — refused (422) while a rule still references it. */
export function deleteSegment(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    return proposed(
      await o.admin.propose(
        { entity: 'segment', key, value: null },
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

/** `GET /api/layers` — layers with their allocations, the global holdout, and every experiment. */
export function listLayers(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const ruleset = await o.store.readRuleset(environment);
    const layers = Object.entries(ruleset.layers ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, layer]) => {
        const used = Object.values(layer.allocations).reduce(
          (sum, [start, end]) => sum + Math.max(0, end - start),
          0,
        );
        return { key, layer, allocatedPercent: round(used / 100) };
      });
    const experiments = Object.entries(ruleset.flags)
      .filter(([, flag]) => flag.experiment !== undefined)
      .map(([key, flag]) => ({
        flag: key,
        experiment: flag.experiment?.key ?? key,
        layer: flag.experiment?.layer ?? null,
        holdout: flag.experiment?.holdout !== false,
      }))
      .sort((a, b) => a.flag.localeCompare(b.flag));
    return ok({
      environment,
      version: ruleset.version,
      layers,
      holdout: ruleset.holdout ?? null,
      experiments,
    });
  });
}

/** `PUT /api/layers/:key` `{ layer, note? }`. */
export function saveLayer(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const layer = bodyOf(req).layer;
    const issues = layerIssues(layer);
    if (issues.length > 0) throw invalid(issues);
    return proposed(
      await o.admin.propose(
        { entity: 'layer', key, value: layer as Layer },
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

/** `DELETE /api/layers/:key`. */
export function deleteLayer(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    return proposed(
      await o.admin.propose(
        { entity: 'layer', key, value: null },
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

/** `PUT /api/holdout` `{ holdout | null, note? }` — `null` removes the global holdout. */
export function saveHoldout(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const holdout = bodyOf(req).holdout ?? null;
    const issues = holdoutIssues(holdout);
    if (issues.length > 0) throw invalid(issues);
    return proposed(
      await o.admin.propose(
        { entity: 'holdout', value: holdout as Holdout | null },
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

// ── Experiments ─────────────────────────────────────────────────────────────

function experimentConfigs(runtime: FlagsRuntime) {
  return runtime.config.topology === 'tenant' ? {} : (runtime.config.experiments ?? {});
}

/** `GET /api/experiments` — configured experiments with a summary of their last results. */
export function listExperiments(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const ruleset = await o.store.readRuleset(environment);
    const configs = experimentConfigs(o.runtime);
    const rows = [];
    const covered = new Set<string>();
    for (const [key, config] of Object.entries(configs)) {
      const flag = config.flag ?? key;
      covered.add(flag);
      const results = await o.runtime.manager.results(key);
      rows.push({
        key,
        flag,
        configured: true,
        metrics: config.metrics,
        guardrails: config.guardrails ?? [],
        running:
          ruleset.flags[flag]?.experiment !== undefined && ruleset.flags[flag]?.enabled === true,
        computedAt: results?.computedAt ?? null,
        exposures: results ? Object.values(results.exposures).reduce((sum, n) => sum + n, 0) : null,
        srmMismatch: results?.srm?.mismatch ?? false,
        alert: results?.metrics.some((m) => m.alert) ?? false,
        verdicts: results
          ? results.metrics.flatMap((m) =>
              m.comparisons.map((c) => ({
                metric: m.name,
                variant: c.variant,
                verdict: c.verdict,
              })),
            )
          : [],
      });
    }
    // Flags marked as experiments with no analysis configured: assignments are recorded, but
    // nothing will compute their numbers — worth seeing, not worth hiding.
    for (const [flag, definition] of Object.entries(ruleset.flags)) {
      if (!definition.experiment || covered.has(flag)) continue;
      rows.push({
        key: definition.experiment.key ?? flag,
        flag,
        configured: false,
        metrics: [],
        guardrails: [],
        running: definition.enabled,
        computedAt: null,
        exposures: null,
        srmMismatch: false,
        alert: false,
        verdicts: [],
      });
    }
    rows.sort((a, b) => a.key.localeCompare(b.key));
    return ok({ environment, analytics: o.runtime.analytics !== undefined, experiments: rows });
  });
}

/** `GET /api/experiments/:key` — the last computed results (the worker refreshes them). */
export function experimentDetail(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const key = keyParam(req);
    const config = experimentConfigs(o.runtime)[key];
    if (!config) throw new HttpError(404, `experiment "${key}" is not configured`);
    return ok({
      key,
      flag: config.flag ?? key,
      config,
      analytics: o.runtime.analytics !== undefined,
      results: await o.runtime.manager.results(key),
    });
  });
}

/** `POST /api/experiments/:key/recompute` — compute the results now instead of at the next tick. */
export function recomputeExperiment(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const key = keyParam(req);
    if (!experimentConfigs(o.runtime)[key]) {
      throw new HttpError(404, `experiment "${key}" is not configured`);
    }
    if (!o.runtime.worker || !o.runtime.analytics) {
      throw new HttpError(
        503,
        'No analytics backend is configured, so experiment results cannot be computed here.',
      );
    }
    const results = await o.runtime.worker.computeResults(key);
    if (!results) throw new HttpError(503, `results for "${key}" could not be computed`);
    return ok({ key, results });
  });
}

// ── Change requests ─────────────────────────────────────────────────────────

const REQUEST_STATUSES = new Set<ChangeRequestStatus>([
  'pending',
  'approved',
  'rejected',
  'applied',
  'cancelled',
]);

/** `GET /api/change-requests?status=pending|…|all`. */
export function listChangeRequests(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const status = first(req.query.status) ?? 'pending';
    if (status !== 'all' && !REQUEST_STATUSES.has(status as ChangeRequestStatus)) {
      throw new HttpError(400, `unknown status "${status}"`);
    }
    const requests = await o.store.listChangeRequests({
      environment,
      ...(status !== 'all' ? { status: status as ChangeRequestStatus } : {}),
      limit: intQuery(req, 'limit', 100, 500),
    });
    return ok({
      environment,
      requiresApproval: o.admin.requiresApproval(environment),
      actor: deps.actor,
      requests,
    });
  });
}

/** `POST /api/change-requests/:id/approve` `{ note? }` — the requester cannot approve (403). */
export function approveChangeRequest(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) =>
    ok(await o.admin.approve(keyParam(req, 'id'), deps.actor, noteOf(req))),
  );
}

/** `POST /api/change-requests/:id/reject` `{ note? }`. */
export function rejectChangeRequest(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) =>
    ok({ request: await o.admin.reject(keyParam(req, 'id'), deps.actor, noteOf(req)) }),
  );
}

/** `POST /api/change-requests/:id/cancel` — only the requester can withdraw their request. */
export function cancelChangeRequest(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) =>
    ok({ request: await o.admin.cancel(keyParam(req, 'id'), deps.actor) }),
  );
}

// ── Audit ───────────────────────────────────────────────────────────────────

const ENTITIES = new Set<EntityType>(['flag', 'segment', 'layer', 'holdout', 'ruleset']);

/** `GET /api/audit?entity&key&before&limit` — newest first; page with `before=<at of last row>`. */
export function audit(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const entity = first(req.query.entity);
    if (entity !== undefined && !ENTITIES.has(entity as EntityType)) {
      throw new HttpError(400, `unknown entity "${entity}"`);
    }
    const key = first(req.query.key);
    const beforeRaw = first(req.query.before);
    const before = beforeRaw !== undefined ? new Date(beforeRaw) : undefined;
    if (before !== undefined && Number.isNaN(before.getTime())) {
      throw new HttpError(400, 'before must be an ISO date');
    }
    const limit = intQuery(req, 'limit', 50, 200);
    const entries = await o.store.audit({
      environment,
      ...(entity !== undefined ? { entity: entity as EntityType } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(before !== undefined ? { before } : {}),
      limit,
    });
    return ok({ environment, entries, limit });
  });
}

// ── Schedules ───────────────────────────────────────────────────────────────

const SCHEDULE_STATUSES = new Set(['pending', 'running', 'done', 'failed', 'cancelled']);

/** `GET /api/schedules?flag&status`. */
export function listSchedules(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const flag = first(req.query.flag);
    const status = first(req.query.status);
    if (status !== undefined && !SCHEDULE_STATUSES.has(status)) {
      throw new HttpError(400, `unknown status "${status}"`);
    }
    const schedules = await o.store.listSchedules({
      environment,
      ...(flag !== undefined ? { flag } : {}),
      ...(status !== undefined ? { status: status as ScheduledChange['status'] } : {}),
      limit: intQuery(req, 'limit', 100, 500),
    });
    return ok({ environment, schedules });
  });
}

function dateOf(value: unknown, field: string): Date {
  const date = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw new HttpError(400, `${field} must be a date`);
  return date;
}

function percentOf(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new HttpError(400, `${field} must be a number between 0 and 100`);
  }
  return value;
}

/**
 * `POST /api/flags/:key/schedules` — either one change at a time
 * (`{ kind: 'enable' | 'disable' | 'rollout', runAt, percent? }`) or a gradual rollout
 * (`{ steps: [{ at, percent }] }`, one schedule per step).
 */
export function createSchedule(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const key = keyParam(req);
    const body = bodyOf(req);
    // Fail here, not when the step runs at 3am: the flag must exist to be scheduled.
    await o.admin.definition(key, environment);
    if (body.steps !== undefined) {
      if (!Array.isArray(body.steps) || body.steps.length === 0 || body.steps.length > 50) {
        throw new HttpError(400, 'steps must be a list of 1–50 { at, percent }');
      }
      const steps = body.steps.map((step: unknown, i: number) => {
        const s = (typeof step === 'object' && step !== null ? step : {}) as Record<
          string,
          unknown
        >;
        return {
          at: dateOf(s.at, `steps[${i}].at`),
          percent: percentOf(s.percent, `steps[${i}].percent`),
        };
      });
      const schedules = await o.admin.scheduleRollout(key, steps, deps.actor, { environment });
      return { status: 201, body: { schedules } };
    }
    const kind = body.kind;
    if (kind !== 'enable' && kind !== 'disable' && kind !== 'rollout') {
      throw new HttpError(400, 'kind must be enable, disable or rollout (or send steps)');
    }
    const runAt = dateOf(body.runAt, 'runAt');
    const payload = kind === 'rollout' ? { percent: percentOf(body.percent, 'percent') } : {};
    const schedule = await o.admin.schedule(
      { flag: key, kind, payload, runAt, environment },
      deps.actor,
    );
    return { status: 201, body: { schedules: [schedule] } };
  });
}

/** `DELETE /api/schedules/:id` — only a pending schedule can be cancelled. */
export function cancelSchedule(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const id = keyParam(req, 'id');
    const found = await o.store.getSchedule(id);
    if (!found) throw new HttpError(404, `schedule ${id} not found`);
    if (found.status !== 'pending') {
      throw new HttpError(409, `schedule ${id} is ${found.status}`);
    }
    return ok({ schedule: await o.admin.cancelSchedule(id, deps.actor) });
  });
}

// ── Environments: export, import, promote ───────────────────────────────────

/** `GET /api/export` — the environment's ruleset as JSON. */
export function exportRuleset(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    return ok(await o.admin.exportRuleset(environment));
  });
}

/** `POST /api/import` `{ ruleset, note? }` — replaces every flag, segment, layer and the holdout. */
export function importRuleset(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const ruleset = bodyOf(req).ruleset;
    const issues = rulesetIssues(ruleset);
    if (issues.length > 0) throw invalid(issues);
    return proposed(
      await o.admin.importRuleset(
        ruleset as Ruleset,
        deps.actor,
        writeOptions(environment, noteOf(req)),
      ),
    );
  });
}

/** `POST /api/promote` `{ from, to, note? }` — copy one environment's ruleset over another's. */
export function promote(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const body = bodyOf(req);
    const from = checkEnvironment(body.from, 'from');
    const to = checkEnvironment(body.to, 'to');
    if (from === to) throw new HttpError(400, 'from and to must be different environments');
    return proposed(await o.admin.promote(from, to, deps.actor, noteOf(req)));
  });
}

// ── Hygiene ─────────────────────────────────────────────────────────────────

/** `GET /api/stale?unusedDays&staticDays` — flags that probably should be removed. */
export function stale(deps: Deps, req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const environment = environmentOf(req, o.runtime);
    const unusedDays = intQuery(req, 'unusedDays', 30, 3650);
    const staticDays = intQuery(req, 'staticDays', 30, 3650);
    const flags = await o.admin.stale({
      environment,
      unusedDays,
      staticDays,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    return ok({ environment, unusedDays, staticDays, flags });
  });
}

// ── Ops ─────────────────────────────────────────────────────────────────────

/** `GET /api/ops` — is the machinery healthy: source, buffer, transport and every sink. */
export function ops(deps: Deps, _req: ApiRequest): Promise<ApiResponse> {
  return handle(deps, async (o) => {
    const status = o.runtime.manager.status();
    const names = [...o.runtime.sinks.keys()];
    let sinks: Array<SinkStatus | { sink: string }> = names.map((sink) => ({ sink }));
    let sinkError: string | null = null;
    if (o.runtime.transport?.status && names.length > 0) {
      try {
        sinks = await o.runtime.transport.status(names);
      } catch (error) {
        sinkError = error instanceof Error ? error.message : String(error);
      }
    }
    return ok({
      app: status.app,
      environment: status.environment,
      topology: o.runtime.topology,
      role: o.runtime.role,
      source: status.source,
      buffer: status.buffer,
      transport: status.transport,
      sinks,
      sinkError,
      relay: o.runtime.relay !== undefined,
      worker: o.runtime.worker !== undefined,
      analytics: o.runtime.analytics !== undefined,
      tenants: o.runtime.topology === 'control-plane' ? knownTenants() : [],
    });
  });
}
