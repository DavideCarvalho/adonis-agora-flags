import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HttpContext } from '@adonisjs/core/http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { registerBrowser } from '../../src/http/browser.js';
import { BrowserTokens } from '../../src/http/browser_tokens.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import type { MemorySink } from '../../src/sinks/sink.js';
import {
  browserKey,
  localKeySource,
  signBrowserToken,
  verifyBrowserToken,
} from '../../src/topology/browser_token.js';
import { userVerifiers, verifiers } from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';

const SECRET = 'browser-secret';

/** Who is signed in, for the tests: `x-user` / `x-plan` headers stand in for a session. */
const subject = (ctx: HttpContext) => {
  const id = ctx.request.header('x-user');
  return id ? { id, attributes: { plan: ctx.request.header('x-plan') } } : undefined;
};

function collect() {
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  const router = {
    get: (pattern: string, handler: unknown) => {
      routes.push({ method: 'GET', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
    post: (pattern: string, handler: unknown) => {
      routes.push({ method: 'POST', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
  };
  return { routes, router };
}

const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function controlPlane(db: TestDb) {
  const runtime = await createRuntime(
    defineConfig({
      topology: 'control-plane',
      flags: { internal_flag: flag.boolean({ default: true }) },
      sinks: { mem: sinks.memory() },
      subject,
      attributes: async () => ({ country: 'BR' }),
      controlPlane: { verifyTenant: verifiers.sharedSecret({ shop: 's3cret' }) },
      browser: { secret: SECRET, corsOrigins: ['https://app.example'] },
    }),
    lucidContext(db.database as never),
    { logger: quietLogger },
  );
  const admin = { id: 'alice' };
  await runtime.admin!.createFlag(
    'banner',
    { type: 'string', default: 'off', variants: ['off', 'snow'], client: true },
    admin,
  );
  await runtime.admin!.createFlag(
    'checkout',
    { type: 'string', default: 'control', variants: ['control', 'b'], client: true },
    admin,
  );
  await runtime.admin!.saveFlag(
    'checkout',
    {
      variants: { control: 'control', b: 'b' },
      enabled: true,
      offVariant: 'control',
      fallthrough: { split: [{ variant: 'b', weight: 1 }] },
      experiment: {},
    },
    admin,
  );
  await runtime.admin!.saveFlag(
    'banner',
    {
      variants: { off: 'off', snow: 'snow' },
      enabled: true,
      offVariant: 'off',
      rules: [
        {
          id: 'pro',
          conditions: [{ attribute: 'plan', op: 'in', values: ['pro'] }],
          serve: { variant: 'snow' },
        },
      ],
      fallthrough: { variant: 'off' },
    },
    admin,
  );
  await runtime.manager.refresh();
  const { routes, router } = collect();
  const plane = new ControlPlane(
    runtime,
    (runtime.config as { controlPlane: never }).controlPlane,
    SECRET,
  );
  plane.register(router);
  registerBrowser(router, runtime, { secret: SECRET, controlPlane: plane });
  const server = await serve(routes);
  return { runtime, server, origin: urlOf(server) };
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

describe('browser API', () => {
  let db: TestDb;
  let runtime: FlagsRuntime;
  let server: Server;
  let origin: string;
  let base: string;

  beforeEach(async () => {
    db = await sqliteDb();
    ({ runtime, server, origin } = await controlPlane(db));
    base = `${origin}/_flags`;
  });

  afterEach(async () => {
    await runtime.close();
    await close(server);
    await db.close();
  });

  const tokenFor = async (user?: string, plan?: string, at = origin) => {
    const response = await fetch(`${at}/_flags/token`, {
      headers: { ...(user ? { 'x-user': user } : {}), ...(plan ? { 'x-plan': plan } : {}) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    return (await response.json()) as { token: string; expiresAt: number; url: string };
  };

  const evaluate = (
    token: string | undefined,
    body: unknown = {},
    headers: Record<string, string> = {},
  ) =>
    fetch(`${base}/v1/client/evaluate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });

  it('issues a token for the session subject, with server attributes signed in', async () => {
    const issued = await tokenFor('u1', 'pro');
    expect(issued.url).toBe('/_flags');
    expect(issued.expiresAt).toBeGreaterThan(Date.now() + 200_000);
    const payload = JSON.parse(Buffer.from(issued.token.split('.')[1]!, 'base64url').toString());
    expect(payload).toMatchObject({ sub: 'u1', attrs: { plan: 'pro', country: 'BR' } });
  });

  it('serves only client flags, for the identity in the token', async () => {
    const { token } = await tokenFor('u1', 'pro');
    const response = await evaluate(token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.values).toEqual({ banner: 'snow', checkout: 'b' });
    expect(body.values).not.toHaveProperty('internal_flag');
    expect(body.experiments).toEqual(['checkout']);
    const again = await evaluate(token, {}, { 'if-none-match': response.headers.get('etag')! });
    expect(again.status).toBe(304);
  });

  it('serves anonymous visitors static values, and records nothing for them', async () => {
    const { token } = await tokenFor();
    expect((await (await evaluate(token)).json()).values).toEqual({
      banner: 'off',
      checkout: 'control',
    });
    const events = await fetch(`${base}/v1/client/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ events: [{ type: 'track', name: 'x' }] }),
    });
    expect(await events.json()).toEqual({ accepted: 0 });
  });

  it('never lets browser attributes override the token', async () => {
    const { token } = await tokenFor('u2', 'free');
    const spoof = await evaluate(token, { attributes: { plan: 'pro', targetingKey: 'admin' } });
    expect((await spoof.json()).values.banner).toBe('off');
  });

  it('refuses missing, tampered, moved, expired and foreign tokens', async () => {
    expect((await evaluate(undefined)).status).toBe(401);
    const { token } = await tokenFor('u1');
    const [version, payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    const reencode = (changes: Record<string, unknown>) =>
      `${version}.${Buffer.from(JSON.stringify({ ...decoded, ...changes })).toString('base64url')}.${signature}`;
    expect((await evaluate(reencode({ sub: 'admin' }))).status).toBe(401);
    // Same signature, another app or environment: a different key.
    expect((await evaluate(reencode({ app: 'billing' }))).status).toBe(401);
    expect((await evaluate(reencode({ env: 'staging' }))).status).toBe(401);
    const key = browserKey(SECRET, 'app', 'production');
    const expired = signBrowserToken(
      { id: 'u1' },
      { key, app: 'app', environment: 'production', ttlSeconds: -10 },
    );
    expect((await evaluate(expired.token)).status).toBe(401);
    const foreign = signBrowserToken(
      { id: 'u1' },
      { key: browserKey('other', 'app', 'production'), app: 'app', environment: 'production' },
    );
    expect((await evaluate(foreign.token)).status).toBe(401);
  });

  it('records exposures re-evaluated on the server, and tracks', async () => {
    const { token } = await tokenFor('u3');
    const response = await fetch(`${base}/v1/client/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        events: [
          { type: 'exposure', flag: 'checkout', variant: 'control' },
          { type: 'exposure', flag: 'internal_flag' },
          { type: 'track', name: 'purchase', value: 30 },
        ],
      }),
    });
    expect(await response.json()).toEqual({ accepted: 2 });
    await runtime.relay!.drain('mem');
    const events = (runtime.sinks.get('mem') as MemorySink).events;
    expect(events.find((e) => e.type === 'exposure')).toMatchObject({
      app: 'app',
      subject: 'u3',
      experiment: 'checkout',
      // The server's answer, not the one the browser claimed.
      variant: 'b',
    });
    expect(events.find((e) => e.type === 'track')).toMatchObject({
      name: 'purchase',
      value: 30,
      subject: 'u3',
    });
  });

  it('answers CORS only for allowed origins', async () => {
    const { token } = await tokenFor('u1');
    const allowed = await evaluate(token, {}, { origin: 'https://app.example' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    const other = await evaluate(token, {}, { origin: 'https://evil.example' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('streams ruleset changes over SSE with the token in the query string', async () => {
    const { token } = await tokenFor('u1');
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/client/stream?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    expect((await reader.read()).value).toContain('event: ruleset');
    await runtime.admin!.setEnabled('banner', false, { id: 'alice' });
    await runtime.manager.refresh();
    expect((await reader.read()).value).toContain('event: ruleset');
    controller.abort();
  });

  describe('from a tenant app', () => {
    let tenant: FlagsRuntime;
    let tenantServer: Server;

    beforeEach(async () => {
      tenant = await createRuntime(
        defineConfig({
          topology: 'tenant',
          flags: {},
          subject,
          tenant: { url: base, token: 's3cret', partition: 'shop', stream: false },
          browser: {},
        }),
        lucidContext(db.database as never),
        { logger: quietLogger },
      );
      const { routes, router } = collect();
      registerBrowser(router, tenant, {});
      tenantServer = await serve(routes);
    });

    afterEach(async () => {
      await tenant.close();
      await close(tenantServer);
    });

    it('signs with a key fetched from the control-plane, for its own app only', async () => {
      const issued = await tokenFor('u5', 'pro', urlOf(tenantServer));
      // The browser goes straight to the control-plane.
      expect(issued.url).toBe(base);
      const response = await evaluate(issued.token);
      expect((await response.json()).values.banner).toBe('snow');
      await fetch(`${base}/v1/client/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${issued.token}` },
        body: JSON.stringify({ events: [{ type: 'track', name: 'signup' }] }),
      });
      await runtime.relay!.drain('mem');
      const events = (runtime.sinks.get('mem') as MemorySink).events;
      expect(events.find((e) => e.type === 'track')).toMatchObject({ app: 'shop', subject: 'u5' });
    });

    it('gives keys only to authenticated tenants', async () => {
      const unauthenticated = await fetch(`${base}/v1/browser-key`, { method: 'POST' });
      expect(unauthenticated.status).toBe(401);
      const wrong = await fetch(`${base}/v1/browser-key`, {
        method: 'POST',
        headers: { authorization: 'Bearer nope', 'x-flags-tenant': 'shop' },
      });
      expect(wrong.status).toBe(401);
    });
  });
});

describe('token endpoint subjects (no subject resolver configured)', () => {
  let db: TestDb;
  let runtime: FlagsRuntime;
  let tokens: BrowserTokens;

  beforeEach(async () => {
    db = await sqliteDb();
    runtime = await createRuntime(
      defineConfig({
        flags: {},
        // Server-side attributes, read from your own data.
        attributes: async (subject) => ({ plan: subject.id === 7 ? 'pro' : 'free' }),
        browser: {},
      }),
      lucidContext(db.database as never),
      { logger: quietLogger },
    );
    tokens = new BrowserTokens(runtime, localKeySource(SECRET, 'app', 'production'), '/_flags', {});
  });

  afterEach(async () => {
    await runtime.close();
    await db.close();
  });

  const issueFor = async (ctx: Record<string, unknown>) => {
    const { token } = await tokens.issue({ request: { header: () => undefined }, ...ctx } as never);
    return verifyBrowserToken(token, SECRET);
  };

  it('uses ctx.auth.user from @adonisjs/auth when authkit is not installed', async () => {
    const verified = await issueFor({ auth: { user: { id: 7, email: 'a@b.c' } } });
    expect(verified?.subject).toEqual({ id: '7', attributes: { plan: 'pro' } });
  });

  it('checks the session silently when no auth middleware ran', async () => {
    const auth = {
      user: undefined as { id: number } | undefined,
      async check() {
        auth.user = { id: 9 };
        return true;
      },
    };
    expect((await issueFor({ auth }))?.subject?.id).toBe('9');
  });

  it('uses the authkit identity when authkit-client is installed', async () => {
    const verified = await issueFor({
      authkit: {
        getIdentity: async () => ({
          userId: 'sub-1',
          email: 'bia@acme.dev',
          globalRoles: ['BETA'],
          orgSlug: 'acme',
        }),
      },
      auth: { user: { id: 7 } },
    });
    expect(verified?.subject).toMatchObject({
      id: 'sub-1',
      type: 'user',
      attributes: { email: 'bia@acme.dev', globalRoles: ['BETA'], orgSlug: 'acme', plan: 'free' },
    });
  });

  it('issues an anonymous token when nobody is signed in', async () => {
    const verified = await issueFor({});
    expect(verified).not.toBeNull();
    expect(verified?.subject).toBeUndefined();
  });
});

describe('authkit user tokens', () => {
  let jwks: Server;
  let issuer: string;
  let sign: (claims: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    jwks = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
    issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
    sign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'at+jwt' })
        .setIssuer(issuer)
        .setAudience('flags')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  afterEach(async () => {
    jwks.closeAllConnections();
    await new Promise((resolve) => jwks.close(resolve));
  });

  it('verifies against the JWKS and maps sub, email, roles and org to the subject', async () => {
    const verify = userVerifiers.authkit({
      issuer,
      jwksUri: `${issuer}/jwks`,
      audience: 'flags',
      environments: { 'web-app': 'staging' },
    });
    const token = await sign({
      sub: 'user-42',
      client_id: 'web-app',
      email: 'Bia@Agora.dev',
      roles: ['BETA'],
      org_id: 'org-1',
      org_slug: 'acme',
    });
    expect(await verify({ token })).toMatchObject({
      subject: {
        id: 'user-42',
        attributes: {
          email: 'Bia@Agora.dev',
          emailDomain: 'agora.dev',
          globalRoles: ['BETA'],
          orgId: 'org-1',
          orgSlug: 'acme',
        },
      },
      environment: 'staging',
      app: 'web-app',
    });
    expect(await verify({ token: `${token}x` })).toBeNull();
    expect(await verify({ token: undefined })).toBeNull();
  });
});
