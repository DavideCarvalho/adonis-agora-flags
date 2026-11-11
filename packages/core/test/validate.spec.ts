import { describe, expect, it } from 'vitest';
import type { Ruleset } from '../src/ruleset.js';
import { validateRuleset } from '../src/validate.js';

describe('validateRuleset', () => {
  it('accepts a valid ruleset', () => {
    const ruleset: Ruleset = {
      schemaVersion: 1,
      version: '1',
      segments: { beta: { included: ['u1'] } },
      flags: {
        parent: {
          variants: { on: true, off: false },
          enabled: true,
          offVariant: 'off',
          fallthrough: { variant: 'on' },
        },
        child: {
          variants: { a: 'a', b: 'b' },
          enabled: true,
          offVariant: 'a',
          prerequisites: [{ flag: 'parent', variant: 'on' }],
          rules: [{ id: 'beta', conditions: [{ segment: 'beta' }], serve: { variant: 'b' } }],
          fallthrough: {
            split: [
              { variant: 'a', weight: 50 },
              { variant: 'b', weight: 50 },
            ],
          },
        },
      },
    };
    expect(validateRuleset(ruleset)).toEqual([]);
  });

  it('reports every problem with a path', () => {
    const ruleset: Ruleset = {
      schemaVersion: 9,
      version: '1',
      flags: {
        f: {
          variants: { on: true },
          enabled: true,
          offVariant: 'off',
          overrides: { qa: 'maybe' },
          rules: [
            {
              id: 'x',
              conditions: [{ attribute: 'a', op: 'nope' as never, values: [1] }],
              serve: { variant: 'on' },
            },
            {
              id: 'x',
              conditions: [{ segment: 'ghost' }, { attribute: 'r', op: 'matches', values: ['('] }],
              serve: { variant: 'on' },
            },
            {
              id: 'y',
              conditions: [{ attribute: 'a', op: 'in', values: [] }],
              serve: { variant: 'on' },
            },
          ],
          fallthrough: { split: [{ variant: 'on', weight: 0 }] },
          prerequisites: [{ flag: 'missing', variant: 'on' }],
        },
      },
    };
    const paths = validateRuleset(ruleset).map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'schemaVersion',
        'flags.f.offVariant',
        'flags.f.overrides.qa',
        'flags.f.rules[0].conditions[0].op',
        'flags.f.rules[1].id',
        'flags.f.rules[1].conditions[0]',
        'flags.f.rules[1].conditions[1].values',
        'flags.f.rules[2].conditions[0].values',
        'flags.f.fallthrough.split',
        'flags.f.prerequisites[0]',
      ]),
    );
  });

  it('reports a prerequisite cycle once', () => {
    const flag = (dep: string) => ({
      variants: { on: true, off: false },
      enabled: true,
      offVariant: 'off',
      fallthrough: { variant: 'on' },
      prerequisites: [{ flag: dep, variant: 'on' }],
    });
    const issues = validateRuleset({
      schemaVersion: 1,
      version: '1',
      flags: { a: flag('b'), b: flag('c'), c: flag('a') },
    });
    const cycles = issues.filter((issue) => issue.message.startsWith('prerequisite cycle'));
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.message).toBe('prerequisite cycle: a → b → c → a');
  });
});
