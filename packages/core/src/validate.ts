import { BUCKET_COUNT } from './bucket.js';
import { unsafeRegexReason } from './regex_safety.js';
import {
  type AttributeCondition,
  type Condition,
  type FlagDeclarationData,
  METRIC_KINDS,
  type MetricDefinition,
  OPERATORS,
  RULESET_SCHEMA_VERSION,
  type Ruleset,
  type Serve,
  valueTypeOf,
} from './ruleset.js';

/** One problem found in a ruleset. `path` points at it, e.g. `flags.checkout.rules[0].serve`. */
export interface RulesetIssue {
  path: string;
  message: string;
}

const KNOWN_OPERATORS: ReadonlySet<string> = new Set(OPERATORS);

/**
 * Checks a ruleset before it is saved or published. Evaluation already fails closed on all of
 * these, so this is about rejecting the edit with a useful message instead of silently serving
 * code defaults. Returns an empty array when the ruleset is valid.
 */
export interface ValidateOptions {
  /**
   * Metric names defined outside the ruleset (the app's config). Experiments may reference them
   * as well as `ruleset.metrics`. When omitted, metric references are not checked.
   */
  metrics?: Iterable<string>;
}

export function validateRuleset(ruleset: Ruleset, options: ValidateOptions = {}): RulesetIssue[] {
  const issues: RulesetIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path, message });

  if (!Number.isInteger(ruleset.schemaVersion) || ruleset.schemaVersion < 1) {
    add('schemaVersion', 'must be a positive integer');
  } else if (ruleset.schemaVersion > RULESET_SCHEMA_VERSION) {
    add('schemaVersion', `this engine supports up to ${RULESET_SCHEMA_VERSION}`);
  }

  const segments = ruleset.segments ?? {};
  for (const [name, segment] of Object.entries(segments)) {
    (segment.conditions ?? []).forEach((condition, i) => {
      checkAttribute(condition, `segments.${name}.conditions[${i}]`, add);
    });
  }

  for (const [key, flag] of Object.entries(ruleset.flags)) {
    const base = `flags.${key}`;
    const variants = Object.keys(flag.variants);
    if (variants.length === 0) add(`${base}.variants`, 'needs at least one variant');
    const known = (variant: string, path: string) => {
      if (!Object.hasOwn(flag.variants, variant)) add(path, `unknown variant "${variant}"`);
    };

    known(flag.offVariant, `${base}.offVariant`);
    for (const [targetingKey, variant] of Object.entries(flag.overrides ?? {})) {
      known(variant, `${base}.overrides.${targetingKey}`);
    }
    const ruleIds = new Set<string>();
    (flag.rules ?? []).forEach((rule, i) => {
      const path = `${base}.rules[${i}]`;
      if (!rule.id) add(`${path}.id`, 'is required');
      else if (ruleIds.has(rule.id)) add(`${path}.id`, `duplicate rule id "${rule.id}"`);
      else ruleIds.add(rule.id);
      rule.conditions.forEach((condition, j) => {
        checkCondition(condition, `${path}.conditions[${j}]`, segments, add);
      });
      checkServe(rule.serve, `${path}.serve`, known, add);
    });
    checkServe(flag.fallthrough, `${base}.fallthrough`, known, add);

    (flag.prerequisites ?? []).forEach((prerequisite, i) => {
      const path = `${base}.prerequisites[${i}]`;
      const parent = ruleset.flags[prerequisite.flag];
      if (!parent) add(path, `unknown flag "${prerequisite.flag}"`);
      else if (!Object.hasOwn(parent.variants, prerequisite.variant)) {
        add(path, `flag "${prerequisite.flag}" has no variant "${prerequisite.variant}"`);
      }
    });
  }

  if (ruleset.holdout) {
    const { percent } = ruleset.holdout;
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      add('holdout.percent', 'must be between 0 and 100');
    }
  }
  for (const [name, layer] of Object.entries(ruleset.layers ?? {})) {
    const ranges: Array<[string, number, number]> = [];
    for (const [flagKey, range] of Object.entries(layer.allocations)) {
      const path = `layers.${name}.allocations.${flagKey}`;
      const flag = ruleset.flags[flagKey];
      if (!flag) add(path, `unknown flag "${flagKey}"`);
      else if (flag.experiment?.layer !== name) {
        add(path, `flag "${flagKey}" is not an experiment in layer "${name}"`);
      }
      const [start, end] = range;
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end > BUCKET_COUNT ||
        start >= end
      ) {
        add(path, `must be an integer range [start, end) within 0 … ${BUCKET_COUNT}`);
        continue;
      }
      ranges.push([flagKey, start, end]);
    }
    ranges.sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i]![1] < ranges[i - 1]![2]) {
        add(`layers.${name}.allocations.${ranges[i]![0]}`, `overlaps "${ranges[i - 1]![0]}"`);
      }
    }
  }
  for (const [key, flag] of Object.entries(ruleset.flags)) {
    const layer = flag.experiment?.layer;
    if (layer !== undefined && !ruleset.layers?.[layer]) {
      add(`flags.${key}.experiment.layer`, `unknown layer "${layer}"`);
    }
  }

  for (const [name, definition] of Object.entries(ruleset.metrics ?? {})) {
    checkMetric(definition, `metrics.${name}`, add);
  }
  const knownMetrics = options.metrics
    ? new Set([...options.metrics, ...Object.keys(ruleset.metrics ?? {})])
    : undefined;
  for (const [key, flag] of Object.entries(ruleset.flags)) {
    const experiment = flag.experiment;
    if (!experiment) continue;
    const base = `flags.${key}.experiment`;
    for (const list of ['metrics', 'guardrails'] as const) {
      (experiment[list] ?? []).forEach((name, i) => {
        if (knownMetrics && !knownMetrics.has(name)) {
          add(`${base}.${list}[${i}]`, `unknown metric "${name}"`);
        }
      });
    }
    if (experiment.control !== undefined && !Object.hasOwn(flag.variants, experiment.control)) {
      add(`${base}.control`, `unknown variant "${experiment.control}"`);
    }
    if (
      experiment.confidence !== undefined &&
      !(
        Number.isFinite(experiment.confidence) &&
        experiment.confidence > 0 &&
        experiment.confidence < 1
      )
    ) {
      add(`${base}.confidence`, 'must be between 0 and 1');
    }
  }

  for (const [key, flag] of Object.entries(ruleset.flags)) {
    if (flag.declaration) checkDeclaration(flag.declaration, flag.variants, `flags.${key}`, add);
  }

  for (const cycle of prerequisiteCycles(ruleset)) {
    add(`flags.${cycle[0]}.prerequisites`, `prerequisite cycle: ${cycle.join(' → ')}`);
  }
  return issues;
}

type Add = (path: string, message: string) => void;

const KNOWN_METRIC_KINDS: ReadonlySet<string> = new Set(METRIC_KINDS);

function checkMetric(metric: MetricDefinition, path: string, add: Add) {
  if (!KNOWN_METRIC_KINDS.has(metric.kind)) {
    add(`${path}.kind`, 'must be conversion, count or sum');
  }
  if (typeof metric.event !== 'string' || metric.event.trim() === '') {
    add(`${path}.event`, 'is required');
  }
  if (metric.windowMs !== undefined && !(Number.isFinite(metric.windowMs) && metric.windowMs > 0)) {
    add(`${path}.windowMs`, 'must be a number of milliseconds > 0');
  }
  if (metric.cupedMs !== undefined && !(Number.isFinite(metric.cupedMs) && metric.cupedMs >= 0)) {
    add(`${path}.cupedMs`, 'must be a number of milliseconds ≥ 0');
  }
  if (
    metric.direction !== undefined &&
    metric.direction !== 'increase' &&
    metric.direction !== 'decrease'
  ) {
    add(`${path}.direction`, 'must be increase or decrease');
  }
}

function checkCondition(
  condition: Condition,
  path: string,
  segments: NonNullable<Ruleset['segments']>,
  add: Add,
) {
  if ('segment' in condition) {
    if (!Object.hasOwn(segments, condition.segment))
      add(path, `unknown segment "${condition.segment}"`);
    return;
  }
  checkAttribute(condition, path, add);
}

function checkAttribute(condition: AttributeCondition, path: string, add: Add) {
  if (!condition.attribute) add(`${path}.attribute`, 'is required');
  if (!KNOWN_OPERATORS.has(condition.op)) {
    add(`${path}.op`, `unknown operator "${String(condition.op)}"`);
    return;
  }
  if (condition.op !== 'exists' && (condition.values ?? []).length === 0) {
    add(`${path}.values`, `operator "${condition.op}" needs at least one value`);
  }
  if (condition.op === 'matches') {
    for (const value of condition.values ?? []) {
      const unsafe = unsafeRegexReason(String(value));
      if (unsafe) add(`${path}.values`, `${JSON.stringify(value)}: ${unsafe}`);
    }
  }
}

function checkServe(serve: Serve, path: string, known: (v: string, p: string) => void, add: Add) {
  if ('variant' in serve) {
    known(serve.variant, `${path}.variant`);
    return;
  }
  if (serve.split.length === 0) add(`${path}.split`, 'needs at least one arm');
  if (!serve.split.some((arm) => arm.weight > 0)) add(`${path}.split`, 'needs a positive weight');
  serve.split.forEach((arm, i) => {
    known(arm.variant, `${path}.split[${i}].variant`);
    if (!Number.isFinite(arm.weight) || arm.weight < 0) {
      add(`${path}.split[${i}].weight`, 'must be a finite number ≥ 0');
    }
  });
}

/** Every distinct prerequisite cycle, each listed once starting from its smallest key. */
function prerequisiteCycles(ruleset: Ruleset): string[][] {
  const cycles = new Map<string, string[]>();
  // Nodes whose whole subtree was explored: any cycle through them is already recorded.
  const done = new Set<string>();
  const visit = (key: string, stack: string[]) => {
    const at = stack.indexOf(key);
    if (at !== -1) {
      const loop = stack.slice(at);
      const start = loop.indexOf([...loop].sort()[0]!);
      const normalized = [...loop.slice(start), ...loop.slice(0, start)];
      cycles.set(normalized.join('\u0000'), [...normalized, normalized[0]!]);
      return;
    }
    if (done.has(key)) return;
    for (const prerequisite of ruleset.flags[key]?.prerequisites ?? []) {
      visit(prerequisite.flag, [...stack, key]);
    }
    done.add(key);
  };
  for (const key of Object.keys(ruleset.flags)) visit(key, []);
  return [...cycles.values()];
}

const VALUE_TYPES = new Set(['boolean', 'string', 'number', 'json']);

/** A declaration must be self-consistent and agree with the flag's variants. */
function checkDeclaration(
  declaration: FlagDeclarationData,
  variants: Record<string, unknown>,
  base: string,
  add: Add,
) {
  const path = `${base}.declaration`;
  if (!VALUE_TYPES.has(declaration.type)) {
    add(`${path}.type`, 'must be boolean, string, number or json');
    return;
  }
  if (
    declaration.type !== 'json' &&
    valueTypeOf(declaration.default as never) !== declaration.type
  ) {
    add(`${path}.default`, `must be a ${declaration.type}`);
  }
  if (declaration.variants) {
    if (declaration.type !== 'string')
      add(`${path}.variants`, 'only string flags have named variants');
    else if (!declaration.variants.includes(String(declaration.default))) {
      add(`${path}.default`, 'must be one of the declared variants');
    }
  }
  if (declaration.expiresAt !== undefined && Number.isNaN(Date.parse(declaration.expiresAt))) {
    add(`${path}.expiresAt`, 'must be an ISO date');
  }
  if (declaration.type === 'json') return;
  for (const [name, value] of Object.entries(variants)) {
    if (valueTypeOf(value as never) !== declaration.type) {
      add(
        `${base}.variants.${name}`,
        `is ${valueTypeOf(value as never)}, the flag is declared ${declaration.type}`,
      );
    } else if (declaration.variants && !declaration.variants.includes(String(value))) {
      add(`${base}.variants.${name}`, `"${String(value)}" is not one of the declared variants`);
    }
  }
}
