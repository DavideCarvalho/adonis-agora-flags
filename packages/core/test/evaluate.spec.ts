import { describe, expect, it } from 'vitest';
import { compareSemver, evaluate } from '../src/evaluate.js';
import type { FlagDefinition, Ruleset } from '../src/ruleset.js';

const boolFlag = (overrides: Partial<FlagDefinition> = {}): FlagDefinition => ({
  variants: { on: true, off: false },
  enabled: true,
  offVariant: 'off',
  fallthrough: { variant: 'on' },
  ...overrides,
});

const rs = (flags: Ruleset['flags'], segments: Ruleset['segments'] = {}): Ruleset => ({
  schemaVersion: 1,
  version: 'r1',
  flags,
  segments,
});

describe('evaluate', () => {
  it('returns the code default with FLAG_NOT_FOUND for a missing flag', () => {
    const d = evaluate(rs({}), 'nope', false);
    expect(d).toMatchObject({ value: false, reason: 'ERROR', errorCode: 'FLAG_NOT_FOUND' });
    expect(d.variant).toBeUndefined();
  });

  it('serves a static fallthrough with STATIC', () => {
    const d = evaluate(rs({ f: boolFlag() }), 'f', false);
    expect(d).toMatchObject({ value: true, variant: 'on', reason: 'STATIC' });
    expect(d.flagMetadata.rulesetVersion).toBe('r1');
  });

  it('serves offVariant with DISABLED when the kill switch is off', () => {
    const d = evaluate(rs({ f: boolFlag({ enabled: false }) }), 'f', true);
    expect(d).toMatchObject({ value: false, variant: 'off', reason: 'DISABLED' });
  });

  it('checks overrides before rules', () => {
    const flag = boolFlag({
      fallthrough: { variant: 'off' },
      overrides: { qa: 'on' },
      rules: [
        {
          id: 'r',
          conditions: [{ attribute: 'plan', op: 'in', values: ['free'] }],
          serve: { variant: 'off' },
        },
      ],
    });
    const d = evaluate(rs({ f: flag }), 'f', false, { targetingKey: 'qa', plan: 'free' });
    expect(d).toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
      flagMetadata: { override: true },
    });
  });

  it('applies the first matching rule and reports its id', () => {
    const flag = boolFlag({
      fallthrough: { variant: 'off' },
      rules: [
        {
          id: 'pro',
          conditions: [{ attribute: 'plan', op: 'in', values: ['pro', 'team'] }],
          serve: { variant: 'on' },
        },
        { id: 'all', conditions: [], serve: { variant: 'off' } },
      ],
    });
    expect(evaluate(rs({ f: flag }), 'f', false, { plan: 'team' })).toMatchObject({
      value: true,
      reason: 'TARGETING_MATCH',
      flagMetadata: { ruleId: 'pro' },
    });
    expect(evaluate(rs({ f: flag }), 'f', true, { plan: 'free' })).toMatchObject({
      value: false,
      flagMetadata: { ruleId: 'all' },
    });
  });

  it('reports DEFAULT when targeting exists but nothing matched', () => {
    const flag = boolFlag({
      rules: [
        {
          id: 'r',
          conditions: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
          serve: { variant: 'off' },
        },
      ],
    });
    expect(evaluate(rs({ f: flag }), 'f', false, { plan: 'free' }).reason).toBe('DEFAULT');
  });

  it('splits deterministically with SPLIT and roughly honours the weights', () => {
    const flag: FlagDefinition = {
      variants: { control: 'control', b: 'b' },
      enabled: true,
      offVariant: 'control',
      fallthrough: {
        split: [
          { variant: 'control', weight: 50 },
          { variant: 'b', weight: 50 },
        ],
      },
    };
    const ruleset = rs({ exp: flag });
    const first = evaluate(ruleset, 'exp', 'control', { targetingKey: 'u1' });
    expect(first.reason).toBe('SPLIT');
    expect(evaluate(ruleset, 'exp', 'control', { targetingKey: 'u1' }).variant).toBe(first.variant);
    let b = 0;
    for (let i = 0; i < 10_000; i++) {
      if (evaluate(ruleset, 'exp', 'control', { targetingKey: `u${i}` }).value === 'b') b++;
    }
    expect(Math.abs(b - 5000)).toBeLessThan(250);
  });

  it('splits by another attribute with bucketBy, so a whole org shares a variant', () => {
    const flag: FlagDefinition = {
      variants: { a: 'a', b: 'b' },
      enabled: true,
      offVariant: 'a',
      fallthrough: {
        split: [
          { variant: 'a', weight: 1 },
          { variant: 'b', weight: 1 },
        ],
        bucketBy: 'orgId',
      },
    };
    const ruleset = rs({ f: flag });
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++)
      seen.add(evaluate(ruleset, 'f', 'a', { targetingKey: `u${i}`, orgId: 'org-9' }).value);
    expect(seen.size).toBe(1);
  });

  it('fails with TARGETING_KEY_MISSING when a split has no key to hash', () => {
    const flag: FlagDefinition = {
      variants: { a: 'a', b: 'b' },
      enabled: true,
      offVariant: 'a',
      fallthrough: {
        split: [
          { variant: 'a', weight: 1 },
          { variant: 'b', weight: 1 },
        ],
      },
    };
    expect(evaluate(rs({ f: flag }), 'f', 'z')).toMatchObject({
      value: 'z',
      reason: 'ERROR',
      errorCode: 'TARGETING_KEY_MISSING',
    });
  });

  it('returns TYPE_MISMATCH instead of a value of the wrong type', () => {
    expect(evaluate(rs({ f: boolFlag() }), 'f', 'x')).toMatchObject({
      value: 'x',
      errorCode: 'TYPE_MISMATCH',
    });
    expect(evaluate(rs({ f: boolFlag() }), 'f', null).value).toBe(true);
  });

  describe('fails closed', () => {
    it('on a newer schemaVersion', () => {
      const ruleset = { ...rs({ f: boolFlag() }), schemaVersion: 2 };
      expect(evaluate(ruleset, 'f', false)).toMatchObject({
        value: false,
        errorCode: 'PARSE_ERROR',
      });
    });

    it('on an unknown operator in a rule it reaches', () => {
      const flag = boolFlag({
        fallthrough: { variant: 'off' },
        rules: [
          {
            id: 'r',
            conditions: [{ attribute: 'x', op: 'geoWithin' as never, values: ['br'] }],
            serve: { variant: 'on' },
          },
        ],
      });
      expect(evaluate(rs({ f: flag }), 'f', false, { x: 'br' })).toMatchObject({
        value: false,
        errorCode: 'PARSE_ERROR',
      });
    });

    it('on an unknown variant, segment or invalid regex', () => {
      expect(
        evaluate(rs({ f: boolFlag({ fallthrough: { variant: 'maybe' } }) }), 'f', false).errorCode,
      ).toBe('PARSE_ERROR');
      const seg = boolFlag({
        rules: [{ id: 'r', conditions: [{ segment: 'ghost' }], serve: { variant: 'on' } }],
      });
      expect(evaluate(rs({ f: seg }), 'f', false).errorCode).toBe('PARSE_ERROR');
      const re = boolFlag({
        rules: [
          {
            id: 'r',
            conditions: [{ attribute: 'e', op: 'matches', values: ['('] }],
            serve: { variant: 'on' },
          },
        ],
      });
      expect(evaluate(rs({ f: re }), 'f', false, { e: 'a' }).errorCode).toBe('PARSE_ERROR');
    });

    it('on a prerequisite cycle', () => {
      const ruleset = rs({
        a: boolFlag({ prerequisites: [{ flag: 'b', variant: 'on' }] }),
        b: boolFlag({ prerequisites: [{ flag: 'a', variant: 'on' }] }),
      });
      expect(evaluate(ruleset, 'a', false)).toMatchObject({ errorCode: 'PARSE_ERROR' });
      expect(evaluate(ruleset, 'a', false).errorMessage).toContain('a → b → a');
    });
  });

  describe('prerequisites', () => {
    it('serves the child normally when the parent resolves to the required variant', () => {
      const ruleset = rs({
        parent: boolFlag(),
        child: boolFlag({ prerequisites: [{ flag: 'parent', variant: 'on' }] }),
      });
      expect(evaluate(ruleset, 'child', false).value).toBe(true);
    });

    it('serves offVariant when the parent is off or missing', () => {
      const off = rs({
        parent: boolFlag({ enabled: false }),
        child: boolFlag({ prerequisites: [{ flag: 'parent', variant: 'on' }] }),
      });
      expect(evaluate(off, 'child', true)).toMatchObject({
        value: false,
        reason: 'DISABLED',
        flagMetadata: { prerequisiteFailed: 'parent' },
      });
      const missing = rs({
        child: boolFlag({ prerequisites: [{ flag: 'parent', variant: 'on' }] }),
      });
      expect(evaluate(missing, 'child', true).value).toBe(false);
    });
  });

  describe('segments', () => {
    const segmented = (negate = false) =>
      boolFlag({
        fallthrough: { variant: 'off' },
        rules: [
          { id: 'beta', conditions: [{ segment: 'beta', negate }], serve: { variant: 'on' } },
        ],
      });
    const segments = {
      beta: {
        included: ['vip'],
        excluded: ['banned'],
        conditions: [{ attribute: 'email', op: 'endsWith' as const, values: ['@agora.dev'] }],
      },
    };

    it('honours excluded, then included, then conditions', () => {
      const ruleset = rs({ f: segmented() }, segments);
      expect(evaluate(ruleset, 'f', false, { targetingKey: 'vip' }).value).toBe(true);
      expect(
        evaluate(ruleset, 'f', false, { targetingKey: 'banned', email: 'x@agora.dev' }).value,
      ).toBe(false);
      expect(evaluate(ruleset, 'f', false, { targetingKey: 'u', email: 'x@agora.dev' }).value).toBe(
        true,
      );
      expect(evaluate(ruleset, 'f', false, { targetingKey: 'u', email: 'x@gmail.com' }).value).toBe(
        false,
      );
    });

    it('supports negation', () => {
      const ruleset = rs({ f: segmented(true) }, segments);
      expect(evaluate(ruleset, 'f', false, { targetingKey: 'u', email: 'x@gmail.com' }).value).toBe(
        true,
      );
    });
  });

  describe('operators', () => {
    const check = (
      op: string,
      actual: unknown,
      values: (string | number | boolean)[],
      negate = false,
    ) =>
      evaluate(
        rs({
          f: boolFlag({
            fallthrough: { variant: 'off' },
            rules: [
              {
                id: 'r',
                conditions: [{ attribute: 'a', op: op as never, values, negate }],
                serve: { variant: 'on' },
              },
            ],
          }),
        }),
        'f',
        false,
        actual === undefined ? {} : { a: actual },
      ).value;

    it('in / contains / startsWith / endsWith / matches', () => {
      expect(check('in', 'br', ['us', 'br'])).toBe(true);
      expect(check('in', 3, ['3'])).toBe(true);
      expect(check('in', ['editor', 'admin'], ['admin'])).toBe(true);
      expect(check('in', 'br', ['br'], true)).toBe(false);
      expect(check('contains', 'hello world', ['lo w'])).toBe(true);
      expect(check('startsWith', 'v2-beta', ['v2'])).toBe(true);
      expect(check('endsWith', 'a@b.com', ['.com'])).toBe(true);
      expect(check('matches', 'ab12', ['^ab\\d+$'])).toBe(true);
    });

    it('numeric and date comparisons', () => {
      expect(check('gt', 10, [5])).toBe(true);
      expect(check('gte', '5', [5])).toBe(true);
      expect(check('lt', 'abc', [5])).toBe(false);
      expect(check('before', '2026-01-01', ['2026-06-01'])).toBe(true);
      expect(check('after', new Date('2027-01-01'), ['2026-06-01T00:00:00Z'])).toBe(true);
    });

    it('semver comparisons', () => {
      expect(check('semverGte', '2.10.0', ['2.9.9'])).toBe(true);
      expect(check('semverLt', '1.0.0-rc.1', ['1.0.0'])).toBe(true);
      expect(check('semverEq', 'v1.2.3+build', ['1.2.3'])).toBe(true);
      expect(check('semverGt', 'not-a-version', ['1.0.0'])).toBe(false);
    });

    it('exists, and a missing attribute never matches', () => {
      expect(check('exists', 'x', [])).toBe(true);
      expect(check('exists', undefined, [])).toBe(false);
      expect(check('in', undefined, ['x'])).toBe(false);
    });
  });
});

describe('compareSemver', () => {
  it('orders prereleases per the spec', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareSemver(ordered[i]!, ordered[i + 1]!)).toBe(-1);
      expect(compareSemver(ordered[i + 1]!, ordered[i]!)).toBe(1);
    }
  });
});
