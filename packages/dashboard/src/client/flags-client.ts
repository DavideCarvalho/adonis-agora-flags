/**
 * API client for the `@adonis-agora/flags` console. Talks JSON over `fetch` to the routes mounted by
 * `packages/adonis/providers/dashboard_provider.ts` (default base `/flags`, JSON API at `<base>/api`).
 *
 * Same shape as every Agora console's client: deployment config read from a JSON data block, one
 * `http()` helper, 401 → follow `redirectTo` or reload, and the host's CSRF token echoed on writes.
 *
 * Reads are `GET`. Writes are `POST`/`PUT`/`DELETE`; on an environment that needs approval a write
 * answers `202` with the change request it filed instead of applying it — {@link WriteResult}.
 */

import {
  type CursorPageResponse,
  type FilterQueryBuilder,
  filterQuery,
} from '@adonis-agora/filter-client';

// ── Ruleset (mirrors `@adonis-agora/flags-core`'s `ruleset.ts`; plain JSON) ─────────────────────

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ConditionValue = string | number | boolean;

export interface AttributeCondition {
  attribute: string;
  op: string;
  values?: ConditionValue[];
  negate?: boolean;
}

export interface SegmentCondition {
  segment: string;
  negate?: boolean;
}

export type Condition = AttributeCondition | SegmentCondition;

export interface WeightedVariant {
  variant: string;
  weight: number;
}

export type Serve = { variant: string } | { split: WeightedVariant[]; bucketBy?: string };

export interface TargetingRule {
  id: string;
  conditions: Condition[];
  serve: Serve;
}

export interface FlagDefinition {
  variants: Record<string, JsonValue>;
  enabled: boolean;
  offVariant: string;
  overrides?: Record<string, string>;
  rules?: TargetingRule[];
  fallthrough: Serve;
  prerequisites?: Array<{ flag: string; variant: string }>;
  salt?: string;
  experiment?: {
    key?: string;
    layer?: string;
    holdout?: boolean;
    /** Metrics that decide the experiment. */
    metrics?: string[];
    /** Metrics that must not regress. */
    guardrails?: string[];
    control?: string;
    confidence?: number;
  };
  tags?: string[];
}

export interface Segment {
  included?: string[];
  excluded?: string[];
  conditions?: AttributeCondition[];
}

export interface Layer {
  salt?: string;
  allocations: Record<string, [number, number]>;
}

export interface Holdout {
  percent: number;
  salt?: string;
}

export interface MetricDefinition {
  kind: 'conversion' | 'count' | 'sum';
  event: string;
  description?: string;
  windowMs?: number;
  cupedMs?: number;
  direction?: 'increase' | 'decrease';
}

/** `config`: defined in config/flags.ts (read-only here). `console`: stored in the ruleset. */
export type DefinitionSource = 'config' | 'console';

export interface Ruleset {
  schemaVersion: number;
  version: string;
  flags: Record<string, FlagDefinition>;
  segments?: Record<string, Segment>;
  layers?: Record<string, Layer>;
  holdout?: Holdout;
  metrics?: Record<string, MetricDefinition>;
}

// ── Wire types ────────────────────────────────────────────────────────────────────────────────

export interface Actor {
  id: string;
  name?: string;
}

export interface Issue {
  path: string;
  message: string;
}

export interface Declaration {
  type: 'boolean' | 'string' | 'number' | 'json';
  default: JsonValue;
  description?: string;
  owner?: string;
  expiresAt?: string;
  tags?: string[];
  client?: boolean;
  variants?: string[];
  /** The apps that declare this key in code. */
  apps: string[];
  /** `code`: declared in an app's config (read-only here). `console`: created here, editable. */
  source: 'code' | 'console';
  /**
   * On a code-declared flag: the declaration it was created with in the console, which the code
   * now overrides (ignored until removed with `removeConsoleDeclaration`).
   */
  overriddenConsole?: DeclarationInput;
}

/** What the console sends to create or describe a flag (no `apps`/`source`: the server knows). */
export type DeclarationInput = Omit<Declaration, 'apps' | 'source'>;

export type Serving =
  | { kind: 'default'; value: JsonValue | null }
  | { kind: 'off'; variant: string }
  | { kind: 'fixed'; variant: string }
  | { kind: 'rollout'; percent: number }
  | { kind: 'split'; arms: Array<{ variant: string; percent: number }>; bucketBy?: string };

export type StaleReason = 'unused' | 'expired' | 'static' | 'undeclared' | 'missing';

export interface FlagRow {
  key: string;
  declaration: Declaration | null;
  inRuleset: boolean;
  enabled: boolean | null;
  serving: Serving;
  tags: string[];
  owner: string | null;
  expiresAt: string | null;
  experiment: boolean;
  rules: number;
  overrides: number;
  stale: StaleReason[];
}

export interface Meta {
  app: string;
  topology: string;
  environment: string;
  environments: string[];
  approvals: Record<string, boolean>;
  actor: Actor;
  operators: string[];
  analytics: boolean;
  experiments: string[];
}

export interface AuditEntry {
  id: string;
  environment: string;
  entity: string;
  key: string | null;
  action: 'create' | 'update' | 'delete' | 'replace';
  before: unknown;
  after: unknown;
  actor: Actor;
  changeRequestId?: string;
  version: string;
  at: string;
}

export interface RulesetChange {
  entity: 'flag' | 'segment' | 'layer' | 'metric' | 'holdout' | 'ruleset';
  key?: string;
  value: unknown;
}

export interface ChangeRequest {
  id: string;
  environment: string;
  change: RulesetChange;
  note?: string;
  requestedBy: Actor;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'cancelled';
  reviewedBy?: Actor;
  reviewedAt?: string;
  reviewNote?: string;
  baseVersion: string;
}

export interface ScheduledChange {
  id: string;
  environment: string;
  flag: string;
  kind: 'enable' | 'disable' | 'rollout' | 'change';
  payload: { percent?: number; variant?: string };
  runAt: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  createdBy: Actor;
  error?: string;
  executedAt?: string;
}

export interface FlagDetail {
  environment: string;
  version: string;
  key: string;
  declaration: Declaration | null;
  stored: FlagDefinition | null;
  definition: FlagDefinition;
  serving: Serving;
  audit: AuditEntry[];
  schedules: ScheduledChange[];
  pendingRequests: ChangeRequest[];
  requiresApproval: boolean;
  segments: string[];
  layers: string[];
  /** Metrics an experiment on this flag can use (absent on servers before 0.4). */
  metrics?: Array<{ name: string; source: DefinitionSource }>;
  /** A config/flags.ts experiment analysing this flag; it wins over the console's settings. */
  configExperiment?: string | null;
  /** Other flags → their variant names (for prerequisites). */
  flags: Record<string, string[]>;
}

export interface EvaluationDetails {
  flagKey: string;
  value: JsonValue;
  variant?: string;
  reason: string;
  errorCode?: string;
  errorMessage?: string;
  flagMetadata: Record<string, string | number | boolean>;
}

export interface Comparison {
  variant: string;
  test: 'proportion' | 'welch' | 'cuped';
  difference: number;
  relativeLift: number;
  pValue: number;
  interval: [number, number];
  significant: boolean;
  sequential: { pValue: number; interval: [number, number]; significant: boolean };
  varianceReduction?: number;
  verdict: 'better' | 'worse' | 'inconclusive';
}

export interface MetricResult {
  name: string;
  kind: string;
  event: string;
  direction: 'increase' | 'decrease';
  guardrail: boolean;
  variants: Array<{ variant: string; n: number; mean: number }>;
  comparisons: Comparison[];
  alert: boolean;
}

export interface ExperimentResults {
  experiment: string;
  flag: string;
  /** Environment whose events were analysed (absent in results computed before 0.1). */
  environment?: string;
  /** Global-holdout subjects who reached the experiment (not compared). */
  holdout?: number;
  control: string;
  computedAt: string;
  exposures: Record<string, number>;
  srm: {
    chiSquare?: number;
    pValue: number;
    mismatch: boolean;
    expected: Record<string, number>;
  } | null;
  metrics: MetricResult[];
  warnings: string[];
}

export interface ExperimentRow {
  key: string;
  flag: string;
  configured: boolean;
  /** Where the analysis is defined; `null` when nothing analyses the flag. */
  source?: DefinitionSource | null;
  metrics: string[];
  guardrails: string[];
  running: boolean;
  computedAt: string | null;
  exposures: number | null;
  srmMismatch: boolean;
  alert: boolean;
  verdicts: Array<{ metric: string; variant: string; verdict: Comparison['verdict'] }>;
}

export interface ExperimentDetail {
  key: string;
  flag: string;
  config: { metrics: string[]; guardrails?: string[]; control?: string; confidence?: number };
  analytics: boolean;
  results: ExperimentResults | null;
}

export interface StaleFlag {
  key: string;
  reasons: StaleReason[];
  lastEvaluated?: string;
  expiresAt?: string;
  owner?: string;
}

export interface SinkStatus {
  sink: string;
  lag?: number;
  delivered?: number;
  leasedBy?: string | null;
  lastError?: string | null;
}

export interface Ops {
  app: string;
  environment: string;
  topology: string;
  role: string;
  source: {
    version: string;
    loadedAt: string | null;
    lastError: string | null;
    stale: boolean;
    mode: 'notify' | 'poll' | 'stream';
  };
  buffer: { pending: number; published: number; dropped: number } | null;
  transport: { name: string; transactional: boolean; durable: boolean } | null;
  sinks: SinkStatus[];
  sinkError: string | null;
  relay: boolean;
  /** `transport`: the transport delivers to the sinks itself (queue jobs), there is no relay. */
  delivery?: 'relay' | 'transport' | null;
  worker: boolean;
  analytics: boolean;
  tenants: Array<{
    partition: string;
    /** `null` when only another replica has heard from it recently. */
    environment: string | null;
    capabilities: string[];
    lastSeenAt: string | null;
    lastRulesetVersion: string | null;
  }>;
}

/** What every write answers: applied now, or filed for a second person's approval. */
export type WriteResult =
  | { status: 'applied'; version: string }
  | { status: 'pending'; request: ChangeRequest };

// ── Deployment config ─────────────────────────────────────────────────────────────────────────

/** `id` of the JSON data block the provider injects into `index.html` (`spa.ts`). */
export const CONFIG_ELEMENT_ID = 'flags-dashboard-config';

interface InjectedConfig {
  base?: unknown;
  api?: unknown;
  environment?: unknown;
}

/**
 * The deployment config the provider handed this page, read from a `<script type="application/json">`
 * DATA block. Never an inline script: a nonce'd `script-src` CSP drops those without a word, and
 * the console would then render and 404 on every request.
 */
function readConfig(): InjectedConfig {
  if (typeof document === 'undefined') return {};
  const element = document.getElementById(CONFIG_ELEMENT_ID);
  if (element === null) return {};
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? '');
    return typeof parsed === 'object' && parsed !== null ? (parsed as InjectedConfig) : {};
  } catch {
    return {};
  }
}

export function uiBase(): string {
  // `typeof === 'string'`, not truthy: `''` is a valid root mount.
  const injected = readConfig().base;
  return typeof injected === 'string' ? injected : '/flags';
}

export function apiBase(): string {
  const injected = readConfig().api;
  return typeof injected === 'string' ? injected : `${uiBase()}/api`;
}

/** The environment this app evaluates — the switcher's default. */
export function defaultEnvironment(): string {
  const injected = readConfig().environment;
  return typeof injected === 'string' && injected !== '' ? injected : 'production';
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

/** A failed call, with the server's sentence and — for a `422` — the issues to show by field. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await res.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function redirectToAuthSurface(redirectTo: string | undefined): void {
  if (typeof window === 'undefined') return;
  window.location.href = redirectTo ?? (uiBase() || '/');
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiBase() + path, init);
  if (res.status === 401) {
    const body = await readBody(res);
    const target =
      typeof body.redirectTo === 'string' && body.redirectTo ? body.redirectTo : undefined;
    redirectToAuthSurface(target);
    throw new ApiError('Not signed in; redirecting.', 401);
  }
  if (!res.ok) {
    const body = await readBody(res);
    const message =
      typeof body.error === 'string' && body.error !== ''
        ? body.error
        : `${res.status} ${res.statusText}`;
    const issues = Array.isArray(body.issues) ? (body.issues as Issue[]) : [];
    throw new ApiError(message, res.status, issues);
  }
  return (await res.json()) as T;
}

/**
 * The host app's CSRF token, when it sets one: `@adonisjs/shield` publishes it as an `XSRF-TOKEN`
 * cookie and accepts it back in `x-xsrf-token`. Without it every write is refused before it reaches
 * the console's own authorization. No cookie → no header.
 */
export function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  const token = match?.[1];
  if (!token) return {};
  return { 'x-xsrf-token': decodeURIComponent(token) };
}

/** A JSON write. Kept apart from reads so no `GET` can ever carry a body or a method by accident. */
function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return http<T>(path, {
    method,
    headers: { 'content-type': 'application/json', ...csrfHeader() },
    body: JSON.stringify(body ?? {}),
  });
}

/** Build a query string, skipping empty values so `?tag=` never reaches the server. */
export function buildQuery(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    q.set(key, String(value));
  }
  const qs = q.toString();
  return qs === '' ? '' : `?${qs}`;
}

const seg = encodeURIComponent;

/** `?environment=…&<list query>`: the environment plus a `filterQuery()`'s filters and paging. */
function listQuery(environment: string, query: FilterQueryBuilder): string {
  const qs = query.toQueryString();
  return `${buildQuery({ environment })}${qs === '' ? '' : `&${qs}`}`;
}

/** A catalog the console returns whole (the environment's ruleset is small): `{ data, … }`. */
type Catalog<T, Extra = Record<never, never>> = { environment: string; data: T[] } & Extra;

/** A paged list: `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. */
type Paged<T, Extra = Record<never, never>> = CursorPageResponse<T> & {
  environment: string;
} & Extra;

// ── Calls ─────────────────────────────────────────────────────────────────────────────────────

export const api = {
  meta: () => http<Meta>('/meta'),

  flags: (environment: string) =>
    http<Catalog<FlagRow, { version: string }>>(`/flags${buildQuery({ environment })}`),
  flag: (environment: string, key: string) =>
    http<FlagDetail>(`/flags/${seg(key)}${buildQuery({ environment })}`),
  createFlag: (environment: string, key: string, declaration: DeclarationInput, note?: string) =>
    send<WriteResult>('POST', '/flags', { environment, key, declaration, note }),
  updateDeclaration: (
    environment: string,
    key: string,
    declaration: Partial<DeclarationInput>,
    note?: string,
  ) =>
    send<WriteResult>('PUT', `/flags/${seg(key)}/declaration`, { environment, declaration, note }),
  saveFlag: (environment: string, key: string, definition: FlagDefinition, note?: string) =>
    send<WriteResult>('PUT', `/flags/${seg(key)}`, { environment, definition, note }),
  removeConsoleDeclaration: (environment: string, key: string) =>
    send<WriteResult>('DELETE', `/flags/${seg(key)}/declaration`, { environment }),
  deleteFlag: (environment: string, key: string, note?: string) =>
    send<WriteResult>('DELETE', `/flags/${seg(key)}`, { environment, note }),
  setEnabled: (environment: string, key: string, enabled: boolean) =>
    send<WriteResult>('POST', `/flags/${seg(key)}/enabled`, { environment, enabled }),
  setRollout: (environment: string, key: string, percent: number) =>
    send<WriteResult>('POST', `/flags/${seg(key)}/rollout`, { environment, percent }),
  setOverride: (environment: string, key: string, subject: string, variant: string | null) =>
    send<WriteResult>('POST', `/flags/${seg(key)}/overrides`, { environment, subject, variant }),

  preview: (environment: string, change: RulesetChange) =>
    send<{ valid: boolean; issues: Issue[]; serving?: Serving | null }>('POST', '/preview', {
      environment,
      change,
    }),
  evaluate: (
    environment: string,
    input: { flag?: string; context: Record<string, unknown>; definition?: FlagDefinition },
  ) =>
    send<{ environment: string; result?: EvaluationDetails; results?: EvaluationDetails[] }>(
      'POST',
      '/evaluate',
      { environment, ...input },
    ),

  segments: (environment: string) =>
    http<Catalog<{ key: string; segment: Segment; usedBy: string[] }>>(
      `/segments${buildQuery({ environment })}`,
    ),
  saveSegment: (environment: string, key: string, segment: Segment) =>
    send<WriteResult>('PUT', `/segments/${seg(key)}`, { environment, segment }),
  deleteSegment: (environment: string, key: string) =>
    send<WriteResult>('DELETE', `/segments/${seg(key)}`, { environment }),

  layers: (environment: string) =>
    http<
      Catalog<
        { key: string; layer: Layer; allocatedPercent: number },
        {
          holdout: Holdout | null;
          experiments: Array<{
            flag: string;
            experiment: string;
            layer: string | null;
            holdout: boolean;
          }>;
        }
      >
    >(`/layers${buildQuery({ environment })}`),
  saveLayer: (environment: string, key: string, layer: Layer) =>
    send<WriteResult>('PUT', `/layers/${seg(key)}`, { environment, layer }),
  deleteLayer: (environment: string, key: string) =>
    send<WriteResult>('DELETE', `/layers/${seg(key)}`, { environment }),
  saveHoldout: (environment: string, holdout: Holdout | null) =>
    send<WriteResult>('PUT', '/holdout', { environment, holdout }),

  metrics: (environment: string) =>
    http<
      Catalog<{
        name: string;
        metric: MetricDefinition;
        source: DefinitionSource;
        usedBy: string[];
        /** On a config metric: the console metric of the same name it overrides. */
        overriddenConsole?: MetricDefinition;
      }>
    >(`/metrics${buildQuery({ environment })}`),
  saveMetric: (environment: string, key: string, metric: MetricDefinition) =>
    send<WriteResult>('PUT', `/metrics/${seg(key)}`, { environment, metric }),
  deleteMetric: (environment: string, key: string) =>
    send<WriteResult>('DELETE', `/metrics/${seg(key)}`, { environment }),

  experiments: (environment: string) =>
    http<Catalog<ExperimentRow, { analytics: boolean }>>(
      `/experiments${buildQuery({ environment })}`,
    ),
  experiment: (key: string, environment: string) =>
    http<ExperimentDetail>(`/experiments/${seg(key)}${buildQuery({ environment })}`),
  recompute: (key: string, environment: string) =>
    send<{ key: string; results: ExperimentResults }>(
      'POST',
      `/experiments/${seg(key)}/recompute`,
      { environment },
    ),

  /** `status: 'all'` sends no status filter. */
  changeRequests: (environment: string, status: string) =>
    http<Paged<ChangeRequest, { requiresApproval: boolean; actor: Actor }>>(
      `/change-requests${listQuery(
        environment,
        status === 'all' ? filterQuery() : filterQuery().where('status', status),
      )}`,
    ),
  approve: (id: string, note?: string) =>
    send<{ version: string; request: ChangeRequest }>(
      'POST',
      `/change-requests/${seg(id)}/approve`,
      {
        note,
      },
    ),
  reject: (id: string, note?: string) =>
    send<{ request: ChangeRequest }>('POST', `/change-requests/${seg(id)}/reject`, { note }),
  cancel: (id: string) =>
    send<{ request: ChangeRequest }>('POST', `/change-requests/${seg(id)}/cancel`),

  /** Newest first; pass the previous page's `meta.nextCursor` as `after` for older changes. */
  audit: (
    environment: string,
    filters: { entity?: string; key?: string; after?: string; first?: number },
  ) => {
    const query = filterQuery();
    if (filters.entity) query.where('entity', filters.entity);
    if (filters.key) query.where('key', filters.key);
    if (filters.after) query.after(filters.after);
    if (filters.first) query.first(filters.first);
    return http<Paged<AuditEntry>>(`/audit${listQuery(environment, query)}`);
  },

  schedule: (
    environment: string,
    key: string,
    input:
      | { kind: 'enable' | 'disable' | 'rollout'; runAt: string; percent?: number }
      | { steps: Array<{ at: string; percent: number }> },
  ) =>
    send<{ schedules: ScheduledChange[] }>('POST', `/flags/${seg(key)}/schedules`, {
      environment,
      ...input,
    }),
  cancelSchedule: (id: string) =>
    send<{ schedule: ScheduledChange }>('DELETE', `/schedules/${seg(id)}`),

  exportRuleset: (environment: string) => http<Ruleset>(`/export${buildQuery({ environment })}`),
  importRuleset: (environment: string, ruleset: unknown, note?: string) =>
    send<WriteResult>('POST', '/import', { environment, ruleset, note }),
  promote: (from: string, to: string, note?: string) =>
    send<WriteResult>('POST', '/promote', { from, to, note }),

  stale: (environment: string, unusedDays: number, staticDays: number) =>
    http<Catalog<StaleFlag, { unusedDays: number; staticDays: number }>>(
      `/stale${buildQuery({ environment, unusedDays, staticDays })}`,
    ),
  ops: () => http<Ops>('/ops'),
};
