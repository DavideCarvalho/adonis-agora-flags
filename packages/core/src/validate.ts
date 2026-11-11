import { BUCKET_COUNT } from './bucket.js';
import { unsafeRegexReason } from './regex_safety.js';
import {
  type AttributeCondition,
  type Condition,
  OPERATORS,
  RULESET_SCHEMA_VERSION,
  type Ruleset,
  type Serve,
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
export function validateRuleset(ruleset: Ruleset): RulesetIssue[] {
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

  for (const cycle of prerequisiteCycles(ruleset)) {
    add(`flags.${cycle[0]}.prerequisites`, `prerequisite cycle: ${cycle.join(' → ')}`);
  }
  return issues;
}

type Add = (path: string, message: string) => void;

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
