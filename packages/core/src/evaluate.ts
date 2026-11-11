import { BUCKET_COUNT, bucketOf, pickVariant } from './bucket.js';
import { MAX_MATCH_INPUT_LENGTH, unsafeRegexReason } from './regex_safety.js';
import {
  type AttributeCondition,
  type Condition,
  type ConditionValue,
  type FlagDefinition,
  type JsonValue,
  OPERATORS,
  RULESET_SCHEMA_VERSION,
  type Ruleset,
  type Serve,
} from './ruleset.js';

/**
 * What a flag is evaluated against. Same shape as OpenFeature's evaluation context:
 * `targetingKey` identifies the subject (the authz `subject` / authkit `sub`), the rest are
 * attributes. Attributes that decide targeting must come from a trusted server-side source.
 */
export interface EvaluationContext {
  targetingKey?: string;
  [attribute: string]: unknown;
}

/** OpenFeature resolution reasons this engine produces. */
export type EvaluationReason =
  | 'STATIC'
  | 'DEFAULT'
  | 'TARGETING_MATCH'
  | 'SPLIT'
  | 'DISABLED'
  | 'ERROR';

/** OpenFeature error codes this engine produces. */
export type EvaluationErrorCode =
  | 'FLAG_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'TYPE_MISMATCH'
  | 'TARGETING_KEY_MISSING'
  | 'GENERAL';

export type FlagMetadata = Record<string, string | number | boolean>;

/** The result of an evaluation, shaped like OpenFeature's `EvaluationDetails`. */
export interface EvaluationDetails<T extends JsonValue = JsonValue> {
  flagKey: string;
  value: T;
  /** The variant served. Absent when the code default was returned because of an error. */
  variant?: string;
  reason: EvaluationReason;
  errorCode?: EvaluationErrorCode;
  errorMessage?: string;
  /** `rulesetVersion` always; `ruleId`, `override`, `prerequisiteFailed` when they apply. */
  flagMetadata: FlagMetadata;
}

/** Thrown internally when the ruleset holds something this engine must not half-evaluate. */
class EvaluationError extends Error {
  constructor(
    readonly code: EvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface Resolution {
  variant: string;
  reason: Exclude<EvaluationReason, 'ERROR'>;
  metadata: FlagMetadata;
}

const KNOWN_OPERATORS: ReadonlySet<string> = new Set(OPERATORS);
const MAX_PREREQUISITE_DEPTH = 16;

/** Per-call evaluation options. */
export interface EvaluateOptions {
  /**
   * Sticky assignments: flag key → the variant this subject was already exposed to. When the flag
   * would assign the subject through a split, a still-valid sticky variant is served instead, so
   * changing weights mid-experiment never moves someone who already saw a variant. Targeting is
   * still evaluated first: a subject who no longer matches the rule leaves the experiment.
   */
  sticky?: Record<string, string> | ((flagKey: string) => string | undefined);
}

/**
 * Evaluates `flagKey` for `context`. Never throws: every failure returns `defaultValue` (the
 * default declared in code) with `reason: 'ERROR'` and an `errorCode`.
 */
export function evaluate<T extends JsonValue>(
  ruleset: Ruleset,
  flagKey: string,
  defaultValue: T,
  context: EvaluationContext = {},
  options: EvaluateOptions = {},
): EvaluationDetails<T> {
  const baseMetadata: FlagMetadata = { rulesetVersion: ruleset.version };
  const fail = (code: EvaluationErrorCode, message: string): EvaluationDetails<T> => ({
    flagKey,
    value: defaultValue,
    reason: 'ERROR',
    errorCode: code,
    errorMessage: message,
    flagMetadata: baseMetadata,
  });

  if (ruleset.schemaVersion > RULESET_SCHEMA_VERSION) {
    return fail(
      'PARSE_ERROR',
      `ruleset schemaVersion ${ruleset.schemaVersion} is newer than the supported ${RULESET_SCHEMA_VERSION}`,
    );
  }
  const flag = ruleset.flags[flagKey];
  if (!flag) return fail('FLAG_NOT_FOUND', `flag "${flagKey}" is not in the ruleset`);

  let resolution: Resolution;
  try {
    resolution = resolve(ruleset, flagKey, flag, context, [flagKey], options);
  } catch (error) {
    if (error instanceof EvaluationError) return fail(error.code, error.message);
    return fail('GENERAL', error instanceof Error ? error.message : String(error));
  }

  const value = flag.variants[resolution.variant] as JsonValue;
  if (!sameType(value, defaultValue)) {
    return fail(
      'TYPE_MISMATCH',
      `variant "${resolution.variant}" of "${flagKey}" is ${typeName(value)}, the code default is ${typeName(defaultValue)}`,
    );
  }
  return {
    flagKey,
    value: value as T,
    variant: resolution.variant,
    reason: resolution.reason,
    flagMetadata: { ...baseMetadata, ...resolution.metadata },
  };
}

function resolve(
  ruleset: Ruleset,
  flagKey: string,
  flag: FlagDefinition,
  context: EvaluationContext,
  chain: string[],
  options: EvaluateOptions,
): Resolution {
  const served = (variant: string, reason: Resolution['reason'], metadata: FlagMetadata = {}) => {
    if (!Object.hasOwn(flag.variants, variant)) {
      throw new EvaluationError(
        'PARSE_ERROR',
        `flag "${flagKey}" serves unknown variant "${variant}"`,
      );
    }
    return { variant, reason, metadata };
  };

  if (!flag.enabled) return served(flag.offVariant, 'DISABLED');

  for (const prerequisite of flag.prerequisites ?? []) {
    if (chain.includes(prerequisite.flag)) {
      throw new EvaluationError(
        'PARSE_ERROR',
        `prerequisite cycle: ${[...chain, prerequisite.flag].join(' → ')}`,
      );
    }
    if (chain.length >= MAX_PREREQUISITE_DEPTH) {
      throw new EvaluationError(
        'PARSE_ERROR',
        `prerequisite chain deeper than ${MAX_PREREQUISITE_DEPTH}`,
      );
    }
    const parent = ruleset.flags[prerequisite.flag];
    const met =
      parent !== undefined &&
      resolve(ruleset, prerequisite.flag, parent, context, [...chain, prerequisite.flag], options)
        .variant === prerequisite.variant;
    if (!met) return served(flag.offVariant, 'DISABLED', { prerequisiteFailed: prerequisite.flag });
  }

  const key = context.targetingKey;
  if (key !== undefined && flag.overrides && Object.hasOwn(flag.overrides, key)) {
    return served(flag.overrides[key]!, 'TARGETING_MATCH', { override: true });
  }

  const experiment: FlagMetadata = {};
  if (flag.experiment) {
    experiment.experiment = flag.experiment.key ?? flagKey;
    const gate = experimentGate(ruleset, flagKey, flag, context);
    if (gate) return served(flag.offVariant, 'DEFAULT', { ...experiment, ...gate });
  }

  for (const rule of flag.rules ?? []) {
    if (rule.conditions.every((condition) => matches(ruleset, condition, context))) {
      const pick = serve(flagKey, flag, rule.serve, context, options);
      return served(pick.variant, pick.split ? 'SPLIT' : 'TARGETING_MATCH', {
        ruleId: rule.id,
        ...(pick.split ? experiment : {}),
        ...(pick.sticky ? { sticky: true } : {}),
      });
    }
  }

  const pick = serve(flagKey, flag, flag.fallthrough, context, options);
  if (pick.split) {
    return served(pick.variant, 'SPLIT', {
      ...experiment,
      ...(pick.sticky ? { sticky: true } : {}),
    });
  }
  const hasTargeting =
    (flag.rules?.length ?? 0) > 0 || Object.keys(flag.overrides ?? {}).length > 0;
  return served(pick.variant, hasTargeting ? 'DEFAULT' : 'STATIC');
}

/**
 * Holdout and layer membership for an experiment flag. Returns the metadata explaining why the
 * subject is kept out (served `offVariant`), or `undefined` when the subject may be assigned.
 */
function experimentGate(
  ruleset: Ruleset,
  flagKey: string,
  flag: FlagDefinition,
  context: EvaluationContext,
): FlagMetadata | undefined {
  const settings = flag.experiment!;
  const holdout = ruleset.holdout;
  const layerName = settings.layer;
  const needsKey = (holdout && holdout.percent > 0 && settings.holdout !== false) || layerName;
  if (!needsKey) return undefined;
  const key = context.targetingKey;
  if (key === undefined || key === '') {
    throw new EvaluationError(
      'TARGETING_KEY_MISSING',
      `experiment "${flagKey}" needs a targetingKey for its holdout or layer`,
    );
  }
  if (holdout && holdout.percent > 0 && settings.holdout !== false) {
    if (bucketOf(holdout.salt ?? 'holdout', key) < (holdout.percent / 100) * BUCKET_COUNT) {
      return { holdout: true };
    }
  }
  if (layerName) {
    const layer = ruleset.layers?.[layerName];
    if (!layer) throw new EvaluationError('PARSE_ERROR', `unknown layer "${layerName}"`);
    const range = layer.allocations[flagKey];
    const bucket = bucketOf(layer.salt ?? `layer:${layerName}`, key);
    if (!range || bucket < range[0] || bucket >= range[1]) {
      return { layer: layerName, layerExcluded: true };
    }
  }
  return undefined;
}

function serve(
  flagKey: string,
  flag: FlagDefinition,
  target: Serve,
  context: EvaluationContext,
  options: EvaluateOptions = {},
): { variant: string; split: boolean; sticky?: boolean } {
  if ('variant' in target) return { variant: target.variant, split: false };

  const sticky =
    typeof options.sticky === 'function' ? options.sticky(flagKey) : options.sticky?.[flagKey];
  if (
    sticky !== undefined &&
    target.split.some((arm) => arm.variant === sticky && arm.weight > 0)
  ) {
    return { variant: sticky, split: true, sticky: true };
  }

  const attribute = target.bucketBy ?? 'targetingKey';
  const raw = attribute === 'targetingKey' ? context.targetingKey : context[attribute];
  if (raw === undefined || raw === null || raw === '') {
    throw new EvaluationError(
      'TARGETING_KEY_MISSING',
      `flag "${flagKey}" splits by "${attribute}", which the context does not carry`,
    );
  }
  const variant = pickVariant(target.split, bucketOf(flag.salt ?? flagKey, String(raw)));
  if (variant === undefined) {
    throw new EvaluationError(
      'PARSE_ERROR',
      `flag "${flagKey}" has a split with no positive weight`,
    );
  }
  return { variant, split: true };
}

function matches(ruleset: Ruleset, condition: Condition, context: EvaluationContext): boolean {
  if ('segment' in condition) {
    const result = inSegment(ruleset, condition.segment, context);
    return condition.negate ? !result : result;
  }
  const result = matchesAttribute(condition, context);
  return condition.negate ? !result : result;
}

function inSegment(ruleset: Ruleset, name: string, context: EvaluationContext): boolean {
  const segment = ruleset.segments?.[name];
  if (!segment) throw new EvaluationError('PARSE_ERROR', `unknown segment "${name}"`);
  const key = context.targetingKey;
  if (key !== undefined && segment.excluded?.includes(key)) return false;
  if (key !== undefined && segment.included?.includes(key)) return true;
  const conditions = segment.conditions ?? [];
  // A segment with no conditions is just its include list.
  if (conditions.length === 0) return false;
  return conditions.every((condition) => {
    const result = matchesAttribute(condition, context);
    return condition.negate ? !result : result;
  });
}

function matchesAttribute(condition: AttributeCondition, context: EvaluationContext): boolean {
  if (!KNOWN_OPERATORS.has(condition.op)) {
    throw new EvaluationError('PARSE_ERROR', `unknown operator "${String(condition.op)}"`);
  }
  const actual =
    condition.attribute === 'targetingKey' ? context.targetingKey : context[condition.attribute];
  if (condition.op === 'exists') return actual !== undefined && actual !== null;
  if (actual === undefined || actual === null) return false;

  // Array attributes (e.g. roles) match when any element matches.
  const candidates = Array.isArray(actual) ? actual : [actual];
  const values = condition.values ?? [];
  return candidates.some((candidate) =>
    values.some((expected) => compare(condition.op, candidate, expected)),
  );
}

function compare(op: AttributeCondition['op'], actual: unknown, expected: ConditionValue): boolean {
  switch (op) {
    case 'in':
      return (
        actual === expected || (typeof actual !== 'object' && String(actual) === String(expected))
      );
    case 'contains':
      return typeof actual === 'string' && actual.includes(String(expected));
    case 'startsWith':
      return typeof actual === 'string' && actual.startsWith(String(expected));
    case 'endsWith':
      return typeof actual === 'string' && actual.endsWith(String(expected));
    case 'matches':
      return (
        typeof actual === 'string' &&
        actual.length <= MAX_MATCH_INPUT_LENGTH &&
        regex(String(expected)).test(actual)
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = toNumber(actual);
      const b = toNumber(expected);
      if (a === undefined || b === undefined) return false;
      return ordered(op, a - b);
    }
    case 'before':
    case 'after': {
      const a = toTime(actual);
      const b = toTime(expected);
      if (a === undefined || b === undefined) return false;
      return op === 'before' ? a < b : a > b;
    }
    case 'semverEq':
    case 'semverGt':
    case 'semverGte':
    case 'semverLt':
    case 'semverLte': {
      const diff = compareSemver(String(actual), String(expected));
      if (diff === undefined) return false;
      const map = {
        semverEq: 'eq',
        semverGt: 'gt',
        semverGte: 'gte',
        semverLt: 'lt',
        semverLte: 'lte',
      } as const;
      return map[op] === 'eq' ? diff === 0 : ordered(map[op], diff);
    }
    case 'exists':
      return true;
  }
}

function ordered(op: 'gt' | 'gte' | 'lt' | 'lte', diff: number): boolean {
  if (op === 'gt') return diff > 0;
  if (op === 'gte') return diff >= 0;
  if (op === 'lt') return diff < 0;
  return diff <= 0;
}

function toNumber(value: unknown): number | undefined {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Epoch millis, ISO strings and `Date` instances. */
function toTime(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence (build metadata ignored). `undefined` when either side is not semver. */
export function compareSemver(a: string, b: string): number | undefined {
  const x = SEMVER.exec(a.trim());
  const y = SEMVER.exec(b.trim());
  if (!x || !y) return undefined;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(x[i]) - Number(y[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  const pa = x[4];
  const pb = y[4];
  if (pa === undefined || pb === undefined) {
    // A version without prerelease ranks above the same version with one.
    return pa === pb ? 0 : pa === undefined ? 1 : -1;
  }
  const ia = pa.split('.');
  const ib = pb.split('.');
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const sa = ia[i];
    const sb = ib[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const na = /^\d+$/.test(sa);
    const nb = /^\d+$/.test(sb);
    if (na && nb) {
      const diff = Number(sa) - Number(sb);
      if (diff !== 0) return Math.sign(diff);
    } else if (na !== nb) {
      return na ? -1 : 1;
    } else if (sa !== sb) {
      return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

const regexCache = new Map<string, RegExp>();

function regex(source: string): RegExp {
  let compiled = regexCache.get(source);
  if (!compiled) {
    const unsafe = unsafeRegexReason(source);
    if (unsafe) {
      throw new EvaluationError('PARSE_ERROR', `pattern ${JSON.stringify(source)}: ${unsafe}`);
    }
    compiled = new RegExp(source);
    if (regexCache.size > 500) regexCache.clear();
    regexCache.set(source, compiled);
  }
  return compiled;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A `null` default accepts any variant value (an "anything" structure flag). */
function sameType(value: unknown, defaultValue: unknown): boolean {
  if (value === undefined) return false;
  if (defaultValue === null) return true;
  return typeName(value) === typeName(defaultValue);
}
