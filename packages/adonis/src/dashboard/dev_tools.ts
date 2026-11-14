import type { HttpContext } from '@adonisjs/core/http';
import {
  type ApiRequest,
  type ApiResponse,
  approveChangeRequest,
  audit,
  deleteDeclaration,
  deleteMetric,
  evaluateContext,
  experimentDetail,
  flagDetail,
  listChangeRequests,
  listExperiments,
  listFlags,
  listMetrics,
  listSegments,
  meta,
  ops,
  recomputeExperiment,
  rejectChangeRequest,
  saveFlag,
  saveMetric,
  saveSegment,
  setEnabled,
  setOverride,
  setRollout,
  setVariant,
  stale,
} from './handlers.js';
import { auditCursorAt } from './list.js';

/*
 * The dev-tools registration contract, version 1, declared here STRUCTURALLY: the hub is bound at
 * `'agora.devTools'` by `@adonis-agora/agent/mcp_provider` when the app has it, and this package
 * never imports the agent (it stays an optional, undeclared peer). Same shapes as
 * `@adonis-agora/agent/dev-tools`.
 */

/** The container binding the dev-tools hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

/** The hub a lib registers its developer tools into. */
export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
}

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** What a lib's `authorize` answers: the console decision. */
export type DevToolsDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'unauthenticated' | 'forbidden';
      redirectTo?: string;
      error?: unknown;
    };

/** One developer tool. */
export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  ctx: HttpContext;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

/** Who is calling. Never a token value. */
export interface DevToolsCaller {
  id: string;
  via: 'token' | 'session' | 'open';
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

type Handler = (deps: never, req: ApiRequest) => Promise<ApiResponse>;

/** What {@link flagsDevTools} needs from the console. */
export interface FlagsDevToolsOptions {
  /**
   * Serve one console API handler for the MCP request, exactly as the console's JSON API does: the
   * same runtime, and the console's actor for `ctx` (an unidentified caller acts as `mcp:<caller>`).
   */
  serve(
    ctx: HttpContext,
    handler: Handler,
    req: Partial<ApiRequest>,
    caller: DevToolsCaller,
  ): Promise<ApiResponse>;
}

/** List tools default to this many rows. */
const DEFAULT_LIMIT = 20;
/** List tools return at most this many rows. */
const MAX_LIMIT = 100;
/** History rows a flag's detail carries. */
const DETAIL_AUDIT_ROWS = 10;
/** The most rows the console's audit (`limit` ≤ 200) and change-request (≤ 500) lists serve. */
const AUDIT_CAP = 200;
const CHANGE_REQUEST_CAP = 500;

/** Thrown from a tool to answer an MCP error result (the agent turns it into `isError`). */
class DevToolError extends Error {}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new DevToolError(`${key} is required`);
  return value;
}

/** A JSON-object argument (the input schema carries only scalars). */
function jsonObject(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const text = required(input, key);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DevToolError(`${key} must be a JSON object`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevToolError(`${key} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function paging(input: Record<string, unknown>, call: DevToolCall) {
  const rawLimit = input.limit;
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.trunc(rawLimit)
      : DEFAULT_LIMIT;
  const cap = Math.min(MAX_LIMIT, call.limits.maxRows > 0 ? call.limits.maxRows : MAX_LIMIT);
  const rawPage = input.page;
  const page = typeof rawPage === 'number' && Number.isFinite(rawPage) ? Math.trunc(rawPage) : 1;
  return { page: Math.max(1, page), size: Math.min(Math.max(limit, 1), cap) };
}

/** `{ items, next }` over a list the console returns whole. */
function slice<T>(
  rows: T[],
  at: { page: number; size: number },
): { items: T[]; next: number | null } {
  const start = (at.page - 1) * at.size;
  return {
    items: rows.slice(start, start + at.size),
    next: start + at.size < rows.length ? at.page + 1 : null,
  };
}

/**
 * A console answer whose list sits under `field` (`data`), as one page: the other fields kept
 * (minus the HTTP list's `meta`), the list as `{ items, next }`. Page numbers and `limit`, like
 * `@adonis-agora/filter`'s own dev tools.
 */
function paged(
  out: Record<string, unknown>,
  field: string,
  input: Record<string, unknown>,
  call: DevToolCall,
): Record<string, unknown> {
  const { [field]: list, meta: _meta, ...rest } = out;
  return { ...rest, ...slice(Array.isArray(list) ? list : [], paging(input, call)) };
}

/**
 * How many rows to ask a store-backed list for so page `page` can be cut and its `next` known: the
 * rows up to the end of the page plus one, within what the console serves (`cap`).
 */
function fetchSize(at: { page: number; size: number }, cap: number): number {
  return Math.min(at.page * at.size + 1, cap);
}

/** The console's answer, or a tool error carrying its message and issues. */
function body(response: ApiResponse): Record<string, unknown> {
  if (response.status >= 200 && response.status < 300) {
    return (response.body ?? {}) as Record<string, unknown>;
  }
  const answer = (response.body ?? {}) as { error?: unknown; issues?: unknown };
  const error = typeof answer.error === 'string' ? answer.error : 'the console refused the request';
  const issues = Array.isArray(answer.issues)
    ? `: ${answer.issues
        .map((i: { path?: unknown; message?: unknown }) => `${String(i.path)} ${String(i.message)}`)
        .join('; ')}`
    : '';
  throw new DevToolError(`${response.status}: ${error}${issues}`);
}

const ENVIRONMENT: DevToolInputProperty = {
  type: 'string',
  description: "Environment, e.g. 'production', 'staging'. Default: the app's own.",
};
const NOTE: DevToolInputProperty = {
  type: 'string',
  description: 'Why: recorded with the change (and on the change request when approvals are on).',
};
const KEY: DevToolInputProperty = { type: 'string', description: 'Flag key.' };
const PAGE: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  description: 'Page number, 1-based. Pass `next` back here.',
};
const LIMIT: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Rows per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
};

const WRITE_RESULT =
  "Returns { status: 'applied', version } or, where the environment needs approval, { status: 'pending', request } (a change request someone else must approve).";

/** The common write fields: environment and note, when given. */
function writeBody(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const environment = str(input, 'environment');
  if (environment !== undefined) out.environment = environment;
  const note = str(input, 'note');
  if (note !== undefined) out.note = note;
  return out;
}

function envQuery(input: Record<string, unknown>): Record<string, string> {
  const environment = str(input, 'environment');
  return environment !== undefined ? { environment } : {};
}

/**
 * The flags console's developer tools: the same handlers (so the same validation, `authorize`,
 * approvals and audit trail) the console's JSON API runs, under `flags_*` names. Reads are listed
 * by default; the actions only when the app opts in on the dev endpoint.
 */
export function flagsDevTools(options: FlagsDevToolsOptions): DevTool[] {
  const run = async (
    tc: DevToolCall,
    handler: Handler,
    req: Partial<ApiRequest>,
  ): Promise<Record<string, unknown>> =>
    body(await options.serve(tc.ctx, handler, { params: {}, query: {}, ...req }, tc.caller));

  return [
    {
      name: 'flags_get_overview',
      kind: 'read',
      description:
        'What the flags console runs on: the app, its environment, every environment and whether it needs approvals, who you act as, the experiments, and whether an analytics backend exists.',
      input: { type: 'object', properties: {} },
      run: async (_input, tc) => {
        const out = await run(tc, meta, {});
        const { operators: _operators, ...rest } = out;
        return rest;
      },
    },
    {
      name: 'flags_list_flags',
      kind: 'read',
      description:
        'List flags (declared in code or stored in the ruleset): key, type and default, whether it is on, what it serves (default, fixed variant, rollout %, split), owner, tags, experiment, and why it is stale. Filters: `search` (key substring), `tag`, `stale`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          environment: ENVIRONMENT,
          search: { type: 'string', description: 'Only keys containing this text.' },
          tag: { type: 'string', description: 'Only flags with this tag.' },
          stale: { type: 'boolean', description: 'Only flags reported as stale.' },
          page: PAGE,
          limit: LIMIT,
        },
      },
      run: async (input, tc) => {
        const out = await run(tc, listFlags, { query: envQuery(input) });
        const search = str(input, 'search')?.toLowerCase();
        const tag = str(input, 'tag');
        const rows = (out.data as Array<Record<string, unknown>>).filter(
          (f) =>
            (search === undefined || String(f.key).toLowerCase().includes(search)) &&
            (tag === undefined || (f.tags as string[]).includes(tag)) &&
            (input.stale !== true || (f.stale as string[]).length > 0),
        );
        return { environment: out.environment, ...slice(rows, paging(input, tc)) };
      },
    },
    {
      name: 'flags_get_flag',
      kind: 'read',
      description: `One flag: its declaration, full targeting definition (variants, rules, overrides, split, experiment settings), what it serves, pending change requests and schedules, and its last ${DETAIL_AUDIT_ROWS} changes (flags_list_audit for more).`,
      input: {
        type: 'object',
        properties: { key: KEY, environment: ENVIRONMENT },
        required: ['key'],
      },
      run: async (input, tc) => {
        const out = await run(tc, flagDetail, {
          params: { key: required(input, 'key') },
          query: envQuery(input),
        });
        const { flags: _others, audit: history, ...rest } = out;
        return {
          ...rest,
          audit: Array.isArray(history) ? history.slice(0, DETAIL_AUDIT_ROWS) : [],
        };
      },
    },
    {
      name: 'flags_evaluate',
      kind: 'read',
      description:
        'What a subject gets, and why: evaluates one flag (or every flag) against a context, on the stored ruleset, without recording an exposure. Returns the value, variant, reason (TARGETING_MATCH, SPLIT, DEFAULT, DISABLED…) and the matched rule.',
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Flag key. Omitted: every flag.' },
          targetingKey: {
            type: 'string',
            description: 'The subject (usually the user id) the split and overrides hash on.',
          },
          attributes: {
            type: 'string',
            description:
              'Other context attributes as a JSON object, e.g. {"plan":"pro","country":"BR"}.',
          },
          environment: ENVIRONMENT,
        },
      },
      run: async (input, tc) => {
        const context: Record<string, unknown> =
          str(input, 'attributes') !== undefined ? jsonObject(input, 'attributes') : {};
        const targetingKey = str(input, 'targetingKey');
        if (targetingKey !== undefined) context.targetingKey = targetingKey;
        const key = str(input, 'key');
        return run(tc, evaluateContext, {
          body: { ...envQuery(input), context, ...(key !== undefined ? { flag: key } : {}) },
        });
      },
    },
    {
      name: 'flags_list_segments',
      kind: 'read',
      description:
        'Segments (reusable audiences): explicit includes and excludes, their conditions, and the flags whose rules use each one. Returns { items, next }.',
      input: { type: 'object', properties: { environment: ENVIRONMENT, page: PAGE, limit: LIMIT } },
      run: async (input, tc) =>
        paged(await run(tc, listSegments, { query: envQuery(input) }), 'data', input, tc),
    },
    {
      name: 'flags_list_metrics',
      kind: 'read',
      description:
        'Metrics experiments are measured with: kind (conversion, count, sum), the tracked event, direction, window and CUPED, whether it is defined in config or in the console, and the experiments using it. Returns { items, next }.',
      input: { type: 'object', properties: { environment: ENVIRONMENT, page: PAGE, limit: LIMIT } },
      run: async (input, tc) =>
        paged(await run(tc, listMetrics, { query: envQuery(input) }), 'data', input, tc),
    },
    {
      name: 'flags_list_experiments',
      kind: 'read',
      description:
        'Experiments: their flag, metrics and guardrails, whether running, exposures, sample-ratio mismatch, guardrail alerts and per-metric verdicts from the last computation. Flags marked as experiments with no metrics are listed with configured: false. Returns { items, next }.',
      input: { type: 'object', properties: { environment: ENVIRONMENT, page: PAGE, limit: LIMIT } },
      run: async (input, tc) =>
        paged(await run(tc, listExperiments, { query: envQuery(input) }), 'data', input, tc),
    },
    {
      name: 'flags_get_experiment',
      kind: 'read',
      description:
        "One experiment's last computed results: exposures per variant, the sample-ratio check, and per metric each variant's mean, lift, interval, p-value, sequential p-value and verdict. Trust nothing while the SRM check flags a mismatch.",
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Experiment key.' },
          environment: ENVIRONMENT,
        },
        required: ['key'],
      },
      run: async (input, tc) =>
        run(tc, experimentDetail, {
          params: { key: required(input, 'key') },
          query: envQuery(input),
        }),
    },
    {
      name: 'flags_list_change_requests',
      kind: 'read',
      description: `Change requests in an environment that needs approval: the proposed change, who asked and why, and their status, newest first. Default: pending ones. Returns { items, next } (the ${CHANGE_REQUEST_CAP} newest at most).`,
      input: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['pending', 'approved', 'rejected', 'applied', 'cancelled', 'all'],
            description: 'Default: pending.',
          },
          environment: ENVIRONMENT,
          page: PAGE,
          limit: LIMIT,
        },
      },
      run: async (input, tc) => {
        const at = paging(input, tc);
        const status = str(input, 'status') ?? 'pending';
        const out = await run(tc, listChangeRequests, {
          query: {
            ...envQuery(input),
            ...(status !== 'all' ? { filter: { status } } : {}),
            first: String(fetchSize(at, CHANGE_REQUEST_CAP)),
          },
        });
        return paged(out, 'data', input, tc);
      },
    },
    {
      name: 'flags_list_audit',
      kind: 'read',
      description: `The change history, newest first: who changed what (flag, segment, layer, metric, holdout, ruleset), before and after, and the change request that carried it. Returns { items, next }; past the ${AUDIT_CAP} newest rows, pass the \`at\` of the last row as \`before\`.`,
      input: {
        type: 'object',
        properties: {
          entity: {
            type: 'string',
            enum: ['flag', 'segment', 'layer', 'metric', 'holdout', 'ruleset'],
          },
          key: { type: 'string', description: 'Only changes to this key.' },
          before: { type: 'string', description: 'Only changes before this ISO date.' },
          environment: ENVIRONMENT,
          page: PAGE,
          limit: LIMIT,
        },
      },
      run: async (input, tc) => {
        const at = paging(input, tc);
        const filter: Record<string, string> = {};
        for (const field of ['entity', 'key']) {
          const value = str(input, field);
          if (value !== undefined) filter[field] = value;
        }
        const query: Record<string, unknown> = {
          ...envQuery(input),
          first: String(fetchSize(at, AUDIT_CAP)),
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
        };
        const before = str(input, 'before');
        if (before !== undefined) {
          const date = new Date(before);
          if (Number.isNaN(date.getTime())) throw new DevToolError('before must be an ISO date');
          query.after = auditCursorAt(date);
        }
        return paged(await run(tc, audit, { query }), 'data', input, tc);
      },
    },
    {
      name: 'flags_list_stale',
      kind: 'read',
      description:
        'Flags that probably should be removed: not evaluated lately (unused), past their expiry (expired), serving one value to everyone (static), or in the ruleset but declared by no app (undeclared). Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          unusedDays: { type: 'integer', minimum: 1, description: 'Default 30.' },
          staticDays: { type: 'integer', minimum: 1, description: 'Default 30.' },
          environment: ENVIRONMENT,
          page: PAGE,
          limit: LIMIT,
        },
      },
      run: async (input, tc) => {
        const query: Record<string, string> = envQuery(input);
        for (const field of ['unusedDays', 'staticDays']) {
          if (typeof input[field] === 'number') query[field] = String(input[field]);
        }
        return paged(await run(tc, stale, { query }), 'data', input, tc);
      },
    },
    {
      name: 'flags_get_ops',
      kind: 'read',
      description:
        'Operational state: the ruleset version and how it is kept fresh, the event transport, each sink’s lag and last error, and the in-process event buffer.',
      input: { type: 'object', properties: {} },
      run: async (_input, tc) => run(tc, ops, {}),
    },

    // ── Actions ────────────────────────────────────────────────────────────
    {
      name: 'flags_set_enabled',
      kind: 'action',
      destructive: true,
      description: `The kill switch. enabled: false serves the off variant to everyone; true lifts it, back to the targeting (it does not turn a never-configured flag on: use flags_set_variant or flags_set_rollout). ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: KEY,
          enabled: { type: 'boolean' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'enabled'],
      },
      run: async (input, tc) => {
        if (typeof input.enabled !== 'boolean') throw new DevToolError('enabled is required');
        return run(tc, setEnabled, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), enabled: input.enabled },
        });
      },
    },
    {
      name: 'flags_set_rollout',
      kind: 'action',
      description: `Percentage rollout of an on/off flag: \`percent\` of subjects get "on", by a stable hash of their targeting key. ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: KEY,
          percent: { type: 'number', minimum: 0, maximum: 100 },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'percent'],
      },
      run: async (input, tc) => {
        if (typeof input.percent !== 'number') throw new DevToolError('percent is required');
        return run(tc, setRollout, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), percent: input.percent },
        });
      },
    },
    {
      name: 'flags_set_variant',
      kind: 'action',
      description: `Serve one variant to everyone (e.g. "on", "off", or a string flag's variant). ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: KEY,
          variant: { type: 'string' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'variant'],
      },
      run: async (input, tc) =>
        run(tc, setVariant, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), variant: required(input, 'variant') },
        }),
    },
    {
      name: 'flags_set_override',
      kind: 'action',
      description: `Pin one subject (targeting key) to a variant, before any rule: QA, a specific customer. remove: true deletes the override. ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: KEY,
          subject: { type: 'string', description: 'The targeting key, usually a user id.' },
          variant: { type: 'string', description: 'Required unless remove is true.' },
          remove: { type: 'boolean' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'subject'],
      },
      run: async (input, tc) => {
        const variant = input.remove === true ? null : required(input, 'variant');
        return run(tc, setOverride, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), subject: required(input, 'subject'), variant },
        });
      },
    },
    {
      name: 'flags_save_flag',
      kind: 'action',
      destructive: true,
      description: `Replace a flag's whole targeting definition (read it with flags_get_flag first and send it back edited). \`definition\` is a JSON object: { variants, enabled, offVariant, fallthrough: {variant} | {split:[{variant,weight}]}, rules?, overrides?, prerequisites?, experiment?: { key?, layer?, holdout?, metrics?, guardrails?, control?, confidence? }, tags? }. Validated like the console; issues come back as the error. ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: KEY,
          definition: { type: 'string', description: 'The definition, as a JSON object.' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'definition'],
      },
      run: async (input, tc) =>
        run(tc, saveFlag, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), definition: jsonObject(input, 'definition') },
        }),
    },
    {
      name: 'flags_save_segment',
      kind: 'action',
      description: `Create or replace a segment. \`segment\` is a JSON object: { included?: string[], excluded?: string[], conditions?: [{ attribute, op, values?, negate? }] } (conditions all must match). ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Segment key.' },
          segment: { type: 'string', description: 'The segment, as a JSON object.' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'segment'],
      },
      run: async (input, tc) =>
        run(tc, saveSegment, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), segment: jsonObject(input, 'segment') },
        }),
    },
    {
      name: 'flags_save_metric',
      kind: 'action',
      description: `Create or replace a console metric experiments can use (a metric defined in config/flags.ts cannot be changed here). ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Metric name.' },
          kind: {
            type: 'string',
            enum: ['conversion', 'count', 'sum'],
            description:
              "conversion: share of subjects who did the event; count: times per subject; sum: total of the events' value per subject.",
          },
          event: { type: 'string', description: 'The event name passed to track().' },
          direction: {
            type: 'string',
            enum: ['increase', 'decrease'],
            description: 'Default increase.',
          },
          windowDays: {
            type: 'number',
            minimum: 0,
            description: 'Count only events this many days after exposure. Default: no limit.',
          },
          cupedDays: {
            type: 'number',
            minimum: 0,
            description: 'CUPED over this many days before exposure. Default: off.',
          },
          description: { type: 'string' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key', 'kind', 'event'],
      },
      run: async (input, tc) => {
        const metric: Record<string, unknown> = {
          kind: required(input, 'kind'),
          event: required(input, 'event'),
        };
        const direction = str(input, 'direction');
        if (direction !== undefined) metric.direction = direction;
        const description = str(input, 'description');
        if (description !== undefined) metric.description = description;
        if (typeof input.windowDays === 'number') metric.windowMs = input.windowDays * 86_400_000;
        if (typeof input.cupedDays === 'number' && input.cupedDays > 0) {
          metric.cupedMs = input.cupedDays * 86_400_000;
        }
        return run(tc, saveMetric, {
          params: { key: required(input, 'key') },
          body: { ...writeBody(input), metric },
        });
      },
    },
    {
      name: 'flags_delete_metric',
      kind: 'action',
      destructive: true,
      description: `Delete a console metric (refused while an experiment uses it). A metric config/flags.ts also defines can be deleted only to clear the console copy the config overrides (flags_list_metrics shows it as overriddenConsole). ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Metric name.' },
          environment: ENVIRONMENT,
          note: NOTE,
        },
        required: ['key'],
      },
      run: async (input, tc) =>
        run(tc, deleteMetric, {
          params: { key: required(input, 'key') },
          body: writeBody(input),
        }),
    },
    {
      name: 'flags_remove_console_declaration',
      kind: 'action',
      description: `For a flag created in the console and declared in code since (flags_get_flag shows declaration.overriddenConsole): drop the console's declaration, which the code already overrides. The targeting stays. ${WRITE_RESULT}`,
      input: {
        type: 'object',
        properties: { key: KEY, environment: ENVIRONMENT, note: NOTE },
        required: ['key'],
      },
      run: async (input, tc) =>
        run(tc, deleteDeclaration, {
          params: { key: required(input, 'key') },
          body: writeBody(input),
        }),
    },
    {
      name: 'flags_recompute_experiment',
      kind: 'action',
      description:
        "Compute an experiment's results now instead of at the worker's next pass (it queries the analytics backend). Returns the fresh results.",
      input: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Experiment key.' },
          environment: ENVIRONMENT,
        },
        required: ['key'],
      },
      run: async (input, tc) =>
        run(tc, recomputeExperiment, {
          params: { key: required(input, 'key') },
          body: envQuery(input),
        }),
    },
    {
      name: 'flags_approve_change_request',
      kind: 'action',
      description:
        'Approve a pending change request, which applies it. Nobody can approve their own request.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Change request id.' }, note: NOTE },
        required: ['id'],
      },
      run: async (input, tc) =>
        run(tc, approveChangeRequest, {
          params: { id: required(input, 'id') },
          body: writeBody(input),
        }),
    },
    {
      name: 'flags_reject_change_request',
      kind: 'action',
      description: 'Reject a pending change request.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Change request id.' }, note: NOTE },
        required: ['id'],
      },
      run: async (input, tc) =>
        run(tc, rejectChangeRequest, {
          params: { id: required(input, 'id') },
          body: writeBody(input),
        }),
    },
  ];
}

/**
 * Register the flags console's tools into the app's dev-tools hub, when one is bound (the app
 * registered `@adonis-agora/agent/mcp_provider`). Returns whether it registered.
 */
export async function registerFlagsDevTools(
  container: {
    hasBinding(binding: string): boolean;
    make(binding: string): Promise<unknown>;
  },
  options: FlagsDevToolsOptions & {
    authorize: (ctx: HttpContext) => Promise<DevToolsDecision>;
  },
): Promise<boolean> {
  if (!container.hasBinding(DEV_TOOLS_BINDING)) return false;
  const hub = (await container.make(DEV_TOOLS_BINDING)) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'flags',
    title: 'Feature flags and experiments',
    authorize: options.authorize,
    tools: flagsDevTools(options),
  });
  return true;
}
