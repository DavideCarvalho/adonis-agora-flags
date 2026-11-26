import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { flag } from '../../src/declare.js';
import { defineConfig, stores, transports } from '../../src/define_config.js';
import {
  answerConsoleCommands,
  consoleCapabilityOf,
  consoleCommandKeys,
  FederatedFlagsConsole,
  flagsConsoleCommandHandler,
  parsePublicKey,
} from '../../src/federation/console.js';
import {
  type ConsoleCipher,
  type FlagsConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import type { TenantVerifier } from '../../src/topology/verify.js';
import { FakePubSubRedis } from '../fake_pubsub_redis.js';
import { quietLogger } from '../helpers.js';

/**
 * The console channel is authenticated: whoever can publish on Redis can neither send a command,
 * claim to be a viewer, nor forge an answer. One block per mode (shared secret, token, crypto).
 */

const PREFIX = 'shop';
const SECRET = 'federation-secret-0123456789';
const APP_KEY = 'app-key-of-the-shop-0123456789';
const COMMANDS = `${PREFIX}-flags-console`;
const REPLIES = `${PREFIX}-flags-console-reply`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** What the console sends when its `authorize` does not narrow: every console capability. */
const ALL = ['flags:console:read', 'flags:console:write', 'flags:console:approve'];

const setEnabled = (enabled: boolean, actor = { id: 'alice', name: 'Alice' }) => ({
  id: crypto.randomUUID(),
  verb: 'setEnabled',
  args: [{ params: { key: 'new_editor' }, body: { enabled } }],
  actor,
  capabilities: ALL,
});

const profile = () => ({
  id: crypto.randomUUID(),
  verb: 'profile',
  args: [],
  capabilities: ['flags:console:read'],
});

/** Everything published on the fake Redis, as one string (to assert a secret never crossed it). */
const wireOf = (redis: FakePubSubRedis) => redis.server.published.map((p) => p.message).join('\n');

let runtime: FlagsRuntime | undefined;
const channels: RedisConsoleChannel[] = [];

async function shop(extra: Record<string, unknown> = {}): Promise<FlagsRuntime> {
  runtime = await createRuntime(
    defineConfig({
      app: 'shop',
      flags: { new_editor: flag.boolean({ default: false }) },
      store: stores.memory({ production: { flags: {} } }),
      transport: transports.memory(),
      ...extra,
    } as never),
    lucidContext(undefined),
    { logger: quietLogger, runWorker: false },
  );
  return runtime;
}

const enabled = async () =>
  (await runtime!.store!.readRuleset('production')).flags.new_editor?.enabled;

/** A channel the test closes afterwards. */
function track<T extends RedisConsoleChannel>(channel: T): T {
  channels.push(channel);
  return channel;
}

afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close();
  await runtime?.close();
  runtime = undefined;
});

describe('a channel without authentication', () => {
  it('neither sends nor answers', async () => {
    const redis = new FakePubSubRedis();
    const channel = track(new RedisConsoleChannel({ client: redis, prefix: PREFIX }));
    expect(channel.signed).toBe(false);
    await expect(channel.answer(async () => null)).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(channel.send(setEnabled(true), { timeoutMs: 100 })).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    // answerConsoleCommands, as the provider calls it, refuses too.
    const app = await shop();
    await expect(
      answerConsoleCommands({ client: redis, prefix: PREFIX, actions: true, runtime: () => app }),
    ).rejects.toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('a token needs the app key or crypto on the console', () => {
    expect(
      () => new RedisConsoleChannel({ client: new FakePubSubRedis(), prefix: PREFIX, token: 't' }),
    ).toThrow(/recipient|crypto/);
  });
});

describe('shared-secret mode', () => {
  async function setup(options: { approvals?: boolean } = {}) {
    const redis = new FakePubSubRedis();
    const app = await shop(
      options.approvals ? { approvals: { environments: ['production'] } } : {},
    );
    const ran: FlagsConsoleCommand[] = [];
    const errors: unknown[] = [];
    const handler = flagsConsoleCommandHandler({ runtime: () => app, actions: true });
    const answering = track(
      new RedisConsoleChannel({
        client: redis.duplicate(),
        prefix: PREFIX,
        secret: SECRET,
        partition: 'shop',
      }),
    );
    await answering.answer(
      async (command) => {
        ran.push(command);
        return handler(command);
      },
      { onError: (error) => errors.push(error) },
    );
    const console = track(
      new RedisConsoleChannel({ client: redis.duplicate(), prefix: PREFIX, secret: SECRET }),
    );
    return { redis, app, ran, errors, console };
  }

  it('refuses unsigned, forged, tampered, stale and replayed commands, and runs a signed one', async () => {
    const { redis, ran, errors, console } = await setup();
    const raw = redis.duplicate();
    // Unsigned, then a made-up MAC.
    await raw.publish(COMMANDS, JSON.stringify(setEnabled(true)));
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...setEnabled(true), ts: Date.now(), mac: 'AAAA' }),
    );
    // Claims of a verified token are stripped/refused, never trusted.
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...setEnabled(true), verified: { partition: 'shop', capabilities: ['*'] } }),
    );
    await tick();
    expect(ran).toHaveLength(0);
    expect(errors.length).toBe(3);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
    expect(await enabled()).toBeUndefined();

    const reply = await console.send(setEnabled(true), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { status: 200 } });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ actor: { id: 'alice' } });
    expect(ran[0]).not.toHaveProperty('mac');
    expect(ran[0]?.verified).toBeUndefined();
    expect(await enabled()).toBe(true);

    // The same signed message again (a replay) does not run twice.
    const signed = redis.server.published.find(
      (p) => p.channel === COMMANDS && p.message.includes('"mac"') && !p.message.includes('AAAA'),
    )!;
    await raw.publish(COMMANDS, signed.message);
    await tick();
    expect(ran).toHaveLength(1);

    // A tampered copy (another actor, another id) fails the MAC.
    const tampered = {
      ...JSON.parse(signed.message),
      id: 'other-id',
      actor: { id: 'mallory' },
    };
    await raw.publish(COMMANDS, JSON.stringify(tampered));
    await tick();
    expect(ran).toHaveLength(1);
  });

  it('refuses a command signed over a minute ago', async () => {
    const { redis, ran, errors } = await setup();
    // A console whose clock is two minutes behind: what a captured, old command looks like.
    const old = track(
      new RedisConsoleChannel({ client: redis.duplicate(), prefix: PREFIX, secret: SECRET }),
    );
    const now = Date.now;
    Date.now = () => now() - 120_000;
    const pending = old.send(setEnabled(true), { timeoutMs: 300 });
    Date.now = now;
    await expect(pending).rejects.toThrow(/answered/);
    expect(ran).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('ignores a forged reply and waits for the signed one', async () => {
    const { redis, console } = await setup();
    const raw = redis.duplicate();
    // A rogue subscriber answers every command first.
    await raw.subscribe(COMMANDS);
    raw.on('message', (_channel, message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: { status: 299 } }));
    });
    const reply = await console.send(setEnabled(true), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { status: 200 } });
  });

  it('two forged actors cannot file and approve a change request', async () => {
    const { redis, app, ran } = await setup({ approvals: true });
    const raw = redis.duplicate();
    // An attacker on Redis files a change as "mallory" and approves it as "mallory-2".
    await raw.publish(COMMANDS, JSON.stringify(setEnabled(true, { id: 'mallory', name: 'M' })));
    await tick();
    expect(ran).toHaveLength(0);
    expect(await app.store!.listChangeRequests({ status: 'pending' })).toHaveLength(0);
    // The real console files one; a forged approval of it by another "person" is refused too.
    const filed = await (async () => {
      const console = track(
        new RedisConsoleChannel({ client: redis.duplicate(), prefix: PREFIX, secret: SECRET }),
      );
      return console.send(setEnabled(true), { timeoutMs: 2000 });
    })();
    expect(filed).toMatchObject({ ok: true, data: { status: 202 } });
    const [request] = await app.store!.listChangeRequests({ status: 'pending' });
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        id: crypto.randomUUID(),
        verb: 'approveChangeRequest',
        args: [{ params: { id: request!.id }, body: {} }],
        actor: { id: 'mallory-2' },
      }),
    );
    await tick();
    expect(await app.store!.listChangeRequests({ status: 'pending' })).toHaveLength(1);
    expect(await enabled()).toBeUndefined();
  });
});

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-admin') return { partition: 'shop', capabilities: ['flags:console:*'] };
  if (token === 'hub-writer') {
    return { partition: 'shop', capabilities: ['flags:console:read', 'flags:console:write'] };
  }
  if (token === 'hub-reader') return { partition: 'shop', capabilities: ['flags:console:read'] };
  if (token === 'hub-other-app') {
    return { partition: 'billing', capabilities: ['flags:console:*'] };
  }
  return null;
};

describe('token mode (authkit)', () => {
  async function setup() {
    const redis = new FakePubSubRedis();
    const app = await shop();
    const keys = consoleCommandKeys(APP_KEY, PREFIX);
    const ran: FlagsConsoleCommand[] = [];
    const errors: unknown[] = [];
    const handler = flagsConsoleCommandHandler({ runtime: () => app, actions: true });
    const answering = track(
      new RedisConsoleChannel({
        client: redis.duplicate(),
        prefix: PREFIX,
        keys,
        verifyTenant,
        partition: 'shop',
      }),
    );
    await answering.answer(
      async (command) => {
        ran.push(command);
        return handler(command);
      },
      { onError: (error) => errors.push(error) },
    );
    // What `node ace flags:console-key` prints, as the console's config holds it (a string).
    const publicKey = JSON.stringify(keys.publicKey);
    const consoleWith = (token: string, onInvalidate?: () => void) => {
      const key = parsePublicKey(publicKey);
      return track(
        new RedisConsoleChannel({
          client: redis.duplicate(),
          prefix: PREFIX,
          token: { get: async () => token, invalidate: () => onInvalidate?.() },
          recipient: async () => key,
        }),
      );
    };
    return { redis, app, keys, ran, errors, consoleWith };
  }

  it('runs a command whose token the app verifies, with neither token nor command on Redis', async () => {
    const { redis, ran, consoleWith } = await setup();
    const reply = await consoleWith('hub-writer').send(setEnabled(true), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { status: 200 } });
    expect(await enabled()).toBe(true);
    expect(ran[0]?.verified).toEqual({
      partition: 'shop',
      capabilities: ['flags:console:read', 'flags:console:write'],
    });
    expect(wireOf(redis)).not.toContain('hub-writer');
    expect(wireOf(redis)).not.toContain('new_editor');
    expect(wireOf(redis)).not.toContain('alice');
  });

  it('refuses an unknown token with 401, and the console drops its cached token', async () => {
    const { consoleWith } = await setup();
    let invalidated = 0;
    const reply = await consoleWith('stolen-or-made-up', () => {
      invalidated += 1;
    }).send(setEnabled(true), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(invalidated).toBe(1);
    expect(await enabled()).toBeUndefined();
  });

  it('lets the token decide the app and the capabilities, whatever the message claims', async () => {
    const { app, consoleWith } = await setup();
    // A token for another app cannot act on this one.
    const other = await consoleWith('hub-other-app').send(setEnabled(true), { timeoutMs: 2000 });
    expect(other).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!other.ok && other.error.message).toMatch(/token is for "billing"/);
    // A read-only token reads, but cannot change anything, even claiming every capability.
    const read = await consoleWith('hub-reader').send(profile(), { timeoutMs: 2000 });
    expect(read).toMatchObject({ ok: true, data: { app: 'shop' } });
    const reader = await consoleWith('hub-reader').send(
      { ...setEnabled(true), capabilities: ['*'] },
      { timeoutMs: 2000 },
    );
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!reader.ok && reader.error.message).toMatch(/lacks flags:console:write/);
    // A writer cannot approve change requests without flags:console:approve.
    const approve = await consoleWith('hub-writer').send(
      {
        id: crypto.randomUUID(),
        verb: 'approveChangeRequest',
        args: [{ params: { id: 'cr-1' } }],
        actor: { id: 'bob' },
        capabilities: ALL,
      },
      { timeoutMs: 2000 },
    );
    expect(approve).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!approve.ok && approve.error.message).toMatch(/lacks flags:console:approve/);
    // The viewer's capabilities the console sends only narrow the token's.
    const narrowed = await consoleWith('hub-admin').send(
      { ...setEnabled(true), capabilities: ['flags:console:read'] },
      { timeoutMs: 2000 },
    );
    expect(narrowed).toMatchObject({ ok: false, error: { status: 403 } });
    expect(await app.store!.readRuleset('production')).toMatchObject({ flags: {} });
  });

  it('refuses unsealed, tampered and replayed commands', async () => {
    const { redis, ran, errors, consoleWith } = await setup();
    const raw = redis.duplicate();
    // A plain command claiming a verified token.
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        ...setEnabled(true),
        capabilities: ['*'],
        verified: { partition: 'shop', capabilities: ['*'] },
      }),
    );
    await tick();
    expect(ran).toHaveLength(0);
    expect(errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });

    // A real command, then a copy under another id, a bit-flipped copy and a straight replay.
    await consoleWith('hub-writer').send(setEnabled(false), { timeoutMs: 2000 });
    expect(ran).toHaveLength(1);
    const sent = redis.server.published.find(
      (p) => p.channel === COMMANDS && p.message.includes('sealed'),
    )!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    await raw.publish(COMMANDS, JSON.stringify({ id: crypto.randomUUID(), sealed: wire.sealed }));
    await raw.publish(COMMANDS, JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish(COMMANDS, sent.message);
    await tick();
    expect(ran).toHaveLength(1);
  });

  it('ignores a forged answer and waits for the app', async () => {
    const { redis, consoleWith } = await setup();
    const raw = redis.duplicate();
    await raw.subscribe(COMMANDS);
    raw.on('message', (_channel, message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: { app: 'forged' } }));
    });
    const reply = await consoleWith('hub-reader').send(profile(), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { app: 'shop' } });
  });

  it('a federated console sends with the configured public key, end to end', async () => {
    const { redis, keys } = await setup();
    const federation = new FederatedFlagsConsole(
      {
        shop: {
          store: runtime!.store!,
          controlPlane: {
            prefix: PREFIX,
            token: 'hub-writer',
            publicKey: JSON.stringify(keys.publicKey),
          },
          timeoutMs: 2000,
        },
      },
      { db: async () => ({}) as never, redis: async () => redis.duplicate() },
    );
    try {
      const res = await federation.dispatch(
        'shop',
        'setEnabled',
        { actor: { id: 'ops-1' } },
        { params: { key: 'new_editor' }, query: {}, body: { enabled: true } },
      );
      expect(res.status).toBe(200);
      expect(await enabled()).toBe(true);
    } finally {
      await federation.close();
    }
  });

  it('maps each verb to the capability it needs', () => {
    expect(consoleCapabilityOf('profile')).toBe('flags:console:read');
    expect(consoleCapabilityOf('ops')).toBe('flags:console:read');
    expect(consoleCapabilityOf('setRollout')).toBe('flags:console:write');
    expect(consoleCapabilityOf('importRuleset')).toBe('flags:console:write');
    expect(consoleCapabilityOf('approveChangeRequest')).toBe('flags:console:approve');
    expect(consoleCapabilityOf('rejectChangeRequest')).toBe('flags:console:approve');
  });
});

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([['console-flags', randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key)!, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.keys.get(key)!, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

describe('crypto mode (@adonis-agora/crypto)', () => {
  async function setup(options: { verify?: boolean } = {}) {
    const redis = new FakePubSubRedis();
    const server = new FakeCryptoServer();
    const app = await shop();
    const errors: unknown[] = [];
    // The app: may only decrypt with the key (its crypto token: crypto:decrypt:console-flags).
    const answering = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: PREFIX,
      actions: true,
      runtime: () => app,
      crypto: { cipher: server.cipherFor({ decrypt: ['console-flags'] }) },
      ...(options.verify ? { verifyTenant } : {}),
      onError: (error) => errors.push(error),
    });
    track(answering);
    // The console: may only encrypt with it, resolved lazily.
    let resolved = 0;
    const console = (token?: string) =>
      track(
        new RedisConsoleChannel({
          client: redis.duplicate(),
          prefix: PREFIX,
          crypto: {
            // Lazy, like `() => crypto.client!` in config/flags.ts.
            cipher: () => {
              resolved += 1;
              return server.cipherFor({ encrypt: ['console-flags'] });
            },
          },
          ...(token !== undefined ? { token } : {}),
        }),
      );
    return { redis, server, app, errors, console, resolvedCount: () => resolved };
  }

  it('runs a command the console encrypted and the app decrypted, with nothing readable on Redis', async () => {
    const { redis, server, app, console, resolvedCount } = await setup();
    const channel = console();
    expect(resolvedCount()).toBe(0);
    const reply = await channel.send(setEnabled(true), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { status: 200 } });
    expect(resolvedCount()).toBe(1);
    expect(await enabled()).toBe(true);
    const [entry] = await app.store!.audit({ entity: 'flag', key: 'new_editor' });
    expect(entry).toMatchObject({ actor: { id: 'alice' } });
    expect(wireOf(redis)).not.toContain('new_editor');
    expect(wireOf(redis)).not.toContain('alice');
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { redis, server, errors } = await setup();
    const raw = redis.duplicate();
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await raw.publish(COMMANDS, JSON.stringify({ id: crypto.randomUUID(), sealed: ciphertext }));
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        id: crypto.randomUUID(),
        sealed: `agora:ct1:console-flags:1:${randomBytes(64).toString('base64url')}`,
      }),
    );
    await raw.publish(COMMANDS, JSON.stringify({ ...setEnabled(true), capabilities: ['*'] }));
    await tick();
    expect(await enabled()).toBeUndefined();
    expect(errors).toHaveLength(3);
    for (const error of errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { console } = await setup({ verify: true });
    const without = await console().send(setEnabled(true), { timeoutMs: 2000 });
    expect(without).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE } });
    expect(await enabled()).toBeUndefined();
    const reader = await console('hub-reader').send(setEnabled(true), { timeoutMs: 2000 });
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    const withToken = await console('hub-writer').send(setEnabled(true), { timeoutMs: 2000 });
    expect(withToken).toMatchObject({ ok: true });
    expect(await enabled()).toBe(true);
  });

  it('ignores a forged answer', async () => {
    const { redis, console } = await setup();
    const raw = redis.duplicate();
    await raw.subscribe(COMMANDS);
    raw.on('message', (_channel, message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: { app: 'forged' } }));
    });
    const reply = await console().send(profile(), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { app: 'shop' } });
  });

  it('says so when crypto is not ready yet', async () => {
    const channel = track(
      new RedisConsoleChannel({
        client: new FakePubSubRedis(),
        prefix: PREFIX,
        crypto: { cipher: () => undefined as never },
      }),
    );
    await expect(channel.send(setEnabled(true), { timeoutMs: 100 })).rejects.toThrow(
      /crypto\.cipher.*not ready/,
    );
  });
});
