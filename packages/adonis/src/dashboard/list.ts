import {
  applyCustomFilter,
  BaseFilter,
  type CursorPageResponse,
  cursorPage,
  decodeCursor,
  encodeCursor,
  InvalidColumnFilterError,
  parseCursorParams,
  resolveSort,
} from '@adonis-agora/filter';
import type { ChangeRequestStatus, EntityType, ScheduledChange } from '../stores/store.js';

/**
 * The console's paged lists (audit, change requests, schedules) in the `@adonis-agora/filter` wire
 * format: `filter[field]=value`, `sort`, and cursor paging (`after` + `first`), answered as
 * `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`.
 *
 * The stores keep their small query SPI; this module translates the request onto it.
 */

/** Values a single-valued filter field accepts: one value, as `filter[f]=v` or a one-item list. */
function single(field: string, value: unknown, operator: string): string | undefined {
  if (operator !== 'equals' && operator !== 'in' && operator !== 'isAnyOf') {
    throw new InvalidColumnFilterError(`"${field}" does not support the "${operator}" operator.`);
  }
  const values = (Array.isArray(value) ? value : [value]).filter(
    (v) => v !== undefined && v !== null && v !== '',
  );
  if (values.length === 0) return undefined;
  if (values.length > 1 || typeof values[0] === 'object') {
    throw new InvalidColumnFilterError(`"${field}" takes one value.`);
  }
  return String(values[0]);
}

function oneOf<T extends string>(
  field: string,
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidColumnFilterError(
      `Unknown ${field} "${value}". Expected one of: ${allowed.join(', ')}.`,
    );
  }
  return value as T;
}

// ── Filters ─────────────────────────────────────────────────────────────────

export const AUDIT_ENTITIES: readonly EntityType[] = [
  'flag',
  'segment',
  'layer',
  'metric',
  'holdout',
  'ruleset',
];

export interface AuditQuery {
  entity?: EntityType;
  key?: string;
}

/** `GET /api/audit` filters: `filter[entity]`, `filter[key]`. */
export class AuditFilter extends BaseFilter<AuditQuery> {
  declare $query: AuditQuery;

  entity(value: unknown, operator: string): void {
    const entity = oneOf('entity', single('entity', value, operator), AUDIT_ENTITIES);
    if (entity !== undefined) this.$query.entity = entity;
  }

  key(value: unknown, operator: string): void {
    const key = single('key', value, operator);
    if (key !== undefined) this.$query.key = key;
  }
}

export const CHANGE_REQUEST_STATUSES: readonly ChangeRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
  'applied',
  'cancelled',
];

export interface ChangeRequestQuery {
  status?: ChangeRequestStatus;
}

/** `GET /api/change-requests` filters: `filter[status]` (absent: every status). */
export class ChangeRequestFilter extends BaseFilter<ChangeRequestQuery> {
  declare $query: ChangeRequestQuery;

  status(value: unknown, operator: string): void {
    const status = oneOf('status', single('status', value, operator), CHANGE_REQUEST_STATUSES);
    if (status !== undefined) this.$query.status = status;
  }
}

export const SCHEDULE_STATUSES: readonly ScheduledChange['status'][] = [
  'pending',
  'running',
  'done',
  'failed',
  'cancelled',
];

export interface ScheduleQuery {
  flag?: string;
  status?: ScheduledChange['status'];
}

/** `GET /api/schedules` filters: `filter[flag]`, `filter[status]`. */
export class ScheduleFilter extends BaseFilter<ScheduleQuery> {
  declare $query: ScheduleQuery;

  flag(value: unknown, operator: string): void {
    const flag = single('flag', value, operator);
    if (flag !== undefined) this.$query.flag = flag;
  }

  status(value: unknown, operator: string): void {
    const status = oneOf('status', single('status', value, operator), SCHEDULE_STATUSES);
    if (status !== undefined) this.$query.status = status;
  }
}

/** Runs a filter class over a request's query string and returns the filled draft. */
export async function filterQuery<D extends object>(
  cls: new () => BaseFilter<D>,
  query: Record<string, unknown>,
): Promise<D> {
  const draft = {} as D;
  await applyCustomFilter(draft, cls, { request: { qs: () => query } } as never);
  return draft;
}

// ── Sort and paging ─────────────────────────────────────────────────────────

/**
 * The store returns one fixed order, so `sort` may only name it (`-at`), or be absent. Anything
 * else is a `400` rather than a silently different order.
 */
export function fixedSort(query: Record<string, unknown>, order: string): void {
  const field = order.replace(/^-/, '');
  const direction = order.startsWith('-') ? 'desc' : 'asc';
  const sort = resolveSort(query.sort as string | undefined, { sortable: [field] });
  if (sort.length > 1 || (sort[0] !== undefined && sort[0].direction !== direction)) {
    throw new InvalidColumnFilterError(`This list is always sorted by "${order}".`);
  }
}

/** Page size bounds per list. */
export interface SizePolicy {
  defaultSize: number;
  maxSize: number;
}

/**
 * Size for a list that cannot seek: `first` only. `after` / `before` are refused (`400`) — the
 * store returns the newest (or soonest) rows; narrow the filter or raise `first` to see more.
 */
export function firstOnly(query: Record<string, unknown>, policy: SizePolicy): number {
  const params = parseCursorParams(query, policy);
  if (params.after !== undefined || params.before !== undefined) {
    throw new InvalidColumnFilterError(
      'This list does not page with cursors: narrow the filter or raise `first`.',
    );
  }
  return params.size;
}

/**
 * The page of a list that cannot seek: `size + 1` rows were fetched, so `hasNext` says whether more
 * rows match than `first` allowed. There is no cursor to follow.
 */
export function unseekablePage<T>(rows: T[], size: number): CursorPageResponse<T> {
  return cursorPage(rows.slice(0, size), {
    nextCursor: null,
    prevCursor: null,
    hasNext: rows.length > size,
    hasPrev: false,
  });
}

/**
 * Where an audit page ends: the `at` of its last row, and how many rows at that same millisecond
 * were already shown (changes made in the same millisecond share an `at`; the store orders them
 * stably, so the next page skips the ones already seen instead of losing them).
 */
export interface AuditPosition {
  at: number;
  seen: number;
}

/** The audit cursor for the page after `rows` (newest first), which started at `from`. */
export function auditCursor(rows: Array<{ at: Date }>, from?: AuditPosition): string | null {
  const last = rows[rows.length - 1];
  if (last === undefined) return null;
  const at = last.at.getTime();
  let seen = rows.filter((row) => row.at.getTime() === at).length;
  if (from !== undefined && from.at === at && seen === rows.length) seen += from.seen;
  return encodeCursor([at, seen]);
}

/** An audit cursor that starts at (and includes) the changes made at or before `date`. */
export function auditCursorAt(date: Date): string {
  return encodeCursor([date.getTime(), 0]);
}

/**
 * Audit paging: forward only (`after` + `first`), newest first. `before` (a newer page) is refused:
 * start again without a cursor for the newest rows.
 */
export function auditPaging(
  query: Record<string, unknown>,
  policy: SizePolicy,
): { size: number; from?: AuditPosition } {
  const params = parseCursorParams(query, policy);
  if (params.backward) {
    throw new InvalidColumnFilterError(
      'The audit pages forward only: drop `before` and `last` to start from the newest change.',
    );
  }
  if (params.after === undefined) return { size: params.size };
  const values = decodeCursor(params.after);
  const [at, seen] = values ?? [];
  if (
    values?.length !== 2 ||
    typeof at !== 'number' ||
    !Number.isFinite(at) ||
    typeof seen !== 'number' ||
    !Number.isInteger(seen) ||
    seen < 0 ||
    seen > 100_000
  ) {
    throw new InvalidColumnFilterError('Invalid cursor.');
  }
  return { size: params.size, from: { at, seen } };
}
