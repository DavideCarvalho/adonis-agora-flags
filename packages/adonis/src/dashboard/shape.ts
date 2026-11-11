import type { RulesetIssue } from '@adonis-agora/flags-core';

/**
 * Structural checks for what the console sends, run BEFORE the change reaches `FlagsAdmin.preview`.
 *
 * `validateRuleset` checks meaning (unknown variants, overlapping layer ranges, unsafe regexes) and
 * assumes the shape is already right — it walks `rule.conditions` without asking whether it is an
 * array. A request body is not a ruleset until something has looked at it, so a malformed edit
 * answers `422` with a path instead of a `TypeError` from deep inside the engine.
 */

type Add = (path: string, message: string) => void;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function collect(check: (add: Add) => void): RulesetIssue[] {
  const issues: RulesetIssue[] = [];
  check((path, message) => issues.push({ path, message }));
  return issues;
}

function checkStringList(value: unknown, path: string, add: Add) {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    add(path, 'must be a list of strings');
  }
}

function checkAttributeCondition(value: unknown, path: string, add: Add) {
  if (!isObject(value)) return add(path, 'must be an object');
  if (typeof value.attribute !== 'string') add(`${path}.attribute`, 'must be a string');
  if (typeof value.op !== 'string') add(`${path}.op`, 'must be a string');
  if (value.values !== undefined) {
    const ok =
      Array.isArray(value.values) &&
      value.values.every((v) => ['string', 'number', 'boolean'].includes(typeof v));
    if (!ok) add(`${path}.values`, 'must be a list of strings, numbers or booleans');
  }
  if (value.negate !== undefined && typeof value.negate !== 'boolean') {
    add(`${path}.negate`, 'must be a boolean');
  }
}

function checkCondition(value: unknown, path: string, add: Add) {
  if (isObject(value) && 'segment' in value) {
    if (typeof value.segment !== 'string') add(`${path}.segment`, 'must be a string');
    if (value.negate !== undefined && typeof value.negate !== 'boolean') {
      add(`${path}.negate`, 'must be a boolean');
    }
    return;
  }
  checkAttributeCondition(value, path, add);
}

function checkServe(value: unknown, path: string, add: Add) {
  if (!isObject(value)) return add(path, 'must be { variant } or { split }');
  if ('variant' in value) {
    if (typeof value.variant !== 'string') add(`${path}.variant`, 'must be a string');
    return;
  }
  if (!Array.isArray(value.split)) return add(path, 'must be { variant } or { split }');
  value.split.forEach((arm, i) => {
    if (!isObject(arm) || typeof arm.variant !== 'string' || typeof arm.weight !== 'number') {
      add(`${path}.split[${i}]`, 'must be { variant: string, weight: number }');
    }
  });
  if (value.bucketBy !== undefined && typeof value.bucketBy !== 'string') {
    add(`${path}.bucketBy`, 'must be a string');
  }
}

/** Shape of a `FlagDefinition`. */
export function flagDefinitionIssues(value: unknown, path = 'definition'): RulesetIssue[] {
  return collect((add) => {
    if (!isObject(value)) return add(path, 'must be an object');
    if (!isObject(value.variants)) add(`${path}.variants`, 'must be an object');
    if (typeof value.enabled !== 'boolean') add(`${path}.enabled`, 'must be a boolean');
    if (typeof value.offVariant !== 'string') add(`${path}.offVariant`, 'must be a string');
    checkServe(value.fallthrough, `${path}.fallthrough`, add);
    if (value.overrides !== undefined) {
      if (!isObject(value.overrides)) add(`${path}.overrides`, 'must be an object');
      else {
        for (const [k, v] of Object.entries(value.overrides)) {
          if (typeof v !== 'string') add(`${path}.overrides.${k}`, 'must be a variant name');
        }
      }
    }
    if (value.rules !== undefined) {
      if (!Array.isArray(value.rules)) add(`${path}.rules`, 'must be a list');
      else {
        value.rules.forEach((rule, i) => {
          const at = `${path}.rules[${i}]`;
          if (!isObject(rule)) {
            add(at, 'must be an object');
            return;
          }
          if (typeof rule.id !== 'string') add(`${at}.id`, 'must be a string');
          if (!Array.isArray(rule.conditions)) add(`${at}.conditions`, 'must be a list');
          else {
            rule.conditions.forEach((c, j) => {
              checkCondition(c, `${at}.conditions[${j}]`, add);
            });
          }
          checkServe(rule.serve, `${at}.serve`, add);
        });
      }
    }
    if (value.prerequisites !== undefined) {
      if (!Array.isArray(value.prerequisites)) add(`${path}.prerequisites`, 'must be a list');
      else {
        value.prerequisites.forEach((p, i) => {
          if (!isObject(p) || typeof p.flag !== 'string' || typeof p.variant !== 'string') {
            add(`${path}.prerequisites[${i}]`, 'must be { flag: string, variant: string }');
          }
        });
      }
    }
    if (value.salt !== undefined && typeof value.salt !== 'string') {
      add(`${path}.salt`, 'must be a string');
    }
    if (value.experiment !== undefined) {
      const e = value.experiment;
      if (!isObject(e)) add(`${path}.experiment`, 'must be an object');
      else {
        if (e.key !== undefined && typeof e.key !== 'string') {
          add(`${path}.experiment.key`, 'must be a string');
        }
        if (e.layer !== undefined && typeof e.layer !== 'string') {
          add(`${path}.experiment.layer`, 'must be a string');
        }
        if (e.holdout !== undefined && typeof e.holdout !== 'boolean') {
          add(`${path}.experiment.holdout`, 'must be a boolean');
        }
      }
    }
    checkStringList(value.tags, `${path}.tags`, add);
  });
}

/** Shape of a `Segment`. */
export function segmentIssues(value: unknown, path = 'segment'): RulesetIssue[] {
  return collect((add) => {
    if (!isObject(value)) return add(path, 'must be an object');
    checkStringList(value.included, `${path}.included`, add);
    checkStringList(value.excluded, `${path}.excluded`, add);
    if (value.conditions !== undefined) {
      if (!Array.isArray(value.conditions)) add(`${path}.conditions`, 'must be a list');
      else {
        for (const [i, c] of value.conditions.entries()) {
          checkAttributeCondition(c, `${path}.conditions[${i}]`, add);
        }
      }
    }
  });
}

/** Shape of a `Layer`. */
export function layerIssues(value: unknown, path = 'layer'): RulesetIssue[] {
  return collect((add) => {
    if (!isObject(value)) return add(path, 'must be an object');
    if (value.salt !== undefined && typeof value.salt !== 'string') {
      add(`${path}.salt`, 'must be a string');
    }
    if (!isObject(value.allocations)) return add(`${path}.allocations`, 'must be an object');
    for (const [flag, range] of Object.entries(value.allocations)) {
      const ok =
        Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === 'number');
      if (!ok) add(`${path}.allocations.${flag}`, 'must be a [start, end] pair of numbers');
    }
  });
}

/** Shape of the `Holdout` (`null` removes it). */
export function holdoutIssues(value: unknown, path = 'holdout'): RulesetIssue[] {
  return collect((add) => {
    if (value === null) return;
    if (!isObject(value)) return add(path, 'must be an object or null');
    if (typeof value.percent !== 'number') add(`${path}.percent`, 'must be a number');
    if (value.salt !== undefined && typeof value.salt !== 'string') {
      add(`${path}.salt`, 'must be a string');
    }
  });
}

/** Shape of an imported ruleset: `flags` required, the rest optional. */
export function rulesetIssues(value: unknown, path = 'ruleset'): RulesetIssue[] {
  return collect((add) => {
    if (!isObject(value)) return add(path, 'must be an object');
    if (!isObject(value.flags)) return add(`${path}.flags`, 'must be an object');
    for (const [key, definition] of Object.entries(value.flags)) {
      for (const issue of flagDefinitionIssues(definition, `${path}.flags.${key}`)) {
        add(issue.path, issue.message);
      }
    }
    if (value.segments !== undefined) {
      if (!isObject(value.segments)) add(`${path}.segments`, 'must be an object');
      else {
        for (const [key, segment] of Object.entries(value.segments)) {
          for (const issue of segmentIssues(segment, `${path}.segments.${key}`)) {
            add(issue.path, issue.message);
          }
        }
      }
    }
    if (value.layers !== undefined) {
      if (!isObject(value.layers)) add(`${path}.layers`, 'must be an object');
      else {
        for (const [key, layer] of Object.entries(value.layers)) {
          for (const issue of layerIssues(layer, `${path}.layers.${key}`)) {
            add(issue.path, issue.message);
          }
        }
      }
    }
    if (value.holdout !== undefined) {
      for (const issue of holdoutIssues(value.holdout, `${path}.holdout`)) {
        add(issue.path, issue.message);
      }
    }
    if (value.schemaVersion !== undefined && typeof value.schemaVersion !== 'number') {
      add(`${path}.schemaVersion`, 'must be a number');
    }
  });
}
