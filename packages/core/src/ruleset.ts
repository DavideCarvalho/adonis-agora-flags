/**
 * The ruleset: the serializable, versioned description of every flag's targeting. It is the
 * public contract between whoever edits flags (the store, the console, a control-plane) and
 * whoever evaluates them (this engine, in-process or on a tenant). Keep it plain JSON.
 *
 * Compatibility rule: an evaluator that meets a `schemaVersion` above
 * {@link RULESET_SCHEMA_VERSION}, or an operator it does not know, fails CLOSED for that flag
 * (code default + `PARSE_ERROR`). It never evaluates a rule it only half understands.
 */

/** The newest ruleset schema this engine understands. */
export const RULESET_SCHEMA_VERSION = 1;

/** Any JSON value a variant can carry. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Attribute operators. Every condition can be inverted with `negate`. */
export const OPERATORS = [
  'in',
  'contains',
  'startsWith',
  'endsWith',
  'matches',
  'gt',
  'gte',
  'lt',
  'lte',
  'before',
  'after',
  'semverEq',
  'semverGt',
  'semverGte',
  'semverLt',
  'semverLte',
  'exists',
] as const;

export type Operator = (typeof OPERATORS)[number];

/** Values a condition compares against. */
export type ConditionValue = string | number | boolean;

/** Compares one context attribute. `attribute: 'targetingKey'` reads the targeting key. */
export interface AttributeCondition {
  attribute: string;
  op: Operator;
  /** Ignored by `exists`. For the others, the condition matches when ANY value matches. */
  values?: ConditionValue[];
  negate?: boolean;
}

/** Matches when the context belongs to the named segment. */
export interface SegmentCondition {
  segment: string;
  negate?: boolean;
}

export type Condition = AttributeCondition | SegmentCondition;

/** One arm of a percentage split. Weights are relative; they need not sum to 100. */
export interface WeightedVariant {
  variant: string;
  weight: number;
}

/** What a rule (or the fallthrough) serves: a fixed variant or a deterministic split. */
export type Serve =
  | { variant: string }
  | {
      split: WeightedVariant[];
      /**
       * Context attribute whose value is hashed for the split (e.g. `orgId` to roll out per
       * organization). Defaults to the targeting key.
       */
      bucketBy?: string;
    };

/** A targeting rule. All conditions must match (AND); rules are tried in order. */
export interface TargetingRule {
  /** Stable id, reported in `flagMetadata.ruleId` so "why did I get B?" has an answer. */
  id: string;
  conditions: Condition[];
  serve: Serve;
}

/** Another flag that must resolve to `variant` before this one is evaluated. */
export interface Prerequisite {
  flag: string;
  variant: string;
}

export interface FlagDefinition {
  /** Variant name → value. Booleans conventionally use `on`/`off`. */
  variants: Record<string, JsonValue>;
  /** `false` serves `offVariant` to everyone (kill switch). */
  enabled: boolean;
  /** Served while disabled and when a prerequisite fails. */
  offVariant: string;
  /** Exact targeting key → variant. Checked before rules (QA, a specific customer). */
  overrides?: Record<string, string>;
  /** Tried in order; the first matching rule decides. */
  rules?: TargetingRule[];
  /** Served when no rule matches. */
  fallthrough: Serve;
  prerequisites?: Prerequisite[];
  /** Hash salt. Defaults to the flag key; changing it reshuffles every bucket. */
  salt?: string;
}

/** A reusable audience: explicit includes/excludes, then conditions (AND). */
export interface Segment {
  included?: string[];
  excluded?: string[];
  conditions?: AttributeCondition[];
}

export interface Ruleset {
  schemaVersion: number;
  /** Opaque revision (ETag-like), reported in `flagMetadata.rulesetVersion`. */
  version: string;
  flags: Record<string, FlagDefinition>;
  segments?: Record<string, Segment>;
}

/** An empty ruleset: every evaluation returns the code default with `FLAG_NOT_FOUND`. */
export function emptyRuleset(version = '0'): Ruleset {
  return { schemaVersion: RULESET_SCHEMA_VERSION, version, flags: {}, segments: {} };
}
