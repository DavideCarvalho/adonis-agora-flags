import { describe, expect, it } from 'vitest';
import type { FlagDefinition } from '../client/flags-client';
import {
  cleanDefinition,
  isOnOff,
  nextRuleId,
  parseConditionValues,
  parseVariantValue,
  renameVariant,
  rolloutSteps,
  splitPercents,
  toFixed,
  toSplit,
} from './flag-model';
import { describeServing, formatP, formatPercent } from './serving';

const base: FlagDefinition = {
  variants: { control: 'control', b: 'b' },
  enabled: true,
  offVariant: 'control',
  fallthrough: {
    split: [
      { variant: 'control', weight: 50 },
      { variant: 'b', weight: 50 },
    ],
  },
  rules: [{ id: 'r1', conditions: [], serve: { variant: 'b' } }],
  overrides: { qa: 'b' },
};

describe('variant values', () => {
  it('reads what is typed by the declared type', () => {
    expect(parseVariantValue('true', 'boolean')).toBe(true);
    expect(parseVariantValue('42', 'number')).toBe(42);
    // A string flag keeps "true" a string — it is a variant name, not a boolean.
    expect(parseVariantValue('true', 'string')).toBe('true');
    expect(parseVariantValue('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(parseVariantValue('{"a":', 'json')).toBe('{"a":');
  });
});

describe('conditions', () => {
  it('splits values and keeps numbers numeric for numeric operators', () => {
    expect(parseConditionValues('a, b ,, c', 'in')).toEqual(['a', 'b', 'c']);
    expect(parseConditionValues('10, x', 'gte')).toEqual([10, 'x']);
    expect(parseConditionValues('10', 'in')).toEqual(['10']);
  });
});

describe('editing a definition', () => {
  it('renames a variant everywhere it is referenced', () => {
    const next = renameVariant(base, 'b', 'treatment');
    expect(Object.keys(next.variants)).toEqual(['control', 'treatment']);
    expect(next.rules?.[0]?.serve).toEqual({ variant: 'treatment' });
    expect(next.overrides).toEqual({ qa: 'treatment' });
    expect('split' in next.fallthrough && next.fallthrough.split[1]?.variant).toBe('treatment');
  });

  it('switches a serve between fixed and split', () => {
    expect(toFixed(base.fallthrough, ['control', 'b'])).toEqual({ variant: 'control' });
    expect(toSplit({ variant: 'b' }, ['control', 'b'])).toEqual({
      split: [
        { variant: 'control', weight: 0 },
        { variant: 'b', weight: 100 },
      ],
    });
  });

  it('shows relative weights as percentages', () => {
    expect(splitPercents([{ weight: 1 }, { weight: 3 }])).toEqual([25, 75]);
    expect(splitPercents([{ weight: 0 }])).toEqual([0]);
  });

  it('drops empty optional parts before saving', () => {
    const clean = cleanDefinition({
      ...base,
      rules: [],
      overrides: {},
      tags: [],
      salt: '',
      experiment: { key: '', holdout: true },
    });
    expect(clean).toEqual({
      variants: base.variants,
      enabled: true,
      offVariant: 'control',
      fallthrough: base.fallthrough,
      experiment: {},
    });
  });

  it('picks unused rule ids', () => {
    expect(nextRuleId([{ id: 'rule-2' }])).toBe('rule-3');
    expect(nextRuleId([{ id: 'rule-1' }, { id: 'rule-3' }])).toBe('rule-4');
  });

  it('knows an on/off flag', () => {
    expect(isOnOff({ ...base, variants: { on: true, off: false } })).toBe(true);
    expect(isOnOff(base)).toBe(false);
  });

  it('spaces gradual rollout steps', () => {
    const steps = rolloutSteps(new Date('2026-01-01T00:00:00.000Z'), [10, 50, 100], 24);
    expect(steps.map((s) => s.at)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ]);
  });
});

describe('formatting', () => {
  it('describes what a flag serves', () => {
    expect(describeServing({ kind: 'rollout', percent: 25 })).toBe('25% on');
    expect(describeServing({ kind: 'off', variant: 'off' })).toBe('off → off');
    expect(describeServing({ kind: 'default', value: false })).toBe('code default false');
    expect(
      describeServing({
        kind: 'split',
        arms: [
          { variant: 'a', percent: 50 },
          { variant: 'b', percent: 50 },
        ],
        bucketBy: 'orgId',
      }),
    ).toBe('a 50% / b 50% by orgId');
  });

  it('formats lifts and p-values', () => {
    expect(formatPercent(0.1234)).toBe('+12.34%');
    expect(formatPercent(-0.05)).toBe('-5.00%');
    expect(formatP(0.0001)).toBe('<0.001');
    expect(formatP(0.0456)).toBe('0.046');
  });
});
