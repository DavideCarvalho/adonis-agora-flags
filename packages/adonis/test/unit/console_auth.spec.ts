import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anyAuthorize,
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';
import { defineConfig as defineDashboardConfig } from '../../src/dashboard/define_config.js';
import { flag } from '../../src/declare.js';
import { defineConfig, stores, transports } from '../../src/define_config.js';
import { agoraDoctorChecks } from '../../src/doctor/index.js';
import {
  answerConsoleCommands,
  consoleCommandKeys,
  FederatedFlagsConsole,
  flagsConsoleCapabilityAllows,
  flagsConsoleCommandHandler,
  viewerConsoleCapabilities,
} from '../../src/federation/console.js';
import {
  type AuthkitClientLike,
  ConsoleAuthConfigError,
  type CryptoPrincipalLike,
  type CryptoRuntimeLike,
  checkTenantConsoleKey,
  embeddedKeyGuard,
  optionalAppCallToken,
  requiredAppCallToken,
  resolveAppConsoleAuth,
  resolveConsoleSideAuth,
  watchTenantConsoleKey,
} from '../../src/federation/console_auth.js';
import {
  cryptoConsoleSealer,
  type FlagsConsoleCommand,
  RedisConsoleChannel,
} from '../../src/federation/redis_channel.js';
import { createRuntime, type FlagsRuntime, lucidContext } from '../../src/runtime.js';
import { FakePubSubRedis } from '../fake_pubsub_redis.js';
import { quietLogger } from '../helpers.js';

/**
 * The uniform console authentication: nothing to configure when @adonis-agora/crypto (and
 * authkit) are booted next to flags, explicit options win, and a console or app that cannot
 * authenticate fails its boot. Crypto and authkit are fakes bound under their container names.
 */

const ALL = ['flags:console:read', 'flags:console:write', 'flags:console:approve'];
const READ = ['flags:console:read'];

/** A stand-in for @adonis-agora/crypto's service: keys per partition, capabilities checked. */
class FakeCryptoService {
  readonly keys = new Map<string, Buffer>();
  readonly created: Array<{ partition: string; name: string; actor: string }> = [];
  readonly calls: Array<{ op: string; partition: string; key: string }> = [];

  #allows(principal: CryptoPrincipalLike, capability: string) {
    const grants = (c: string) =>
      c === capability || c === '*' || (c.endsWith('*') && capability.startsWith(c.slice(0, -1)));
    if (!principal.capabilities.some(grants)) {
      throw Object.assign(new Error(`forbidden: needs ${capability}`), { code: 'forbidden' });
    }
  }

  store = {
    getKey: async (partition: string, name: string) =>
      this.keys.has(`${partition}/${name}`) ? { partition, name } : null,
  };

  async createKey(principal: CryptoPrincipalLike, input: { name: string; type: string }) {
    this.#allows(principal, `crypto:keys:manage:${input.name}`);
    const id = `${principal.partition}/${input.name}`;
    if (this.keys.has(id)) throw Object.assign(new Error('exists'), { code: 'conflict' });
    this.keys.set(id, randomBytes(32));
    this.created.push({ partition: principal.partition, name: input.name, actor: principal.actor });
    return { name: input.name };
  }

  async encrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; plaintext: string; aad?: string },
  ) {
    this.#allows(principal, `crypto:encrypt:${input.key}`);
    const material = this.keys.get(`${principal.partition}/${input.key}`);
    if (!material) throw Object.assign(new Error('no such key'), { code: 'not_found' });
    this.calls.push({ op: 'encrypt', partition: principal.partition, key: input.key });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', material, iv);
    cipher.setAAD(Buffer.from(input.aad ?? ''));
    const body = Buffer.concat([cipher.update(input.plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: `agora:ct1:${input.key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
    };
  }

  async decrypt(
    principal: CryptoPrincipalLike,
    input: { key: string; ciphertext: string; aad?: string },
  ) {
    this.#allows(principal, `crypto:decrypt:${input.key}`);
    const material = this.keys.get(`${principal.partition}/${input.key}`);
    if (!material) throw Object.assign(new Error('no such key'), { code: 'not_found' });
    this.calls.push({ op: 'decrypt', partition: principal.partition, key: input.key });
    const raw = Buffer.from(input.ciphertext.split(':').pop()!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', material, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(input.aad ?? ''));
    decipher.setAuthTag(raw.subarray(12, 28));
    return {
      plaintext: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString(
        'utf8',
      ),
    };
  }

  /** Crypto embedded in an app: its runtime, its own partition with every capability. */
  embedded(partition: string): CryptoRuntimeLike {
    const principal = { partition, capabilities: ['*'], actor: partition };
    return {
      topology: 'standalone',
      partition,
      service: this as never,
      operations: {
        encrypt: (input) => this.encrypt(principal, input),
        decrypt: (input) => this.decrypt(principal, input),
      },
    };
  }

  /**
   * A tenant of this crypto server: its token's capabilities; `partition` in encrypt is the new
   * cross-partition seal (allowed with `crypto:seal:<key>`).
   */
  tenant(partition: string, capabilities: string[]): CryptoRuntimeLike {
    const as = (p: string, caps: string[]) => ({ partition: p, capabilities: caps, actor: p });
    return {
      topology: 'tenant',
      partition,
      operations: {
        encrypt: async (input) => {
          if (input.partition && input.partition !== partition) {
            this.#allows(as(partition, capabilities), `crypto:seal:${input.key}`);
            return this.encrypt(as(input.partition, [`crypto:encrypt:${input.key}`]), input);
          }
          return this.encrypt(as(partition, capabilities), input);
        },
        decrypt: (input) => this.decrypt(as(partition, capabilities), input),
        getKey: async (name) => {
          this.#allows(as(partition, capabilities), `crypto:keys:read:${name}`);
          if (!this.keys.has(`${partition}/${name}`)) {
            throw Object.assign(new Error('no key'), { code: 'not_found' });
          }
          return { name };
        },
        createKey: (input) => this.createKey(as(partition, capabilities), input),
      },
    };
  }
}

/** A stand-in for authkit-client's calls between apps: tokens per target, a verifier. */
function fakeAuthkit(options: {
  caller?: string;
  capabilities?: string[];
  verifier?: boolean;
  tokens?: boolean;
}): AuthkitClientLike & { issued: string[] } {
  const issued: string[] = [];
  return {
    issued,
    appCallTokens: () =>
      options.tokens === false
        ? undefined
        : {
            token: async (app: string) => {
              issued.push(app);
              return `app-call:${options.caller ?? 'hub'}->${app}`;
            },
          },
    appCallerVerifier: () =>
      options.verifier === false
        ? null
        : {
            verifyToken: async (token: string) =>
              token.startsWith('app-call:')
                ? {
                    app: token.slice('app-call:'.length).split('->')[0]!,
                    capabilities: options.capabilities ?? ['flags:console:*'],
                    clientId: 'hub-client',
                    expiresAt: Date.now() + 60_000,
                  }
                : null,
          },
  };
}

interface Booted {
  app: ApplicationService;
  logs: string[];
  warnings: string[];
  errors: string[];
}

const apps: ApplicationService[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const app of apps.splice(0)) await app.terminate();
});

/** An app with the flags provider (and the dashboard's), fakes bound, booted as `web`. */
async function bootApp(options: {
  config: Record<string, unknown>;
  redis: FakePubSubRedis;
  crypto?: CryptoRuntimeLike;
  authkit?: AuthkitClientLike;
  dashboard?: boolean;
}): Promise<Booted> {
  const ignitor = new IgnitorFactory()
    .merge({
      rcFileContents: {
        providers: [
          () => import('../../providers/flags_provider.js'),
          ...(options.dashboard ? [() => import('../../providers/dashboard_provider.js')] : []),
        ],
      },
      config: options.config,
    })
    .withCoreConfig()
    .withCoreProviders()
    .create(new URL('./tmp/', import.meta.url));
  const app = ignitor.createApp('web') as ApplicationService;
  await app.init();
  const redis = options.redis;
  app.container.singleton(
    'redis' as never,
    () => ({ connection: () => ({ ioConnection: redis }) }) as never,
  );
  if (options.crypto) {
    const crypto = options.crypto;
    app.container.singleton('agora.crypto' as never, () => crypto as never);
  }
  if (options.authkit) {
    const authkit = options.authkit;
    app.container.singleton('authkit.client' as never, () => authkit as never);
  }
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  app.container.resolving('logger' as never, (resolved: unknown) => {
    const logger = resolved as {
      info(m: string): void;
      warn(m: string): void;
      error(m: string): void;
    };
    const { info, warn, error } = logger;
    logger.error = (message: string) => {
      if (typeof message === 'string') errors.push(message);
      return error.call(logger, message);
    };
    logger.info = (message: string) => {
      if (typeof message === 'string') logs.push(message);
      return info.call(logger, message);
    };
    logger.warn = (message: string) => {
      if (typeof message === 'string') warnings.push(message);
      return warn.call(logger, message);
    };
  });
  apps.push(app);
  await app.boot();
  await app.start(() => {});
  return { app, logs, warnings, errors };
}

/** The owning app, `entre-textos`, answering on the prefix `entretextos`. */
function etConfig(consoleCommands: Record<string, unknown> = {}) {
  return {
    flags: defineConfig({
      app: 'entre-textos',
      flags: { new_editor: flag.boolean({ default: false }) },
      store: stores.memory({ production: { flags: {} } }),
      transport: transports.memory(),
      dispatcher: 'in-process',
      consoleCommands: { prefix: 'entretextos', actions: true, ...consoleCommands },
    } as never),
  };
}

const profile = (capabilities: string[] | null = READ): FlagsConsoleCommand => ({
  id: crypto.randomUUID(),
  verb: 'profile',
  args: [],
  ...(capabilities ? { capabilities } : {}),
});

describe('owning app: automatic crypto mode', () => {
  it('with crypto embedded: creates console-flags in its partition and answers sealed commands', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    const { logs } = await bootApp({
      config: etConfig(),
      redis,
      crypto: service.embedded('entre-textos'),
    });
    expect(service.created).toEqual([
      { partition: 'entre-textos', name: 'console-flags', actor: 'flags:console' },
    ]);
    expect(logs).toContain(
      '[@adonis-agora/flags] console commands: crypto (auto, key console-flags); actions on',
    );
    // A console allowed to encrypt with that key reaches it; nothing else is configured.
    const console = new RedisConsoleChannel({
      client: redis,
      prefix: 'entretextos',
      crypto: {
        cipher: service.embedded('entre-textos').operations,
      },
    });
    closers.push(() => console.close());
    const reply = await console.send(profile(), { timeoutMs: 2000 });
    expect(reply).toMatchObject({ ok: true, data: { app: 'entre-textos' } });
    expect(service.calls.map((c) => c.op)).toEqual(['encrypt', 'decrypt']);
  });

  it('booting again finds the key and does not create it twice', async () => {
    const service = new FakeCryptoService();
    await bootApp({
      config: etConfig(),
      redis: new FakePubSubRedis(),
      crypto: service.embedded('entre-textos'),
    });
    await bootApp({
      config: etConfig(),
      redis: new FakePubSubRedis(),
      crypto: service.embedded('entre-textos'),
    });
    expect(service.created).toHaveLength(1);
  });

  it('as a crypto tenant: creates the key when its token may, else logs the command to run', async () => {
    const service = new FakeCryptoService();
    await bootApp({
      config: etConfig(),
      redis: new FakePubSubRedis(),
      crypto: service.tenant('entre-textos', [
        'crypto:decrypt:console-*',
        'crypto:keys:manage:console-*',
      ]),
    });
    expect(service.created).toEqual([
      { partition: 'entre-textos', name: 'console-flags', actor: 'entre-textos' },
    ]);

    // Missing and not creatable from here: one INFO line (the crypto server provisions the key on
    // the console's first seal), no warning.
    const other = new FakeCryptoService();
    const { logs, warnings } = await bootApp({
      config: etConfig(),
      redis: new FakePubSubRedis(),
      crypto: other.tenant('entre-textos', ['crypto:decrypt:console-*']),
    });
    expect(other.created).toHaveLength(0);
    expect(warnings.join('\n')).not.toContain('console-flags');
    expect(logs.join('\n')).toContain("creates it on the console's first command");
  });

  it('explicit options win: a secret is used as given, without auto crypto on top', async () => {
    const service = new FakeCryptoService();
    const { logs } = await bootApp({
      config: etConfig({ secret: 'shared-secret-0123456789' }),
      redis: new FakePubSubRedis(),
      crypto: service.embedded('entre-textos'),
    });
    expect(service.created).toHaveLength(0);
    expect(logs).toContain('[@adonis-agora/flags] console commands: secret; actions on');
  });

  it('crypto: false turns it off, and with nothing else the boot fails naming the options', async () => {
    const service = new FakeCryptoService();
    await expect(
      bootApp({
        config: etConfig({ crypto: false }),
        redis: new FakePubSubRedis(),
        crypto: service.embedded('entre-textos'),
      }),
    ).rejects.toThrow(
      /^\[@adonis-agora\/flags\] consoleCommands needs authentication: install and boot @adonis-agora\/crypto.*Run `node ace agora:doctor` to see every Agora lib's console auth at once\. Docs: https:\S+ Note: `crypto: false` turned the automatic crypto mode off\.$/,
    );
    expect(service.created).toHaveLength(0);
  });
});

describe('owning app: authkit app-call tokens', () => {
  it('verifies the token a crypto-sealed command carries; the audience binds it, not the partition', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    await bootApp({
      config: etConfig(),
      redis,
      crypto: service.embedded('entre-textos'),
      authkit: fakeAuthkit({ capabilities: ['flags:console:read'] }),
    });
    const cipher = service.embedded('entre-textos').operations;
    const send = async (token: string | undefined, command: FlagsConsoleCommand) => {
      const channel = new RedisConsoleChannel({
        client: redis,
        prefix: 'entretextos',
        crypto: { cipher },
        ...(token !== undefined ? { token } : {}),
      });
      closers.push(() => channel.close());
      return channel.send(command, { timeoutMs: 2000 });
    };
    // The hub's app-call token (its partition is the caller, "hub"): accepted.
    expect(await send('app-call:hub->entre-textos', profile())).toMatchObject({ ok: true });
    // Its capabilities (read only) cap the command, whatever the message says.
    const write = await send('app-call:hub->entre-textos', {
      id: crypto.randomUUID(),
      verb: 'setEnabled',
      args: [{ params: { key: 'new_editor' }, body: { enabled: true } }],
      capabilities: ALL,
    });
    expect(write).toMatchObject({ ok: false, error: { status: 403 } });
    // A token that does not verify is refused; a crypto-only command (no authkit on that console)
    // is still accepted.
    expect(await send('made-up', profile())).toMatchObject({ ok: false, error: { status: 401 } });
    expect(await send(undefined, profile())).toMatchObject({ ok: true });
  });

  it('without crypto: token mode sealed to the APP_KEY-derived key', () => {
    const auth = resolveAppConsoleAuth({
      option: {},
      authkit: fakeAuthkit({}),
      hasAppKey: true,
      tokenKeyId: 'k1d2e3f4',
    });
    expect(auth.modes).toEqual(['token (authkit app-call, auto; sealed to key k1d2e3f4)']);
    expect(auth.appKeySealed).toBe(true);
    // verifyTenant: false switches it off.
    expect(
      resolveAppConsoleAuth({
        option: { verifyTenant: false },
        authkit: fakeAuthkit({}),
        hasAppKey: true,
        tokenKeyId: 'k1d2e3f4',
      }).error,
    ).toMatch(/ Note: `verifyTenant: false` turned the automatic token verifiers off\.$/);
  });
});

describe('owning app: resolution rules', () => {
  const cryptoRuntime = new FakeCryptoService().embedded('shop');
  const fallback = async () => ({ partition: 'shop', capabilities: ['flags:console:*'] });

  it('a control plane falls back to its own verifyTenant, combined with auto crypto', () => {
    const auth = resolveAppConsoleAuth({
      option: {},
      fallbackVerifyTenant: fallback,
      crypto: cryptoRuntime,
      hasAppKey: true,
      tokenKeyId: 'k1d2e3f4',
    });
    expect(auth.modes).toEqual([
      "crypto (auto, key console-flags) + token checked when sent (the control plane's verifyTenant)",
      "token (the control plane's verifyTenant; sealed to key k1d2e3f4)",
    ]);
    // Not explicit: a crypto command without a token still runs.
    expect(auth.cryptoTokenRequired).toBe(false);
  });

  it('an explicit verifyTenant with explicit crypto requires the token; the APP_KEY-sealed token mode stays available', () => {
    const auth = resolveAppConsoleAuth({
      option: { crypto: { cipher: cryptoRuntime.operations }, verifyTenant: fallback },
      crypto: cryptoRuntime,
      hasAppKey: true,
      tokenKeyId: 'k1d2e3f4',
    });
    expect(auth.modes).toEqual([
      'crypto (key console-flags) + token required (verifyTenant)',
      'token (verifyTenant; sealed to key k1d2e3f4)',
    ]);
    expect(auth.cryptoTokenRequired).toBe(true);
    expect(auth.appKeySealed).toBe(true);
  });

  it('explicit crypto or secret do not suppress the fallback verifiers; verifyTenant: false does', () => {
    const withSecret = resolveAppConsoleAuth({
      option: { secret: 'shared-secret-0123456789' },
      fallbackVerifyTenant: fallback,
      authkit: fakeAuthkit({}),
      hasAppKey: true,
      tokenKeyId: 'k1d2e3f4',
    });
    expect(withSecret.modes).toEqual([
      "token (authkit app-call, auto, the control plane's verifyTenant; sealed to key k1d2e3f4)",
      'secret',
    ]);
    const off = resolveAppConsoleAuth({
      option: { secret: 'shared-secret-0123456789', verifyTenant: false },
      fallbackVerifyTenant: fallback,
      hasAppKey: true,
      tokenKeyId: 'k1d2e3f4',
    });
    expect(off.modes).toEqual(['secret']);
  });

  it('an explicit verifyTenant without an APP_KEY fails', () => {
    expect(
      resolveAppConsoleAuth({ option: { verifyTenant: fallback }, hasAppKey: false }).error,
    ).toMatch(/needs an APP_KEY/);
  });
});

describe('commands without capabilities', () => {
  it('are refused with 403, reads included', async () => {
    const runtime: FlagsRuntime = await createRuntime(
      defineConfig({
        app: 'shop',
        flags: {},
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    closers.push(() => runtime.close());
    const handler = flagsConsoleCommandHandler({ runtime: () => runtime, actions: true });
    await expect(handler(profile(null))).rejects.toMatchObject({
      status: 403,
      code: 'capabilities-required',
      message: expect.stringMatching(/^\[@adonis-agora\/flags\] .*without capabilities/),
    });
    // A read needs a read capability: approve alone does not imply it; write does.
    await expect(handler(profile(['flags:console:approve']))).rejects.toMatchObject({
      status: 403,
    });
    await expect(handler(profile(['flags:console:write']))).resolves.toMatchObject({ app: 'shop' });
    await expect(handler(profile(['flags:*']))).resolves.toMatchObject({ app: 'shop' });
  });
});

describe('the console (Hub)', () => {
  /** The Hub's config: one federated app, `et` (partition entre-textos), with no auth lines. */
  function hubConfig(et: FlagsRuntime, entry: Record<string, unknown> = {}, plane = {}) {
    return {
      flags: defineConfig({
        app: 'hub',
        flags: {},
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
        dispatcher: 'in-process',
      }),
      flags_dashboard: defineDashboardConfig({
        authorize: () => ({ allowed: true, capabilities: ['flags:console:read'] }),
        actor: () => ({ id: 'ops-1' }),
        apps: {
          et: {
            partition: 'entre-textos',
            store: et.store!,
            controlPlane: { prefix: 'entretextos', ...plane },
            timeoutMs: 2000,
            ...entry,
          } as never,
        },
      }),
    };
  }

  async function serveHub(app: ApplicationService) {
    const server = await app.container.make('server');
    server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
    await server.boot();
    const http: Server = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => http.close(() => resolve())));
    return `http://127.0.0.1:${(http.address() as AddressInfo).port}/flags/api`;
  }

  it('crypto embedded in the Hub + the app as its tenant: zero config end to end, with the viewer capabilities', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    // The app: a crypto tenant of the Hub holding only crypto:decrypt:console-*.
    const et = await bootApp({
      config: etConfig(),
      redis,
      crypto: service.tenant('entre-textos', ['crypto:decrypt:console-*']),
    });
    const etRuntime = (await et.app.container.make('flags.runtime')) as FlagsRuntime;
    // The Hub: crypto embedded, authkit's calls between apps set up.
    const authkit = fakeAuthkit({});
    const hub = await bootApp({
      config: hubConfig(etRuntime),
      redis,
      crypto: service.embedded('hub'),
      authkit,
      dashboard: true,
    });
    // The Hub created the key in the app's partition.
    expect(service.created).toEqual([
      { partition: 'entre-textos', name: 'console-flags', actor: 'flags:console' },
    ]);
    expect(hub.logs).toContain(
      '[@adonis-agora/flags] console commands to "et": crypto (auto, key console-flags, partition entre-textos) + token (authkit app-call, auto)',
    );
    // Created at boot, said once.
    expect(
      hub.logs.filter(
        (l) =>
          l ===
          '[@adonis-agora/flags] console commands: created the crypto key "console-flags" in partition entre-textos',
      ),
    ).toHaveLength(1);
    const base = await serveHub(hub.app);
    // A read the app answers (experiments: the app's analytics) goes through.
    const res = await fetch(`${base}/experiments?app=et`);
    expect(res.status).toBe(200);
    expect(authkit.issued).toContain('entre-textos');
    expect(
      service.calls.filter((c) => c.op === 'encrypt').every((c) => c.partition === 'entre-textos'),
    ).toBe(true);
    // The viewer may only read: a change is refused by the app (the console sent its capabilities).
    const write = await fetch(`${base}/flags/new_editor/enabled?app=et`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(write.status).toBe(403);
    expect(((await write.json()) as { error: string }).error).toMatch(/lacks flags:console:write/);
  });

  it('crypto in a separate app: seals through its tenant channel with crypto:seal', async () => {
    const service = new FakeCryptoService();
    service.keys.set('entre-textos/console-flags', randomBytes(32));
    const auth = resolveConsoleSideAuth({
      key: 'et',
      partition: 'entre-textos',
      plane: {},
      actions: true,
      crypto: service.tenant('hub', ['crypto:seal:console-*']),
    });
    expect(auth.mode).toBe('crypto (auto, key console-flags, partition entre-textos)');
    expect(auth.ensureKey).toBeUndefined();
    const sealer = cryptoConsoleSealer(auth.crypto!);
    const sealed = await sealer.seal('{}', 'aad');
    expect(sealer.owns(sealed)).toBe(true);
    expect(service.calls).toEqual([
      { op: 'encrypt', partition: 'entre-textos', key: 'console-flags' },
    ]);
    // Without the seal grant (or on a crypto server too old for it): an actionable error.
    const refused = resolveConsoleSideAuth({
      key: 'et',
      partition: 'entre-textos',
      plane: {},
      actions: true,
      crypto: service.tenant('hub', []),
    });
    await expect(cryptoConsoleSealer(refused.crypto!).seal('{}', 'aad')).rejects.toThrow(
      /crypto:seal:console-\*.*upgrade @adonis-agora\/crypto/,
    );
  });

  it('fails the boot for an app it cannot authenticate to, unless actions: false', async () => {
    const et = await createRuntime(
      defineConfig({
        app: 'entre-textos',
        flags: {},
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    closers.push(() => et.close());
    await expect(
      bootApp({ config: hubConfig(et), redis: new FakePubSubRedis(), dashboard: true }),
    ).rejects.toThrow(
      /^\[@adonis-agora\/flags\] flags_dashboard\.apps\["et"\]: commands to this app need authentication: boot @adonis-agora\/crypto in this app \(automatic\), or set flags_dashboard\.apps\["et"\]\.controlPlane\.secret, or flags_dashboard\.apps\["et"\]\.controlPlane\.token — or actions: false to only browse it\. Run `node ace agora:doctor` to see every Agora lib's console auth at once\.$/,
    );
    const browse = await bootApp({
      config: hubConfig(et, { actions: false }),
      redis: new FakePubSubRedis(),
      dashboard: true,
    });
    expect(browse.logs).toContain(
      '[@adonis-agora/flags] console commands to "et": none (browse-only: actions: false)',
    );
    // controlPlane.crypto: false turns the automatic mode off.
    await expect(
      bootApp({
        config: hubConfig(et, {}, { crypto: false }),
        redis: new FakePubSubRedis(),
        crypto: new FakeCryptoService().embedded('hub'),
        dashboard: true,
      }),
    ).rejects.toThrow(/ Note: `crypto: false` turned the automatic crypto mode off\.$/);
  });

  it("authkit's token without crypto must be sealed to the app's public key", () => {
    const auth = resolveConsoleSideAuth({
      key: 'et',
      partition: 'entre-textos',
      plane: {},
      actions: true,
      authkit: fakeAuthkit({}),
    });
    expect(auth.error).toMatch(/must travel sealed: set controlPlane.publicKey/);
    expect(
      resolveConsoleSideAuth({
        key: 'et',
        partition: 'entre-textos',
        plane: { publicKey: '{"kid":"et-cmd-1"}' },
        actions: true,
        authkit: fakeAuthkit({}),
      }).mode,
    ).toBe('token (authkit app-call, auto, controlPlane.publicKey; sealed to key et-cmd-1)');
    // token: false switches the automatic token off.
    expect(
      resolveConsoleSideAuth({
        key: 'et',
        partition: 'entre-textos',
        plane: { token: false, publicKey: '{}' },
        actions: true,
        authkit: fakeAuthkit({}),
      }).error,
    ).toMatch(/ Note: `token: false` turned the automatic authkit token off\.$/);
  });
});

describe('bring your own cipher', () => {
  it("`owns` recognizes another KMS's ciphertext", async () => {
    const sealer = cryptoConsoleSealer({
      cipher: {
        encrypt: async ({ plaintext }) => ({
          ciphertext: `vault:v1:${Buffer.from(plaintext).toString('base64')}`,
        }),
        decrypt: async ({ ciphertext }) => ({
          plaintext: Buffer.from(ciphertext.slice('vault:v1:'.length), 'base64').toString(),
        }),
      },
      owns: (ciphertext) => ciphertext.startsWith('vault:v1:'),
    });
    const sealed = await sealer.seal('hello', 'aad');
    expect(sealer.owns(sealed)).toBe(true);
    expect(sealer.owns('agora:ct1:console-flags:1:x')).toBe(false);
    expect(await sealer.open(sealed, 'aad')).toBe('hello');
  });
});

describe('agora:doctor console commands', () => {
  const check = agoraDoctorChecks.find((c) => c.id === 'flags.console-commands')!;
  const keyCheck = agoraDoctorChecks.find((c) => c.id === 'flags.console-commands-key')!;

  it('reports the mode (cheap) and round-trips a probe with the key (deep)', async () => {
    const service = new FakeCryptoService();
    const { app } = await bootApp({
      config: etConfig(),
      redis: new FakePubSubRedis(),
      crypto: service.embedded('entre-textos'),
    });
    expect(check.cost).toBe('cheap');
    expect(keyCheck.cost).toBe('deep');
    expect([await check.run(app)].flat()).toEqual([
      { status: 'ok', message: 'console commands: crypto (auto, key console-flags); actions on' },
    ]);
    expect([await keyCheck.run(app)].flat()).toEqual([
      expect.objectContaining({
        status: 'ok',
        message: expect.stringMatching(
          /^console commands: crypto \(auto, key console-flags\); actions on; the key console-flags round-trips$/,
        ),
      }),
    ]);
  });

  it('errors when consoleCommands cannot authenticate', async () => {
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: etConfig({ crypto: false }),
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    // The doctor runs in an ace command, where the channel does not start (nor fail).
    const app = ignitor.createApp('console') as ApplicationService;
    await app.init();
    apps.push(app);
    await app.boot();
    const results = [await check.run(app)].flat();
    expect(results[0]).toMatchObject({
      status: 'error',
      message: expect.stringMatching(/consoleCommands needs authentication/),
    });
  });
});

describe('uniform details (§10)', () => {
  it('a key that cannot be created never fails the boot: one line to run, retried on first use', async () => {
    const service = new FakeCryptoService();
    let refuse = true;
    const createKey = service.createKey.bind(service);
    service.createKey = async (principal, input) => {
      if (refuse) throw Object.assign(new Error('crypto is read-only'), { code: 'unavailable' });
      return createKey(principal, input);
    };
    const redis = new FakePubSubRedis();
    const { warnings } = await bootApp({
      config: etConfig(),
      redis,
      crypto: service.embedded('entre-textos'),
    });
    expect(warnings.join('\n')).toContain(
      '`node ace crypto:keys:create console-flags --type aes256-gcm --application entre-textos`; retried on the next command',
    );
    expect(service.created).toHaveLength(0);
    // Retried on first use: the Hub's guard creates the key before its first command.
    refuse = false;
    const guard = embeddedKeyGuard(service as never, 'entre-textos');
    const lines: string[] = [];
    refuse = true;
    expect(await guard.boot({ warn: (line) => lines.push(line) })).toBe(false);
    expect(lines).toHaveLength(1);
    refuse = false;
    const cipher = guard.wrap(service.embedded('entre-textos').operations);
    await cipher.encrypt({ key: 'console-flags', plaintext: 'x', aad: 'a' });
    expect(service.created).toEqual([
      { partition: 'entre-textos', name: 'console-flags', actor: 'flags:console' },
    ]);
    expect(redis).toBeDefined();
  });

  it('a crypto tenant that cannot create keys says what to run (never silent)', async () => {
    const service = new FakeCryptoService();
    const tenant = service.tenant('entre-textos', ['crypto:decrypt:console-*']);
    delete (tenant.operations as { createKey?: unknown }).createKey;
    delete (tenant.operations as { getKey?: unknown }).getKey;
    const { logs } = await bootApp({
      config: etConfig(),
      redis: new FakePubSubRedis(),
      crypto: tenant,
    });
    expect(logs.join('\n')).toContain(
      'node ace crypto:keys:create console-flags --type aes256-gcm --application entre-textos',
    );
  });

  it('only a web server fails its boot; under test it is logged', async () => {
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: etConfig({ crypto: false }),
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    const app = ignitor.createApp('test') as ApplicationService;
    await app.init();
    app.container.singleton(
      'redis' as never,
      () => ({ connection: () => ({ ioConnection: new FakePubSubRedis() }) }) as never,
    );
    apps.push(app);
    await app.boot();
    await expect(app.start(() => {})).resolves.toBeUndefined();
  });

  it('the console narrows the viewer capabilities to its console set', () => {
    expect(viewerConsoleCapabilities(undefined)).toEqual(ALL);
    expect(viewerConsoleCapabilities(['flags:*', 'billing:console:*', 'x'])).toEqual(ALL);
    expect(viewerConsoleCapabilities(['flags:console:write', 'other:thing'])).toEqual([
      'flags:console:read',
      'flags:console:write',
    ]);
    expect(viewerConsoleCapabilities(['*'], 'read')).toEqual(['flags:console:read']);
    expect(viewerConsoleCapabilities(['billing:console:*'])).toEqual([]);
  });

  it("anyAuthorize keeps the deciding authorizer's capabilities, apps and tenants", async () => {
    const guard = resolveConsoleAuthorize(
      anyAuthorize(
        () => ({ allowed: false, reason: 'unauthenticated' }),
        () => ({
          allowed: true,
          apps: ['et'],
          tenants: ['acme'],
          capabilities: ['flags:console:read'],
          access: 'read',
        }),
      ),
    );
    expect(await guard({} as never)).toEqual({
      allowed: true,
      apps: ['et'],
      tenants: ['acme'],
      capabilities: ['flags:console:read'],
      access: 'read',
    });
    // Malformed capabilities allow nothing; an unknown access is dropped.
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, capabilities: 'all', access: 'admin' }),
    ).toEqual({ allowed: true, capabilities: [] });
  });
});

describe("the viewer's capabilities on the console's own app (§10.13)", () => {
  async function local(authorize: () => unknown) {
    const { app } = await bootApp({
      config: {
        flags: defineConfig({
          app: 'hub',
          flags: { hub_only: flag.boolean({ default: true }) },
          store: stores.memory({ production: { flags: {} } }),
          transport: transports.memory(),
          dispatcher: 'in-process',
        }),
        flags_dashboard: defineDashboardConfig({
          authorize: authorize as never,
          actor: () => ({ id: 'ops-1' }),
        }),
      },
      redis: new FakePubSubRedis(),
      dashboard: true,
    });
    const server = await app.container.make('server');
    server.use([() => import('@adonisjs/core/bodyparser_middleware')]);
    await server.boot();
    const http: Server = createServer(server.handle.bind(server));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise((resolve) => http.close(() => resolve())));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/flags/api`;
    const kill = () =>
      fetch(`${base}/flags/hub_only/enabled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
    const meta = async () =>
      (await (await fetch(`${base}/meta`)).json()) as Record<string, unknown>;
    return { kill, meta };
  }

  it('a read-only viewer cannot change this app either, and the UI is told', async () => {
    const { kill, meta } = await local(() => ({
      allowed: true,
      capabilities: ['flags:console:read'],
    }));
    const refused = await kill();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: '[@adonis-agora/flags] the viewer lacks flags:console:write',
    });
    expect((await meta()).capabilities).toEqual(['flags:console:read']);
  });

  it("access: 'read' is the same, whatever the capabilities", async () => {
    const { kill } = await local(() => ({ allowed: true, capabilities: ['*'], access: 'read' }));
    expect((await kill()).status).toBe(403);
  });

  it('authorize without capabilities keeps full access', async () => {
    const { kill, meta } = await local(() => true);
    expect((await kill()).status).toBe(200);
    expect(await meta()).not.toHaveProperty('capabilities');
  });
});

describe('review round 2', () => {
  it('controlPlane.token: false boots (with another mode, or browse-only)', async () => {
    const et = await createRuntime(
      defineConfig({
        app: 'entre-textos',
        flags: {},
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    closers.push(() => et.close());
    for (const plane of [
      { prefix: 'entretextos', token: false, secret: 'shared-secret-0123456789' },
      { prefix: 'entretextos', token: false },
    ]) {
      const { logs } = await bootApp({
        config: {
          flags: defineConfig({
            app: 'hub',
            flags: {},
            store: stores.memory({ production: { flags: {} } }),
            transport: transports.memory(),
            dispatcher: 'in-process',
          }),
          flags_dashboard: defineDashboardConfig({
            authorize: () => true,
            apps: {
              et: {
                store: et.store!,
                controlPlane: plane as never,
                ...(plane.secret ? {} : { actions: false }),
              },
            },
          }),
        },
        redis: new FakePubSubRedis(),
        authkit: fakeAuthkit({}),
        dashboard: true,
      });
      expect(logs.some((l) => l.startsWith('[@adonis-agora/flags] console commands to "et"'))).toBe(
        true,
      );
    }
  });

  it('the tenant key check never uses getKey, and is not repeated on every command', async () => {
    const service = new FakeCryptoService();
    const tenant = service.tenant('entre-textos', ['crypto:decrypt:console-*']);
    const calls: string[] = [];
    const ops = tenant.operations;
    tenant.operations = {
      encrypt: ops.encrypt,
      decrypt: async (input) => {
        calls.push('decrypt');
        return ops.decrypt(input);
      },
      getKey: async () => {
        throw new Error('getKey must not be called (needs crypto:keys:read)');
      },
      createKey: async (input) => {
        calls.push('createKey');
        return ops.createKey!(input);
      },
    };
    const notes: Array<{ level: string; line: string }> = [];
    const watch = watchTenantConsoleKey(tenant, (note) => notes.push(note));
    await watch.atBoot();
    expect(notes).toEqual([
      {
        level: 'info',
        line: expect.stringContaining(
          'node ace crypto:keys:create console-flags --type aes256-gcm --application entre-textos',
        ),
      },
    ]);
    expect(calls).toEqual(['decrypt', 'createKey']);
    // Afterwards a command's own decrypt is the retry: no extra crypto call, and the same note
    // is not logged again.
    for (let i = 0; i < 3; i++) {
      await watch.decrypt({ key: 'console-flags', ciphertext: 'x', aad: 'a' }).catch(() => {});
    }
    expect(calls).toEqual(['decrypt', 'createKey', 'decrypt', 'decrypt', 'decrypt']);
    expect(notes).toHaveLength(1);
  });

  it('an existing key passes the tenant check with the decrypt-only grant', async () => {
    const service = new FakeCryptoService();
    service.keys.set('entre-textos/console-flags', randomBytes(32));
    const tenant = service.tenant('entre-textos', ['crypto:decrypt:console-*']);
    expect(await checkTenantConsoleKey(tenant)).toBeUndefined();
    // Forbidden (no decrypt grant) is said, not ignored.
    const denied = await checkTenantConsoleKey(service.tenant('entre-textos', []));
    expect(denied?.level).toBe('warn');
    expect(denied?.line).toContain("no grant is needed for an app's own console keys");
  });
});

describe('§10.16 literal aliases and §10.18 check order', () => {
  async function shopHandler(actions = true) {
    const runtime: FlagsRuntime = await createRuntime(
      defineConfig({
        app: 'shop',
        flags: { beta: flag.boolean({ default: false }) },
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    closers.push(() => runtime.close());
    return flagsConsoleCommandHandler({ runtime: () => runtime, actions });
  }
  const write = (extra: Partial<FlagsConsoleCommand> = {}): FlagsConsoleCommand => ({
    id: crypto.randomUUID(),
    verb: 'setEnabled',
    args: [{ params: { key: 'beta' }, body: { enabled: true } }],
    actor: { id: 'ops-1' },
    ...extra,
  });

  it('look-alike capabilities grant nothing extra, on the viewer and on the token', async () => {
    for (const lookAlike of [
      'flags:*:write',
      'flags:console:w*',
      'flags:console:*:write',
      'flags:c*',
    ]) {
      expect(flagsConsoleCapabilityAllows([lookAlike], 'flags:console:write')).toBe(false);
      expect(viewerConsoleCapabilities([lookAlike])).toEqual([]);
    }
    for (const alias of ['*', 'flags:*', 'flags:console:*', 'flags:console:write']) {
      expect(flagsConsoleCapabilityAllows([alias], 'flags:console:write')).toBe(true);
    }
    // Write implies read; approve stays separate (separation of duty).
    expect(flagsConsoleCapabilityAllows(['flags:console:write'], 'flags:console:read')).toBe(true);
    expect(flagsConsoleCapabilityAllows(['flags:console:write'], 'flags:console:approve')).toBe(
      false,
    );
    expect(flagsConsoleCapabilityAllows(['flags:console:read'], 'flags:console:write')).toBe(false);
    expect(flagsConsoleCapabilityAllows(['flags:console:*'], 'flags:console:approve')).toBe(true);
    expect(
      flagsConsoleCapabilityAllows(['*:console:*', 'other:console:*'], 'flags:console:read'),
    ).toBe(false);
    expect(viewerConsoleCapabilities(['flags:console:write'])).toEqual([
      'flags:console:read',
      'flags:console:write',
    ]);
    const handler = await shopHandler();
    await expect(handler(write({ capabilities: ['flags:*:write'] }))).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/the viewer lacks flags:console:write/),
    });
    await expect(
      handler(
        write({
          capabilities: ['flags:console:*'],
          verified: { partition: 'shop', capabilities: ['flags:console:w*'] },
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/the console's token lacks/) });
  });

  it('a command without capabilities gets capabilities-required before partition and actions', async () => {
    const handler = await shopHandler(false);
    await expect(
      handler(write({ verified: { partition: 'billing', capabilities: ['flags:console:*'] } })),
    ).rejects.toMatchObject({ status: 403, code: 'capabilities-required' });
    // An unknown verb is refused first of all.
    await expect(handler({ id: 'x', verb: 'dropTables', args: [] })).rejects.toMatchObject({
      code: 'unsupported-request',
    });
    // Then token, then viewer, then partition, then actions.
    await expect(
      handler(
        write({
          capabilities: ['flags:console:read'],
          verified: { partition: 'billing', capabilities: ['flags:console:read'] },
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/the console's token lacks/) });
    await expect(
      handler(
        write({
          capabilities: ['flags:console:read'],
          verified: { partition: 'billing', capabilities: ['flags:console:*'] },
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/the viewer lacks/) });
    await expect(
      handler(
        write({
          capabilities: ['flags:console:*'],
          verified: { partition: 'billing', capabilities: ['flags:console:*'] },
        }),
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/token is for "billing"/) });
    await expect(handler(write({ capabilities: ['flags:console:*'] }))).rejects.toMatchObject({
      message: expect.stringMatching(/consoleCommands.actions is off/),
    });
  });
});

describe('§10.15 the channel starts in ready(), on a web server only', () => {
  async function bootAs(environment: 'web' | 'test' | 'console', redis: FakePubSubRedis) {
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/flags_provider.js')] },
        config: etConfig({ secret: 'shared-secret-0123456789' }),
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    const app = ignitor.createApp(environment) as ApplicationService;
    await app.init();
    app.container.singleton(
      'redis' as never,
      () => ({ connection: () => ({ ioConnection: redis }) }) as never,
    );
    apps.push(app);
    await app.boot();
    return app;
  }
  const subscribed = (redis: FakePubSubRedis) => redis.server.subscribers.size;

  it('a web server subscribes only once ready, not during boot', async () => {
    const redis = new FakePubSubRedis();
    const app = await bootAs('web', redis);
    expect(subscribed(redis)).toBe(0);
    await app.start(() => {});
    expect(subscribed(redis)).toBe(1);
  });

  it('test and ace processes never open the subscription', async () => {
    for (const environment of ['test', 'console'] as const) {
      const redis = new FakePubSubRedis();
      const app = await bootAs(environment, redis);
      await app.start(() => {});
      expect(subscribed(redis)).toBe(0);
    }
  });
});

describe('§11 uniform DX strings', () => {
  const SECRET = 'shared-secret-0123456789';

  it('never crashes on a bad message: garbage is dropped, logged once per reason, and the app keeps serving', async () => {
    const redis = new FakePubSubRedis();
    const { warnings } = await bootApp({ config: etConfig({ secret: SECRET }), redis });
    const raw = redis.duplicate();
    const garbage = [
      'not json at all',
      'null',
      '[]',
      '42',
      JSON.stringify({ nope: true }),
      JSON.stringify({ id: 7, verb: 'profile' }),
      JSON.stringify({ id: 'a', verb: 'profile', args: [] }),
      JSON.stringify({ id: 'b', verb: 'profile', args: [] }),
      JSON.stringify({ id: 'c', sealed: 'agora:pk1:garbage' }),
      JSON.stringify({ id: 'd', mac: 'AAAA', ts: Date.now(), verb: 'setEnabled' }),
      JSON.stringify({ id: 'e', mac: 'AAAA', ts: Date.now(), verb: 'setEnabled' }),
    ];
    for (const message of garbage) await raw.publish('entretextos-flags-console', message);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Logged as warnings in the uniform words, each reason once.
    const refusals = warnings.filter((w) => w.includes('refused a command'));
    expect(refusals.slice().sort()).toEqual(
      [
        '[@adonis-agora/flags] console commands: refused a command (not JSON)',
        '[@adonis-agora/flags] console commands: refused a command (no command id)',
        '[@adonis-agora/flags] console commands: refused a command (mode not accepted here (this app accepts: secret; the command came as unsigned))',
        '[@adonis-agora/flags] console commands: refused a command (mode not accepted here (this app accepts: secret; the command came as token))',
        '[@adonis-agora/flags] console commands: refused a command (bad signature)',
      ].sort(),
    );
    expect(warnings.join('\n')).not.toContain('unsigned?');
    // Still serving.
    const console = new RedisConsoleChannel({
      client: redis,
      prefix: 'entretextos',
      secret: SECRET,
    });
    closers.push(() => console.close());
    expect(await console.send(profile(), { timeoutMs: 2000 })).toMatchObject({ ok: true });
  });

  it('logs the actions line, and the public key only as a short id in token mode', async () => {
    const previous = process.env.APP_KEY;
    process.env.APP_KEY = 'app-key-of-entre-textos-0123456789';
    try {
      const plain = await bootApp({
        config: etConfig({ secret: SECRET, actions: false }),
        redis: new FakePubSubRedis(),
      });
      expect(plain.logs).toContain(
        '[@adonis-agora/flags] console commands: secret; actions off (set consoleCommands.actions to let the console act)',
      );
      expect(plain.logs.join('\n')).not.toContain('sealed to key');
      const token = await bootApp({
        config: etConfig({ verifyTenant: () => null }),
        redis: new FakePubSubRedis(),
      });
      const line = token.logs.find((l) => l.startsWith('[@adonis-agora/flags] console commands:'))!;
      expect(line).toMatch(
        /^\[@adonis-agora\/flags\] console commands: token \(verifyTenant; sealed to key [^ ;)]{8}\); actions on$/,
      );
      expect(token.logs.join('\n')).not.toMatch(/"x":|"kty"/);
    } finally {
      if (previous === undefined) delete process.env.APP_KEY;
      else process.env.APP_KEY = previous;
    }
  });

  it('a command nobody answers says so, pointing at the app and the doctor', async () => {
    const redis = new FakePubSubRedis();
    const silent = redis.duplicate();
    await silent.subscribe('entretextos-flags-console');
    const console = new RedisConsoleChannel({
      client: redis,
      prefix: 'entretextos',
      secret: SECRET,
    });
    closers.push(() => console.close());
    await expect(console.send(profile(), { timeoutMs: 200 })).rejects.toThrow(
      'no instance of "entretextos" answered within 0.2s — the app may have refused the command (check its logs, or run `node ace agora:doctor` there)',
    );
  });

  it('boot errors are ConsoleAuthConfigError', async () => {
    await expect(
      bootApp({ config: etConfig({ crypto: false }), redis: new FakePubSubRedis() }),
    ).rejects.toBeInstanceOf(ConsoleAuthConfigError);
  });
});

describe("§2e.B authkit's key directory (token mode without crypto)", () => {
  const APP_KEY = 'app-key-of-entre-textos-0123456789';
  /** A fake authkit-client manager: app-call tokens and verifier, plus the key directory. */
  function directoryAuthkit(directory: Map<string, unknown>, app: string) {
    const published: Array<{ purpose: string; jwk: Record<string, unknown> }> = [];
    const base = fakeAuthkit({ caller: 'hub', capabilities: ['flags:console:*'] });
    return {
      published,
      ...base,
      publishAppKey: async (input: { purpose: string; jwk: Record<string, unknown> }) => {
        published.push(input);
        directory.set(`${app}/${input.purpose}`, input.jwk);
      },
      appKey: async ({ app: target, purpose }: { app: string; purpose: string }) =>
        (directory.get(`${target}/${purpose}`) as never) ?? null,
    };
  }

  async function withAppKey<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env.APP_KEY;
    process.env.APP_KEY = APP_KEY;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.APP_KEY;
      else process.env.APP_KEY = previous;
    }
  }

  it('the app publishes its public key (never d); the console seals to it, zero config', async () => {
    await withAppKey(async () => {
      const directory = new Map<string, unknown>();
      const redis = new FakePubSubRedis();
      const appSide = directoryAuthkit(directory, 'entre-textos');
      const et = await bootApp({ config: etConfig(), redis, authkit: appSide as never });
      expect(appSide.published).toHaveLength(1);
      expect(appSide.published[0]!.purpose).toBe('console:flags');
      expect(appSide.published[0]!.jwk).toMatchObject({ kty: 'OKP', crv: 'X25519' });
      expect(appSide.published[0]!.jwk).not.toHaveProperty('d');
      const etRuntime = (await et.app.container.make('flags.runtime')) as FlagsRuntime;

      const federation = new FederatedFlagsConsole(
        {
          et: {
            partition: 'entre-textos',
            store: etRuntime.store!,
            controlPlane: { prefix: 'entretextos' },
            timeoutMs: 2000,
          },
        },
        { db: async () => ({}) as never, redis: async () => redis.duplicate() },
      );
      closers.push(() => federation.close());
      const lines = await federation.authenticate({
        authkit: directoryAuthkit(directory, 'hub') as never,
      });
      expect(lines).toEqual([
        '[@adonis-agora/flags] console commands to "et": token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
      ]);
      const res = await federation.dispatch(
        'et',
        'setEnabled',
        { actor: { id: 'ops-1' } },
        { params: { key: 'new_editor' }, query: {}, body: { enabled: true } },
      );
      expect(res.status).toBe(200);
      expect((await etRuntime.store!.readRuleset('production')).flags.new_editor?.enabled).toBe(
        true,
      );
    });
  });

  it('an explicit publicKey wins over the directory', () => {
    const auth = resolveConsoleSideAuth({
      key: 'et',
      partition: 'entre-textos',
      plane: { publicKey: '{"kid":"cfg-key"}' },
      actions: true,
      authkit: directoryAuthkit(new Map(), 'hub') as never,
    });
    expect(auth.recipient).toBeUndefined();
    expect(auth.mode).toBe(
      'token (authkit app-call, auto, controlPlane.publicKey; sealed to key cfg-key)',
    );
  });

  it('no key in the directory: an actionable error on send', async () => {
    const auth = resolveConsoleSideAuth({
      key: 'et',
      partition: 'entre-textos',
      plane: {},
      actions: true,
      authkit: directoryAuthkit(new Map(), 'hub') as never,
    });
    await expect(auth.recipient!()).rejects.toThrow(
      /has no console public key in authkit's key directory \(purpose console:flags\): it publishes it automatically at boot when it has authkit's `service` configured.*controlPlane\.publicKey/,
    );
    // Without a directory (older authkit-client), the boot error says how to seal the token.
    expect(
      resolveConsoleSideAuth({
        key: 'et',
        partition: 'entre-textos',
        plane: {},
        actions: true,
        authkit: fakeAuthkit({}),
      }).error,
    ).toMatch(/Note: a token must travel sealed: set controlPlane\.publicKey/);
  });
});

describe('§11b refusal reasons', () => {
  const SECRET = 'shared-secret-0123456789';
  const COMMANDS = 'shop-flags-console';
  async function answering(options: Record<string, unknown>) {
    const redis = new FakePubSubRedis();
    const reasons: string[] = [];
    const channel = new RedisConsoleChannel({
      client: redis.duplicate(),
      prefix: 'shop',
      ...options,
    } as never);
    closers.push(() => channel.close());
    await channel.answer(
      async (command) => {
        if (!Array.isArray(command.capabilities)) {
          throw Object.assign(new Error('no capabilities'), { code: 'capabilities-required' });
        }
        return { ok: true };
      },
      { onError: (error) => reasons.push((error as { reason?: string }).reason ?? '?') },
    );
    return { redis, reasons };
  }

  it('names each reason in the uniform words', async () => {
    const { redis, reasons } = await answering({ secret: SECRET });
    const console = new RedisConsoleChannel({
      client: redis.duplicate(),
      prefix: 'shop',
      secret: SECRET,
    });
    closers.push(() => console.close());
    // capabilities-required: a signed command without capabilities.
    await console.send({ id: 'c1', verb: 'profile', args: [] }, { timeoutMs: 1000 });
    // replayed: the same signed message again.
    const signed = redis.server.published.find((p) => p.channel === COMMANDS)!;
    await redis.duplicate().publish(COMMANDS, signed.message);
    // stale: signed by a console whose clock is two minutes behind.
    const now = Date.now;
    Date.now = () => now() - 120_000;
    const old = console.send({ id: 'c2', verb: 'profile', args: [] }, { timeoutMs: 200 });
    Date.now = now;
    await old.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reasons).toEqual(expect.arrayContaining(['capabilities-required', 'replayed', 'stale']));
  });

  it("did not open with this app's key, and token refused", async () => {
    const keys = consoleCommandKeys('app-key-of-the-shop-0123456789', 'shop');
    const { redis, reasons } = await answering({
      keys,
      verifyTenant: () => null,
      partition: 'shop',
    });
    const other = consoleCommandKeys('another-app-key-0123456789', 'shop');
    const wrongKey = new RedisConsoleChannel({
      client: redis.duplicate(),
      prefix: 'shop',
      token: 't',
      recipient: async () => other.publicKey,
    });
    const goodKey = new RedisConsoleChannel({
      client: redis.duplicate(),
      prefix: 'shop',
      token: 'not-a-valid-token',
      recipient: async () => keys.publicKey,
    });
    closers.push(
      () => wrongKey.close(),
      () => goodKey.close(),
    );
    await wrongKey.send(profile(), { timeoutMs: 200 }).catch(() => undefined);
    await goodKey.send(profile(), { timeoutMs: 1000 });
    expect(reasons).toEqual(
      expect.arrayContaining(["did not open with this app's key", 'token refused']),
    );
  });
});

describe('§13 mixed Hubs', () => {
  async function appRuntime(app: string) {
    const runtime = await createRuntime(
      defineConfig({
        app,
        flags: { beta: flag.boolean({ default: false }) },
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    closers.push(() => runtime.close());
    return runtime;
  }
  /** The Hub's authkit: app-call tokens (optionally failing), a verifier, and the directory. */
  function hubAuthkit(directory: Map<string, unknown>, failToken?: () => boolean) {
    const base = fakeAuthkit({ caller: 'hub', capabilities: ['flags:console:*'] });
    return {
      appCallTokens: () => ({
        token: async (app: string) => {
          if (failToken?.()) throw new Error('invalid_target (503)');
          return `app-call:hub->${app}`;
        },
      }),
      appCallerVerifier: base.appCallerVerifier,
      appKey: async ({ app, purpose }: { app: string; purpose: string }) =>
        (directory.get(`${app}/${purpose}`) as never) ?? null,
    };
  }
  const enable = { params: { key: 'beta' }, query: {}, body: { enabled: true } };

  it('§13a: per app, lazily: the app that publishes a key gets token mode, the other crypto', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    const directory = new Map<string, unknown>();
    // ET: a crypto tenant (no token mode).
    const et = await appRuntime('entre-textos');
    const etAnswer = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'et',
      actions: true,
      runtime: () => et,
      crypto: {
        cipher: service.tenant('entre-textos', ['crypto:decrypt:console-*']).operations,
      },
    });
    closers.push(() => etAnswer.close());
    // EduLiberta: authkit only, token mode, its key in the directory.
    const edu = await appRuntime('eduliberta');
    const eduKeys = consoleCommandKeys('app-key-of-eduliberta-0123456789', 'edu');
    directory.set('eduliberta/console:flags', eduKeys.publicKey);
    const verifier = fakeAuthkit({ caller: 'hub' }).appCallerVerifier!()!;
    const eduAnswer = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'edu',
      actions: true,
      runtime: () => edu,
      keys: eduKeys,
      verifyTenant: async ({ token }) => {
        const caller = token ? await verifier.verifyToken(token) : null;
        return caller
          ? ({ partition: caller.app, capabilities: caller.capabilities, appCall: true } as never)
          : null;
      },
    });
    closers.push(() => eduAnswer.close());

    const federation = new FederatedFlagsConsole(
      {
        et: { partition: 'entre-textos', store: et.store!, controlPlane: { prefix: 'et' } },
        edu: { partition: 'eduliberta', store: edu.store!, controlPlane: { prefix: 'edu' } },
      },
      { db: async () => ({}) as never, redis: async () => redis.duplicate() },
    );
    closers.push(() => federation.close());
    let mints = 0;
    const lines = await federation.authenticate({
      crypto: service.embedded('hub'),
      authkit: hubAuthkit(directory, () => {
        mints++;
        return false;
      }) as never,
    });
    expect(lines).toEqual([
      '[@adonis-agora/flags] console commands to "et": auto (authkit key directory if the app publishes one, else crypto (auto, key console-flags, partition entre-textos))',
      '[@adonis-agora/flags] console commands to "edu": auto (authkit key directory if the app publishes one, else crypto (auto, key console-flags, partition eduliberta))',
    ]);
    expect(
      (await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable)).status,
    ).toBe(200);
    expect(
      (await federation.dispatch('edu', 'setEnabled', { actor: { id: 'ops' } }, enable)).status,
    ).toBe(200);
    // EduLiberta's command was never sealed with crypto: only ET's partition was used.
    expect(service.calls.filter((c) => c.op === 'encrypt').map((c) => c.partition)).toEqual([
      'entre-textos',
    ]);
    expect((await edu.store!.readRuleset('production')).flags.beta?.enabled).toBe(true);
    // One app-call token minted per command (ET's optional one, EduLiberta's required one): never
    // once to check and once to send.
    expect(mints).toBe(2);
    await federation.dispatch('edu', 'setEnabled', { actor: { id: 'ops' } }, enable);
    expect(mints).toBe(3);
  });

  it('§13a: the choice is cached, and decided again after 5 minutes', async () => {
    const directory = new Map<string, unknown>();
    const lookups: string[] = [];
    const authkit = {
      ...hubAuthkit(directory),
      appKey: async ({ app }: { app: string; purpose: string }) => {
        lookups.push(app);
        return null;
      },
    };
    const redis = new FakePubSubRedis();
    const service = new FakeCryptoService();
    const et = await appRuntime('entre-textos');
    const answer = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'et',
      actions: true,
      runtime: () => et,
      crypto: { cipher: service.tenant('entre-textos', ['crypto:decrypt:console-*']).operations },
    });
    closers.push(() => answer.close());
    const federation = new FederatedFlagsConsole(
      { et: { partition: 'entre-textos', store: et.store!, controlPlane: { prefix: 'et' } } },
      { db: async () => ({}) as never, redis: async () => redis.duplicate() },
    );
    closers.push(() => federation.close());
    await federation.authenticate({ crypto: service.embedded('hub'), authkit: authkit as never });
    await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable);
    await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable);
    expect(lookups).toHaveLength(1);
    const now = Date.now;
    Date.now = () => now() + 5 * 60_000 + 1;
    try {
      await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable);
    } finally {
      Date.now = now;
    }
    expect(lookups).toHaveLength(2);
  });

  it('§13b: in crypto mode a failing app-call token never blocks the command; one warning; retried after 5 min', async () => {
    let failing = true;
    let clock = 1_000_000;
    const warnings: string[] = [];
    const token = optionalAppCallToken(
      async () => {
        if (failing) throw new Error('invalid_target (503)');
        return 'tok';
      },
      'entre-textos',
      (line) => warnings.push(line),
      () => clock,
    );
    expect(await token.get()).toBe('');
    expect(await token.get()).toBe('');
    expect(warnings).toEqual([
      '[@adonis-agora/flags] console commands to "entre-textos": sending without an authkit app-call token (crypto only): invalid_target (503). To attach it: grant the console\'s service client flags:console:* on "entre-textos" in authkit.',
    ]);
    // The same reason after the retry: no second warning (once per reason).
    clock += 5 * 60_000 + 1;
    expect(await token.get()).toBe('');
    expect(warnings).toHaveLength(1);
    failing = false;
    expect(await token.get()).toBe('');
    clock += 5 * 60_000 + 1;
    expect(await token.get()).toBe('tok');
    // In token mode the token is required: the error carries the same grant hint.
    const required = requiredAppCallToken(async () => {
      throw new Error('no grant');
    }, 'eduliberta');
    await expect(required.get()).rejects.toThrow(
      'no grant. To attach it: grant the console\'s service client flags:console:* on "eduliberta" in authkit.',
    );
  });

  it('§13a: token auto-chosen but the app-call token cannot be minted: that command goes by crypto', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    const et = await appRuntime('entre-textos');
    const answer = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'et',
      actions: true,
      runtime: () => et,
      crypto: { cipher: service.tenant('entre-textos', ['crypto:decrypt:console-*']).operations },
    });
    closers.push(() => answer.close());
    // A key published by an old version of the app is still in the directory.
    const directory = new Map<string, unknown>([
      ['entre-textos/console:flags', consoleCommandKeys('old-app-key-0123456789', 'et').publicKey],
    ]);
    const federation = new FederatedFlagsConsole(
      { et: { partition: 'entre-textos', store: et.store!, controlPlane: { prefix: 'et' } } },
      { db: async () => ({}) as never, redis: async () => redis.duplicate() },
    );
    closers.push(() => federation.close());
    const warnings: string[] = [];
    let mints = 0;
    await federation.authenticate({
      crypto: service.embedded('hub'),
      authkit: hubAuthkit(directory, () => {
        mints++;
        return true;
      }) as never,
      warn: (line) => warnings.push(line),
    });
    for (let i = 0; i < 3; i++) {
      const res = await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable);
      expect(res.status).toBe(200);
    }
    expect(service.calls.filter((c) => c.op === 'encrypt')).toHaveLength(3);
    // The failing mint happened once: the decision switched to crypto for 5 minutes, and the
    // crypto commands did not mint their optional token again inside that window.
    expect(mints).toBe(1);
    const now = Date.now;
    Date.now = () => now() + 5 * 60_000 + 1;
    try {
      const res = await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable);
      expect(res.status).toBe(200);
    } finally {
      Date.now = now;
    }
    // After 5 minutes the directory is read again (token), the mint is tried again (fails again).
    expect(mints).toBe(2);
    expect(warnings).toEqual([
      '[@adonis-agora/flags] console commands to "entre-textos": sending without an authkit app-call token (crypto only): invalid_target (503). To attach it: grant the console\'s service client flags:console:* on "entre-textos" in authkit.',
    ]);
  });

  it('§13b: end to end, the command goes crypto-only when the token fails', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    const et = await appRuntime('entre-textos');
    const answer = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'et',
      actions: true,
      runtime: () => et,
      crypto: { cipher: service.tenant('entre-textos', ['crypto:decrypt:console-*']).operations },
    });
    closers.push(() => answer.close());
    const federation = new FederatedFlagsConsole(
      { et: { partition: 'entre-textos', store: et.store!, controlPlane: { prefix: 'et' } } },
      { db: async () => ({}) as never, redis: async () => redis.duplicate() },
    );
    closers.push(() => federation.close());
    const warnings: string[] = [];
    const authkit = hubAuthkit(new Map(), () => true);
    delete (authkit as { appKey?: unknown }).appKey;
    await federation.authenticate({
      crypto: service.embedded('hub'),
      authkit: authkit as never,
      warn: (line) => warnings.push(line),
    });
    const res = await federation.dispatch('et', 'setEnabled', { actor: { id: 'ops' } }, enable);
    expect(res.status).toBe(200);
    expect(warnings).toEqual([
      expect.stringContaining('sending without an authkit app-call token'),
    ]);
  });

  it('§13d: the boot error mentions authkit', () => {
    expect(resolveAppConsoleAuth({ option: { crypto: false }, hasAppKey: false }).error).toBe(
      "[@adonis-agora/flags] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key console-flags), or configure authkit-client's `service` (automatic: the console uses an authkit app-call token; grant it flags:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). Run `node ace agora:doctor` to see every Agora lib's console auth at once. Docs: https://davidecarvalho.github.io/agora/docs/flags/federated-console#authenticating-the-console Note: `crypto: false` turned the automatic crypto mode off.",
    );
  });

  it('§13e: quiet when crypto is enough; a warning when token mode is the only way and no directory', async () => {
    const previous = process.env.APP_KEY;
    process.env.APP_KEY = 'app-key-of-entre-textos-0123456789';
    try {
      const published: unknown[] = [];
      const withCrypto = await bootApp({
        config: etConfig(),
        redis: new FakePubSubRedis(),
        crypto: new FakeCryptoService().embedded('entre-textos'),
        authkit: {
          ...fakeAuthkit({}),
          publishAppKey: async (input: unknown) => {
            published.push(input);
          },
        } as never,
      });
      expect(published).toHaveLength(0);
      expect(withCrypto.warnings.join('\n')).not.toMatch(/publish|service/);
      // authkit only, without its `service` (no publishAppKey): token mode is the only way.
      const tokenOnly = await bootApp({
        config: etConfig(),
        redis: new FakePubSubRedis(),
        authkit: fakeAuthkit({}) as never,
      });
      expect(tokenOnly.warnings).toContainEqual(
        expect.stringContaining("token mode is this app's only way to be reached"),
      );
      // Explicit crypto whose commands must carry a token (crypto + verifyTenant, migrating):
      // published, like config.
      const service = new FakeCryptoService();
      const migrating = await bootApp({
        config: etConfig({
          crypto: { cipher: service.embedded('entre-textos').operations },
          verifyTenant: async () => null,
        }),
        redis: new FakePubSubRedis(),
        authkit: {
          ...fakeAuthkit({}),
          publishAppKey: async (input: unknown) => {
            published.push(input);
          },
        } as never,
      });
      expect(published).toHaveLength(1);
      expect((published[0] as { purpose: string }).purpose).toBe('console:flags');
      expect(migrating.warnings.join('\n')).not.toMatch(/only way to be reached/);
    } finally {
      if (previous === undefined) delete process.env.APP_KEY;
      else process.env.APP_KEY = previous;
    }
  });

  it('§13f: hasKey replaces the decrypt probe when crypto has it', async () => {
    const service = new FakeCryptoService();
    const tenant = service.tenant('entre-textos', ['crypto:decrypt:console-*']);
    let decrypts = 0;
    const decrypt = tenant.operations.decrypt;
    tenant.operations.decrypt = async (input) => {
      decrypts += 1;
      return decrypt(input);
    };
    delete (tenant.operations as { createKey?: unknown }).createKey;
    tenant.operations.hasKey = async () => false;
    expect((await checkTenantConsoleKey(tenant))?.level).toBe('info');
    tenant.operations.hasKey = async () => true;
    expect(await checkTenantConsoleKey(tenant)).toBeUndefined();
    expect(decrypts).toBe(0);
    // A refusal from hasKey is the "no permission" outcome, without a decrypt.
    tenant.operations.hasKey = async () => {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    };
    expect((await checkTenantConsoleKey(tenant))?.line).toContain('refused this app');
    expect(decrypts).toBe(0);
    // An older crypto server without the route: fall back to the decrypt probe.
    tenant.operations.hasKey = async () => {
      throw Object.assign(new Error('Cannot GET /v1/keys/console-flags/exists'), { status: 404 });
    };
    await checkTenantConsoleKey(tenant);
    expect(decrypts).toBe(1);
    // No hasKey at all: the decrypt probe too.
    delete tenant.operations.hasKey;
    await checkTenantConsoleKey(tenant);
    expect(decrypts).toBe(2);
  });
});

describe('§13b log level', () => {
  it('a missing grant is info; any other failure is a warning (same wording)', async () => {
    const lines: Array<{ level: string; line: string }> = [];
    const tokenFailing = (reason: string, code?: string) =>
      optionalAppCallToken(
        async () => {
          throw Object.assign(new Error(reason), code ? { code } : {});
        },
        'entre-textos',
        (line) => lines.push({ level: 'warn', line }),
        Date.now,
        (line) => lines.push({ level: 'info', line }),
      );
    expect(await tokenFailing('invalid_target (503)', 'invalid_target').get()).toBe('');
    expect(await tokenFailing('the console is not granted this app').get()).toBe('');
    expect(await tokenFailing('No grant for this client').get()).toBe('');
    expect(
      await tokenFailing('authkit answered 400: invalid_target (urn:agora:app:shop)').get(),
    ).toBe('');
    // Only those: a bad client or an unreachable authkit warn.
    expect(await tokenFailing('client rejected', 'unauthorized_client').get()).toBe('');
    expect(await tokenFailing('client unknown', 'invalid_client').get()).toBe('');
    expect(await tokenFailing('authkit unreachable (ECONNREFUSED)').get()).toBe('');
    const hint =
      'To attach it: grant the console\'s service client flags:console:* on "entre-textos" in authkit.';
    expect(lines.map((l) => l.level)).toEqual([
      'info',
      'info',
      'info',
      'info',
      'warn',
      'warn',
      'warn',
    ]);
    expect(lines[0]).toEqual({
      level: 'info',
      line: `[@adonis-agora/flags] console commands to "entre-textos": sending without an authkit app-call token (crypto only): invalid_target (503). ${hint}`,
    });
    expect(lines[6]).toEqual({
      level: 'warn',
      line: `[@adonis-agora/flags] console commands to "entre-textos": sending without an authkit app-call token (crypto only): authkit unreachable (ECONNREFUSED). ${hint}`,
    });
  });
});

describe('§13b log level on the §13a token→crypto path', () => {
  it('a token refused for a missing grant (code invalid_target) is info there too', async () => {
    const service = new FakeCryptoService();
    const redis = new FakePubSubRedis();
    const et = await createRuntime(
      defineConfig({
        app: 'entre-textos',
        flags: { beta: flag.boolean({ default: false }) },
        store: stores.memory({ production: { flags: {} } }),
        transport: transports.memory(),
      }),
      lucidContext(undefined),
      { logger: quietLogger, runWorker: false },
    );
    closers.push(() => et.close());
    const answer = await answerConsoleCommands({
      client: redis.duplicate(),
      prefix: 'et',
      actions: true,
      runtime: () => et,
      crypto: { cipher: service.tenant('entre-textos', ['crypto:decrypt:console-*']).operations },
    });
    closers.push(() => answer.close());
    const directory = new Map<string, unknown>([
      ['entre-textos/console:flags', consoleCommandKeys('old-app-key-0123456789', 'et').publicKey],
    ]);
    const federation = new FederatedFlagsConsole(
      { et: { partition: 'entre-textos', store: et.store!, controlPlane: { prefix: 'et' } } },
      { db: async () => ({}) as never, redis: async () => redis.duplicate() },
    );
    closers.push(() => federation.close());
    const infos: string[] = [];
    const warnings: string[] = [];
    await federation.authenticate({
      crypto: service.embedded('hub'),
      authkit: {
        appCallTokens: () => ({
          token: async () => {
            throw Object.assign(new Error('invalid_target'), { code: 'invalid_target' });
          },
        }),
        appKey: async ({ app, purpose }: { app: string; purpose: string }) =>
          (directory.get(`${app}/${purpose}`) as never) ?? null,
      } as never,
      warn: (line) => warnings.push(line),
      info: (line) => infos.push(line),
    });
    const res = await federation.dispatch(
      'et',
      'setEnabled',
      { actor: { id: 'ops' } },
      { params: { key: 'beta' }, query: {}, body: { enabled: true } },
    );
    expect(res.status).toBe(200);
    expect(warnings.filter((w) => w.includes('sending without'))).toEqual([]);
    expect(infos).toContainEqual(
      expect.stringContaining(
        'sending without an authkit app-call token (crypto only): invalid_target.',
      ),
    );
  });
});
