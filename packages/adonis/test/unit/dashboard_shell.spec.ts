import { describe, expect, it } from 'vitest';
import { renderAccessDeniedPage } from '../../src/dashboard/access_denied_page.js';
import { defaultActor, toActor } from '../../src/dashboard/actor.js';
import {
  authorizeByToken,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';
import { resolveConfig } from '../../src/dashboard/define_config.js';
import { CONFIG_ELEMENT_ID, renderIndexHtml } from '../../src/dashboard/spa.js';

describe('dashboard config', () => {
  it('defaults to /flags and normalizes the path', () => {
    expect(resolveConfig()).toMatchObject({ enabled: true, path: '/flags', authorize: null });
    expect(resolveConfig({ path: 'ops/flags/' }).path).toBe('/ops/flags');
    expect(resolveConfig({ path: '/' }).path).toBe('');
  });
});

describe('index.html injection', () => {
  const html =
    '<html><head><script type="module" src="/__FLAGS_DASHBOARD__/assets/app.js"></script></head></html>';

  it('rewrites the base and hands the config over as a JSON data block, never an inline script', () => {
    const out = renderIndexHtml(html, '/ops/flags', '/ops/flags/api', 'staging');
    expect(out).toContain('src="/ops/flags/assets/app.js"');
    expect(out).toContain(
      `<script type="application/json" id="${CONFIG_ELEMENT_ID}">{"base":"/ops/flags","api":"/ops/flags/api","environment":"staging"}</script></head>`,
    );
  });

  it('cannot be closed early by a config value', () => {
    const out = renderIndexHtml(html, '/x', '/x/api', '</script><script>alert(1)</script>');
    expect(out).not.toContain('</script><script>alert(1)');
    expect(out).toContain('\\u003c/script>');
  });
});

describe('authorize contract', () => {
  it('fails closed: only true or { allowed: true } passes', () => {
    expect(normalizeConsoleAuthorizeResult(true)).toEqual({ allowed: true });
    expect(normalizeConsoleAuthorizeResult({ allowed: false })).toMatchObject({ status: 403 });
    expect(normalizeConsoleAuthorizeResult(undefined)).toMatchObject({ status: 403 });
    expect(
      normalizeConsoleAuthorizeResult({ allowed: false, reason: 'unauthenticated' }),
    ).toMatchObject({
      status: 401,
    });
    expect(normalizeConsoleAuthorizeResult({ redirectTo: '/login' })).toMatchObject({
      status: 302,
    });
  });

  it('accepts any (ctx) => boolean | Promise<boolean>, as authkitDashboardAuthorize returns', async () => {
    const guard = resolveConsoleAuthorize(async (ctx) => (ctx as unknown as { ok: boolean }).ok);
    expect(await guard({ ok: true } as never)).toEqual({ allowed: true });
    expect(await guard({ ok: false } as never)).toMatchObject({ allowed: false, status: 403 });
    const throwing = resolveConsoleAuthorize(() => {
      throw new Error('boom');
    });
    expect(await throwing({} as never)).toMatchObject({ allowed: false, status: 403 });
  });

  it('authorizes machine callers by bearer token', () => {
    const check = authorizeByToken({ token: 's3cret' }) as (ctx: never) => unknown;
    const ctx = (header?: string) => ({ request: { header: () => header } }) as never;
    expect(check(ctx('Bearer s3cret'))).toEqual({ allowed: true });
    expect(check(ctx('Bearer nope'))).toMatchObject({ allowed: false, reason: 'unauthenticated' });
    expect(() => authorizeByToken({ token: '' })).toThrow(/non-empty/);
  });
});

describe('access-denied page', () => {
  it('is branded for flags and carries no script', () => {
    const page = renderAccessDeniedPage({ status: 403, reason: 'forbidden', basePath: '/flags' });
    expect(page).toContain('@adonis-agora/flags');
    expect(page).toContain('Access denied');
    expect(page).not.toContain('<script');
  });
});

describe('acting user', () => {
  it('reads ctx.auth.user, falling back to "dashboard"', () => {
    expect(defaultActor({ auth: { user: { id: 7, email: 'a@x.com' } } })).toEqual({
      id: '7',
      name: 'a@x.com',
    });
    expect(defaultActor({ auth: { user: { id: 'u_1' } } })).toEqual({ id: 'u_1' });
    expect(defaultActor({})).toEqual({ id: 'dashboard', anonymous: true });
    expect(defaultActor(undefined)).toEqual({ id: 'dashboard', anonymous: true });
  });

  it('normalizes a configured resolver result', () => {
    expect(toActor('sub_1')).toEqual({ id: 'sub_1' });
    expect(toActor({ id: 'sub_1', name: 'Ana' })).toEqual({ id: 'sub_1', name: 'Ana' });
    expect(toActor(null)).toEqual({ id: 'dashboard', anonymous: true });
  });
});
