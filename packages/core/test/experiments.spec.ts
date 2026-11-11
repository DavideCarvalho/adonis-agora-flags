import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluate.js';
import { unsafeRegexReason } from '../src/regex_safety.js';
import type { FlagDefinition, Ruleset } from '../src/ruleset.js';
import { validateRuleset } from '../src/validate.js';

const experimentFlag = (overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  variants: { control: 'control', b: 'b' },
  enabled: true,
  offVariant: 'control',
  fallthrough: {
    split: [
      { variant: 'control', weight: 50 },
      { variant: 'b', weight: 50 },
    ],
  },
  experiment: {},
  ...overrides,
});

const rs = (partial: Partial<Ruleset>): Ruleset => ({
  schemaVersion: 1,
  version: 'r1',
  flags: {},
  ...partial,
});

describe('experiments', () => {
  it('reports the experiment key on split assignments', () => {
    const d = evaluate(
      rs({ flags: { checkout: experimentFlag({ experiment: { key: 'exp-7' } }) } }),
      'checkout',
      'control',
      {
        targetingKey: 'u1',
      },
    );
    expect(d.reason).toBe('SPLIT');
    expect(d.flagMetadata.experiment).toBe('exp-7');
  });

  describe('sticky assignments', () => {
    it('keep a subject on their variant after the weights change', () => {
      const before = rs({ flags: { f: experimentFlag() } });
      const assigned = new Map<string, string>();
      for (let i = 0; i < 200; i++) {
        assigned.set(`u${i}`, evaluate(before, 'f', 'control', { targetingKey: `u${i}` }).variant!);
      }
      const after = rs({
        flags: {
          f: experimentFlag({
            fallthrough: {
              split: [
                { variant: 'control', weight: 10 },
                { variant: 'b', weight: 90 },
              ],
            },
          }),
        },
      });
      for (const [key, variant] of assigned) {
        const d = evaluate(
          after,
          'f',
          'control',
          { targetingKey: key },
          { sticky: { f: variant } },
        );
        expect(d.variant).toBe(variant);
        expect(d.flagMetadata.sticky).toBe(true);
      }
    });

    it('are ignored when the variant left the split or the subject left the audience', () => {
      const flag = experimentFlag({
        fallthrough: { variant: 'control' },
        rules: [
          {
            id: 'pro',
            conditions: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
            serve: { split: [{ variant: 'b', weight: 1 }] },
          },
        ],
      });
      const ruleset = rs({ flags: { f: flag } });
      expect(
        evaluate(ruleset, 'f', 'x', { targetingKey: 'u', plan: 'free' }, { sticky: () => 'b' })
          .value,
      ).toBe('control');
      const gone = rs({
        flags: {
          f: experimentFlag({ fallthrough: { split: [{ variant: 'control', weight: 1 }] } }),
        },
      });
      expect(evaluate(gone, 'f', 'x', { targetingKey: 'u' }, { sticky: { f: 'b' } }).value).toBe(
        'control',
      );
    });
  });

  describe('global holdout', () => {
    it('keeps roughly the configured share out of every experiment', () => {
      const ruleset = rs({
        holdout: { percent: 10 },
        flags: { a: experimentFlag(), b: experimentFlag() },
      });
      let held = 0;
      for (let i = 0; i < 10_000; i++) {
        const da = evaluate(ruleset, 'a', 'x', { targetingKey: `u${i}` });
        const db = evaluate(ruleset, 'b', 'x', { targetingKey: `u${i}` });
        // Holdout membership is per subject, not per experiment.
        expect(da.flagMetadata.holdout === true).toBe(db.flagMetadata.holdout === true);
        if (da.flagMetadata.holdout) {
          held++;
          expect(da).toMatchObject({ value: 'control', reason: 'DEFAULT' });
        }
      }
      expect(Math.abs(held - 1000)).toBeLessThan(120);
    });

    it('does not apply to non-experiment flags or opted-out experiments', () => {
      const ruleset = rs({
        holdout: { percent: 100 },
        flags: {
          plain: experimentFlag({ experiment: undefined }),
          opted: experimentFlag({ experiment: { holdout: false } }),
        },
      });
      expect(evaluate(ruleset, 'plain', 'x', { targetingKey: 'u' }).reason).toBe('SPLIT');
      expect(evaluate(ruleset, 'opted', 'x', { targetingKey: 'u' }).reason).toBe('SPLIT');
    });
  });

  describe('layers', () => {
    const layered = rs({
      layers: { checkout: { allocations: { one: [0, 5000], two: [5000, 10_000] } } },
      flags: {
        one: experimentFlag({ experiment: { layer: 'checkout' } }),
        two: experimentFlag({ experiment: { layer: 'checkout' } }),
      },
    });

    it('never puts a subject in two experiments of the same layer', () => {
      let inOne = 0;
      for (let i = 0; i < 4000; i++) {
        const ctx = { targetingKey: `u${i}` };
        const one = evaluate(layered, 'one', 'x', ctx);
        const two = evaluate(layered, 'two', 'x', ctx);
        expect(one.reason === 'SPLIT' && two.reason === 'SPLIT').toBe(false);
        expect(one.reason === 'SPLIT' || two.reason === 'SPLIT').toBe(true);
        if (one.reason === 'SPLIT') inOne++;
        else expect(one.flagMetadata).toMatchObject({ layer: 'checkout', layerExcluded: true });
      }
      expect(Math.abs(inOne - 2000)).toBeLessThan(150);
    });

    it('needs a targeting key and an existing layer', () => {
      expect(evaluate(layered, 'one', 'x').errorCode).toBe('TARGETING_KEY_MISSING');
      const broken = rs({ flags: { f: experimentFlag({ experiment: { layer: 'ghost' } }) } });
      expect(evaluate(broken, 'f', 'x', { targetingKey: 'u' }).errorCode).toBe('PARSE_ERROR');
    });

    it('validates allocations', () => {
      const issues = validateRuleset(
        rs({
          layers: { l: { allocations: { a: [0, 6000], b: [5000, 10_000], c: [0, 20_000] } } },
          flags: {
            a: experimentFlag({ experiment: { layer: 'l' } }),
            b: experimentFlag({ experiment: { layer: 'l' } }),
            c: experimentFlag(),
            d: experimentFlag({ experiment: { layer: 'missing' } }),
          },
          holdout: { percent: 120 },
        }),
      );
      const paths = issues.map((i) => i.path);
      expect(paths).toEqual(
        expect.arrayContaining([
          'layers.l.allocations.b',
          'layers.l.allocations.c',
          'flags.d.experiment.layer',
          'holdout.percent',
        ]),
      );
    });
  });
});

describe('regex safety', () => {
  it('accepts ordinary patterns', () => {
    for (const ok of [
      '^ab\\d+$',
      '@agora\\.dev$',
      '^(?:pro|team)$',
      '(ab)?c',
      '^\\w+@\\w+\\.com$',
      '[(+*)]+',
    ]) {
      expect(unsafeRegexReason(ok)).toBeUndefined();
    }
  });

  it('rejects catastrophic and oversized patterns', () => {
    expect(unsafeRegexReason('(a+)+$')).toMatch(/catastrophic/);
    expect(unsafeRegexReason('(x*)*y')).toMatch(/catastrophic/);
    expect(unsafeRegexReason('((ab)*c)+')).toMatch(/catastrophic/);
    expect(unsafeRegexReason('(\\d{2,})+')).toMatch(/catastrophic/);
    expect(unsafeRegexReason('(a)\\1')).toMatch(/backreference/);
    expect(unsafeRegexReason('a'.repeat(300))).toMatch(/longer/);
    expect(unsafeRegexReason('(')).toMatch(/invalid/);
  });

  it('makes a flag with an unsafe pattern fail closed, and skips huge inputs', () => {
    const flag = (pattern: string): FlagDefinition => ({
      variants: { on: true, off: false },
      enabled: true,
      offVariant: 'off',
      fallthrough: { variant: 'off' },
      rules: [
        {
          id: 'r',
          conditions: [{ attribute: 'e', op: 'matches', values: [pattern] }],
          serve: { variant: 'on' },
        },
      ],
    });
    expect(evaluate(rs({ flags: { f: flag('(a+)+$') } }), 'f', false, { e: 'aaa' }).errorCode).toBe(
      'PARSE_ERROR',
    );
    expect(
      evaluate(rs({ flags: { f: flag('^a') } }), 'f', false, { e: 'a'.repeat(5000) }).value,
    ).toBe(false);
    expect(validateRuleset(rs({ flags: { f: flag('(a+)+$') } }))[0]?.path).toBe(
      'flags.f.rules[0].conditions[0].values',
    );
  });
});
