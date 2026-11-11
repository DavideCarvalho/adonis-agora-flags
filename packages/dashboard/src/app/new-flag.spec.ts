import { describe, expect, it } from 'vitest';
import { EMPTY_NEW_FLAG, toDeclaration } from './new-flag';

describe('toDeclaration', () => {
  it('parses each type', () => {
    expect(
      toDeclaration({ ...EMPTY_NEW_FLAG, key: 'dark', defaultValue: 'true', client: true }),
    ).toEqual({
      ok: true,
      key: 'dark',
      declaration: { type: 'boolean', default: true, client: true },
    });
    expect(
      toDeclaration({ ...EMPTY_NEW_FLAG, key: 'limit', type: 'number', defaultValue: '25' }),
    ).toMatchObject({
      declaration: { type: 'number', default: 25 },
    });
    expect(
      toDeclaration({
        ...EMPTY_NEW_FLAG,
        key: 'promo',
        type: 'string',
        defaultValue: 'off',
        variants: 'off, blue ,red',
        tags: 'growth',
      }),
    ).toMatchObject({ declaration: { variants: ['off', 'blue', 'red'], tags: ['growth'] } });
    expect(
      toDeclaration({ ...EMPTY_NEW_FLAG, key: 'cfg', type: 'json', defaultValue: '{"a":1}' }),
    ).toMatchObject({
      declaration: { default: { a: 1 } },
    });
  });

  it('explains what is wrong', () => {
    expect(toDeclaration({ ...EMPTY_NEW_FLAG, key: 'bad key' })).toMatchObject({ ok: false });
    expect(toDeclaration({ ...EMPTY_NEW_FLAG, key: 'b', defaultValue: 'yes' })).toMatchObject({
      error: /true or false/,
    });
    expect(
      toDeclaration({ ...EMPTY_NEW_FLAG, key: 'n', type: 'number', defaultValue: 'x' }),
    ).toMatchObject({ error: /number/ });
    expect(
      toDeclaration({ ...EMPTY_NEW_FLAG, key: 'j', type: 'json', defaultValue: '{' }),
    ).toMatchObject({ error: /JSON/ });
    expect(
      toDeclaration({
        ...EMPTY_NEW_FLAG,
        key: 's',
        type: 'string',
        defaultValue: 'green',
        variants: 'off,blue',
      }),
    ).toMatchObject({ error: /one of the variants/ });
  });
});
