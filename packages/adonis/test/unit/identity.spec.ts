import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import { type FlagsIdentityProvider, identities, subjectResolver } from '../../src/identity.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';

const ctx = (extra: Record<string, unknown>) => extra as never;

/** A stand-in for `ctx.auth` with two guards. */
function auth(users: { web?: Record<string, unknown>; api?: Record<string, unknown> }) {
  const guard = (user?: Record<string, unknown>) => ({
    user: undefined as Record<string, unknown> | undefined,
    async check() {
      this.user = user;
      return user !== undefined;
    },
  });
  const web = guard(users.web);
  const api = guard(users.api);
  return {
    get user() {
      return web.user;
    },
    check: () => web.check(),
    use: (name: string) => (name === 'api' ? api : web),
  };
}

describe('identities.adonisAuth', () => {
  const admin = { id: 1, email: 'ana@acme.dev', fullName: 'Ana', isAdmin: true };
  const customer = { id: 2, email: 'bob@acme.dev', isAdmin: false };
  const provider = identities.adonisAuth<typeof admin>({
    loginPath: '/login',
    canOpenConsole: (user) => user.isAdmin,
  });

  it('checks the session silently and uses the user as subject and actor', async () => {
    expect(await provider.subject(ctx({ auth: auth({ web: admin }) }))).toEqual({
      id: 1,
      type: 'user',
    });
    expect(await provider.actor!(ctx({ auth: auth({ web: admin }) }))).toEqual({
      id: '1',
      name: 'Ana',
    });
    expect(await provider.subject(ctx({ auth: auth({}) }))).toBeUndefined();
    expect(await provider.subject(ctx({}))).toBeUndefined();
  });

  it('reads the guard it is told to', async () => {
    const api = identities.adonisAuth({ guard: 'api' });
    expect(await api.subject(ctx({ auth: auth({ web: admin, api: customer }) }))).toMatchObject({
      id: 2,
    });
  });

  it('gates the console: login redirect, then the app rule', async () => {
    expect(await provider.authorizeConsole!(ctx({ auth: auth({}) }))).toEqual({
      redirectTo: '/login',
    });
    expect(await provider.authorizeConsole!(ctx({ auth: auth({ web: customer }) }))).toBe(false);
    expect(await provider.authorizeConsole!(ctx({ auth: auth({ web: admin }) }))).toBe(true);
  });

  it('leaves the console to its defaults without canOpenConsole', () => {
    expect(identities.adonisAuth().authorizeConsole).toBeUndefined();
  });
});

describe('identities.authkit', () => {
  const session = (globalRoles: string[]) => ({
    authkit: {
      getIdentity: async () => ({ userId: 'sub-1', email: 'ana@acme.dev', globalRoles }),
    },
  });

  it('needs the console role', async () => {
    const provider = identities.authkit();
    expect(await provider.authorizeConsole!(ctx(session(['ADMIN'])))).toBe(true);
    expect(await provider.authorizeConsole!(ctx(session(['BETA'])))).toBe(false);
    expect(
      await provider.authorizeConsole!(ctx({ authkit: { getIdentity: async () => null } })),
    ).toEqual({ allowed: false, reason: 'unauthenticated' });
    expect(
      await identities.authkit({ consoleRole: 'FLAGS' }).authorizeConsole!(ctx(session(['FLAGS']))),
    ).toBe(true);
  });

  it('uses the identity as subject and actor', async () => {
    const provider = identities.authkit();
    expect(await provider.subject(ctx(session([])))).toMatchObject({
      id: 'sub-1',
      attributes: { emailDomain: 'acme.dev' },
    });
    expect(await provider.actor!(ctx(session([])))).toEqual({ id: 'sub-1', name: 'ana@acme.dev' });
  });
});

describe('a custom provider', () => {
  let db: TestDb | undefined;
  let runtime: FlagsRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    await db?.close();
  });

  it('decides the subject, unless config.subject is set', async () => {
    const identity: FlagsIdentityProvider = { subject: () => ({ id: 'from-provider' }) };
    expect(await subjectResolver({ identity })(ctx({}))).toEqual({ id: 'from-provider' });
    expect(await subjectResolver({ identity, subject: () => 'explicit' })(ctx({}))).toBe(
      'explicit',
    );
    expect(await subjectResolver({})(ctx({ auth: { user: { id: 3 } } }))).toEqual({ id: 3 });
  });

  it('decides who may change what, for the console and commands alike', async () => {
    db = await sqliteDb();
    const calls: string[] = [];
    runtime = await createRuntime(
      defineConfig({
        flags: {},
        identity: {
          subject: () => undefined,
          can: (actor, action, { environment }) => {
            calls.push(`${actor.id}:${action}:${environment}`);
            return actor.id === 'ana';
          },
        },
      }),
      lucidContext(db.database as never),
      { logger: quietLogger },
    );
    await runtime.admin!.createFlag('banner', { type: 'boolean', default: false }, { id: 'ana' });
    await expect(runtime.admin!.setEnabled('banner', false, { id: 'cli:bob' })).rejects.toThrow();
    expect(calls).toEqual(['ana:write:production', 'cli:bob:write:production']);
  });
});

describe('flagsCsrfExceptions', () => {
  it('skips the token-authenticated APIs only', async () => {
    const { flagsCsrfExceptions } = await import('../../src/http/csrf.js');
    expect(flagsCsrfExceptions('/_flags/v1/client/evaluate')).toBe(true);
    expect(flagsCsrfExceptions('/_flags/v1/events?x=1')).toBe(true);
    expect(flagsCsrfExceptions('/ofrep/v1/evaluate/flags')).toBe(true);
    expect(flagsCsrfExceptions('/api/flags/v1/events', { prefix: '/api/flags' })).toBe(true);
    // Session-cookie routes stay protected.
    expect(flagsCsrfExceptions('/_flags/token')).toBe(false);
    expect(flagsCsrfExceptions('/flags/api/flags/x/enabled')).toBe(false);
    expect(flagsCsrfExceptions('/login')).toBe(false);
  });
});
