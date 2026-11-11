import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, sinks } from '../../src/define_config.js';
import { ControlPlane } from '../../src/http/control_plane.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import type { MemorySink } from '../../src/sinks/sink.js';
import {
  signFlagsContext,
  type UserVerifier,
  userVerifiers,
  verifiers,
} from '../../src/topology/verify.js';
import { quietLogger, sqliteDb, type TestDb } from '../helpers.js';
import { type Handler, serve } from '../http_harness.js';

const SECRET = 'browser-secret';

async function controlPlane(db: TestDb, verifyUser: UserVerifier) {
  const runtime = await createRuntime(
    defineConfig({
      topology: 'control-plane',
      flags: { internal_flag: flag.boolean({ default: true }) },
      sinks: { mem: sinks.memory() },
      controlPlane: {
        verifyTenant: verifiers.sharedSecret({ shop: 'x' }),
        browser: { verifyUser, corsOrigins: ['https://app.example'] },
      },
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
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  new ControlPlane(runtime, (runtime.config as { controlPlane: never }).controlPlane).register({
    get: (pattern, handler) => {
      routes.push({ method: 'GET', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
    post: (pattern, handler) => {
      routes.push({ method: 'POST', pattern, handler: handler as Handler });
      return { as: () => {} };
    },
  });
  const server = await serve(routes);
  return {
    runtime,
    server,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/_flags`,
  };
}

describe('browser API', () => {
  let db: TestDb;
  let runtime: FlagsRuntime;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    db = await sqliteDb();
    ({ runtime, server, base } = await controlPlane(
      db,
      userVerifiers.signedContext({ secret: SECRET }),
    ));
  });

  afterEach(async () => {
    await runtime.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close();
  });

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

  it('serves only client flags, for the identity in the token', async () => {
    const token = signFlagsContext(
      { id: 'u1', attributes: { plan: 'pro' } },
      { secret: SECRET, app: 'web' },
    );
    const response = await evaluate(token);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.values).toEqual({ banner: 'snow', checkout: 'b' });
    expect(body.values).not.toHaveProperty('internal_flag');
    expect(body.experiments).toEqual(['checkout']);
    // Same ruleset and context: 304.
    const again = await evaluate(token, {}, { 'if-none-match': response.headers.get('etag')! });
    expect(again.status).toBe(304);
  });

  it('never lets browser attributes override the token', async () => {
    const free = signFlagsContext({ id: 'u2', attributes: { plan: 'free' } }, { secret: SECRET });
    const spoof = await evaluate(free, { attributes: { plan: 'pro', targetingKey: 'admin' } });
    expect((await spoof.json()).values.banner).toBe('off');
  });

  it('refuses missing, tampered and expired tokens', async () => {
    expect((await evaluate(undefined)).status).toBe(401);
    const token = signFlagsContext({ id: 'u1' }, { secret: SECRET });
    const [payload, signature] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ sub: 'admin', exp: 9e9 })).toString('base64url')}.${signature}`;
    expect((await evaluate(forged)).status).toBe(401);
    expect((await evaluate(`${payload}.x`)).status).toBe(401);
    expect(
      (await evaluate(signFlagsContext({ id: 'u1' }, { secret: SECRET, ttlSeconds: -10 }))).status,
    ).toBe(401);
    expect((await evaluate(signFlagsContext({ id: 'u1' }, { secret: 'other' }))).status).toBe(401);
  });

  it('records exposures re-evaluated on the server, and tracks', async () => {
    const token = signFlagsContext({ id: 'u3' }, { secret: SECRET, app: 'web' });
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
      app: 'web',
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

  it('answers CORS preflights only for allowed origins', async () => {
    const token = signFlagsContext({ id: 'u1' }, { secret: SECRET });
    const allowed = await evaluate(token, {}, { origin: 'https://app.example' });
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example');
    const other = await evaluate(token, {}, { origin: 'https://evil.example' });
    expect(other.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('streams ruleset changes over SSE with the token in the query string', async () => {
    const token = signFlagsContext({ id: 'u1' }, { secret: SECRET });
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/client/stream?token=${encodeURIComponent(token)}`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    const first = await reader.read();
    expect(first.value).toContain('event: ruleset');
    await runtime.admin!.setEnabled('banner', false, { id: 'alice' });
    await runtime.manager.refresh();
    const next = await reader.read();
    expect(next.value).toContain('event: ruleset');
    controller.abort();
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
