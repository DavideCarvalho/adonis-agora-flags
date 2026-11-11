import { Edge } from 'edge.js';
import { describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { flagTag } from '../../src/http/edge_tag.js';
import { createTestFlags } from '../../src/testing/index.js';

describe('@flag Edge tag', () => {
  const { manager } = createTestFlags({
    flags: {
      new_player: flag.boolean({ default: false }),
      checkout: flag.string({ default: 'control', variants: ['control', 'one_page'] }),
    },
    ruleset: {
      flags: {
        new_player: {
          variants: { on: true, off: false },
          enabled: true,
          offVariant: 'off',
          fallthrough: { variant: 'on' },
        },
        checkout: {
          variants: { control: 'control', one_page: 'one_page' },
          enabled: true,
          offVariant: 'control',
          fallthrough: { variant: 'one_page' },
        },
      },
    },
  });

  const render = async (template: string) => {
    const edge = new Edge();
    edge.registerTag(flagTag as never);
    return (await edge.renderRaw(template, { flags: manager.for('u1') })).trim();
  };

  it('renders the block for an enabled boolean flag, and @else otherwise', async () => {
    expect(await render("@flag('new_player')\nnew\n@else\nold\n@end")).toBe('new');
  });

  it('matches multivariate flags by variant', async () => {
    expect(await render("@flag('checkout', 'one_page')\nyes\n@else\nno\n@end")).toBe('yes');
    expect(await render("@flag('checkout', 'control')\nyes\n@else\nno\n@end")).toBe('no');
  });

  it('serves the else branch for an unknown flag', async () => {
    expect(await render("@flag('ghost')\nyes\n@else\nno\n@end")).toBe('no');
  });
});
