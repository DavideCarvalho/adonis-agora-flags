import { describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import {
  authkitSubject,
  defaultSubject,
  subjectFromIdentity,
} from '../../src/http/subject_resolver.js';
import { createTestFlags } from '../../src/testing/index.js';

const identity = {
  userId: 'sub-123',
  email: 'Ana@Agora.dev',
  globalRoles: ['ADMIN', 'BETA'],
  profile: { name: 'Ana' },
  orgId: 'org-9',
  orgSlug: 'acme',
  orgRole: 'owner',
};
const ctxWith = (extra: Record<string, unknown>) => extra as never;

describe('authkit integration', () => {
  it('turns an identity into a subject with verified claims as attributes', () => {
    expect(subjectFromIdentity(identity)).toEqual({
      id: 'sub-123',
      type: 'user',
      attributes: {
        email: 'Ana@Agora.dev',
        emailDomain: 'agora.dev',
        globalRoles: ['ADMIN', 'BETA'],
        orgId: 'org-9',
        orgSlug: 'acme',
        orgRole: 'owner',
      },
    });
  });

  it('prefers authkit over ctx.auth, and falls back to it', async () => {
    const authkit = { getIdentity: async () => identity };
    const auth = { user: { id: 7 } };
    expect(await defaultSubject(ctxWith({ authkit, auth }))).toMatchObject({ id: 'sub-123' });
    expect(
      await defaultSubject(ctxWith({ authkit: { getIdentity: async () => null }, auth })),
    ).toEqual({ id: 7 });
    expect(
      await defaultSubject(
        ctxWith({
          authkit: {
            getIdentity: async () => {
              throw new Error('bad cookie');
            },
          },
        }),
      ),
    ).toBeUndefined();
    expect(await authkitSubject(ctxWith({ auth }))).toBeUndefined();
  });

  it('targets on roles and organizations out of the box', async () => {
    const { manager } = createTestFlags({
      flags: { beta_ui: flag.boolean({ default: false }) },
      ruleset: {
        flags: {
          beta_ui: {
            variants: { on: true, off: false },
            enabled: true,
            offVariant: 'off',
            rules: [
              {
                id: 'beta',
                conditions: [{ attribute: 'globalRoles', op: 'in', values: ['BETA'] }],
                serve: { variant: 'on' },
              },
              {
                id: 'acme',
                conditions: [{ attribute: 'orgSlug', op: 'in', values: ['acme'] }],
                serve: { variant: 'on' },
              },
            ],
            fallthrough: { variant: 'off' },
          },
        },
      },
    });
    const scope = manager.forLazy(() =>
      defaultSubject(ctxWith({ authkit: { getIdentity: async () => identity } })),
    );
    expect(await scope.details('beta_ui')).toMatchObject({
      value: true,
      flagMetadata: { ruleId: 'beta' },
    });
    const other = manager.forLazy(() =>
      defaultSubject(
        ctxWith({ authkit: { getIdentity: async () => ({ ...identity, globalRoles: [] }) } }),
      ),
    );
    expect(await other.details('beta_ui')).toMatchObject({
      value: true,
      flagMetadata: { ruleId: 'acme' },
    });
  });
});
