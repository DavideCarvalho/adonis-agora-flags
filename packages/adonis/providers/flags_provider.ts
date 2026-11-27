import { readFileSync } from 'node:fs';
import type { ApplicationService } from '@adonisjs/core/types';
import type { FlagsConfig } from '../src/define_config.js';
import { type DurableEngineLike, registerDurableWorkflows } from '../src/durable.js';
import {
  answerConsoleCommands,
  consoleCommandKeys,
  resolveConsoleCommands,
} from '../src/federation/console.js';
import {
  authkitClientOf,
  CONSOLE_KEY_PURPOSE,
  ConsoleAuthConfigError,
  cryptoRuntimeOf,
  embeddedKeyGuard,
  publicHalf,
  publicKeyId,
  publishesTokenKey,
  resolveAppConsoleAuth,
  watchTenantConsoleKey,
} from '../src/federation/console_auth.js';
import type { RedisConsoleChannel, RedisLike } from '../src/federation/redis_channel.js';
import { appKeyOf, browserSecret, registerBrowser, releaseSecret } from '../src/http/browser.js';
import { ControlPlane } from '../src/http/control_plane.js';
import { registerEdgeTag } from '../src/http/edge_tag.js';
import type { FlagsManager } from '../src/manager.js';
import { createRuntime, type FlagsRuntime } from '../src/runtime.js';
import { setRuntime } from '../src/services/accessor.js';
import type { SqlDatabase } from '../src/sql.js';
import { TenantConfigError } from '../src/topology/authkit_tenant.js';
import { resolveTenantVerifier, type VerifierMaker } from '../src/topology/verify.js';
import type { RedisStreamClient } from '../src/transports/redis_transport.js';

declare module '@adonisjs/core/types' {
  interface ContainerBindings {
    'flags.manager': FlagsManager;
    'flags.runtime': FlagsRuntime;
  }
}

/**
 * Builds the flags runtime from `config/flags.ts` once the app has booted, publishes it to the
 * container (`flags.manager`, `flags.runtime`) and to `services/main`, mounts the control-plane
 * routes, and decides where background work runs:
 *
 * - `role: 'api'` — never runs background work.
 * - `dispatcher: 'durable'` (or `auto` with the durable provider registered) — registers durable
 *   workflows and schedules; the durable worker runs them.
 * - `dispatcher: 'in-process'` (or `auto` without durable) — a timer in each web/worker process;
 *   leases make concurrent replicas safe.
 * - Ace commands never start the loop, except `node ace flags:work`.
 */
export default class FlagsProvider {
  #runtime: FlagsRuntime | undefined;
  #building: Promise<FlagsRuntime> | undefined;
  #controlPlane: ControlPlane | undefined;
  #consoleCommands: RedisConsoleChannel | undefined;
  /** Set during `boot()` when `consoleCommands` resolved: starts the channel in `ready()`. */
  #startConsoleCommands: (() => Promise<void>) | undefined;

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('flags.runtime', () => this.#build());
    this.app.container.singleton('flags.manager', async () => (await this.#build()).manager);
  }

  async #redis(connection?: string): Promise<RedisStreamClient> {
    const container = this.app.container;
    if (!container.hasBinding('redis')) throw new Error('@adonisjs/redis is not configured');
    const redis = (await container.make('redis')) as unknown as {
      connection(name?: string): { ioConnection: RedisStreamClient };
    };
    return redis.connection(connection).ioConnection;
  }

  #config(): FlagsConfig {
    const config = this.app.config.get<FlagsConfig | undefined>('flags');
    if (!config)
      throw new Error('config/flags.ts is missing (node ace configure @adonis-agora/flags)');
    return config;
  }

  #build(): Promise<FlagsRuntime> {
    this.#building ??= (async () => {
      const config = this.#config();
      const container = this.app.container;
      const logger = await container.make('logger');
      const environment = this.app.getEnvironment();
      const ownsState = config.topology !== 'tenant';
      const lucid = ownsState && container.hasBinding('lucid.db');
      const runtime = await createRuntime(
        config,
        {
          app: this.app,
          ...(this.#packageName() ? { appName: this.#packageName() } : {}),
          async db(connection?: string) {
            if (!lucid) throw new Error('@adonisjs/lucid is not configured');
            const db = (await container.make('lucid.db')) as unknown as {
              connection(name?: string): SqlDatabase;
            };
            return db.connection(connection);
          },
          redis: (connection?: string) => this.#redis(connection),
          autoCreateSchema: (config as { autoCreateSchema?: boolean }).autoCreateSchema ?? true,
          partitionEvents: (config as { partitionEvents?: boolean }).partitionEvents ?? false,
        },
        {
          logger,
          // authkit-client's `tenantOf` fills the tenant fields config/flags.ts leaves out.
          container,
          // Timers run in servers and tests; one-shot ace commands only read and write.
          start: true,
          runWorker: false,
          // A held LISTEN connection keeps `db.manager.closeAll()` waiting: ace commands
          // (migration:run, db:seed…) would never exit.
          listen: environment !== 'console' && environment !== 'repl',
          onApplied: () => {},
        },
      );
      this.#runtime = runtime;
      setRuntime(runtime);

      if (
        ownsState &&
        runtime.role !== 'api' &&
        environment !== 'console' &&
        environment !== 'repl'
      ) {
        await this.#startBackground(runtime, logger);
      }
      const realtime = (config as { realtime?: { channel?: string } | boolean }).realtime;
      if (realtime) await this.#realtime(runtime, realtime, logger);
      return runtime;
    })();
    return this.#building;
  }

  async #durableEngine(): Promise<DurableEngineLike | undefined> {
    try {
      const durable = (await import('@adonis-agora/durable')) as unknown as {
        WorkflowEngine: abstract new (...args: never[]) => unknown;
      };
      if (!this.app.container.hasBinding(durable.WorkflowEngine as never)) return undefined;
      return (await this.app.container.make(
        durable.WorkflowEngine as never,
      )) as unknown as DurableEngineLike;
    } catch {
      return undefined;
    }
  }

  async #startBackground(
    runtime: FlagsRuntime,
    logger: { warn(message: string): void; info(message: string): void },
  ) {
    const dispatcher = runtime.config.dispatcher ?? 'auto';
    if (dispatcher !== 'in-process') {
      const engine = await this.#durableEngine();
      if (engine && registerDurableWorkflows(engine, runtime)) {
        logger.info('[flags] background work runs as durable workflows');
        return;
      }
      if (dispatcher === 'durable') {
        throw new Error(
          '[flags] dispatcher "durable" needs @adonis-agora/durable with its provider registered (and a version with registerSchedules)',
        );
      }
    }
    runtime.worker?.start();
  }

  async #realtime(
    runtime: FlagsRuntime,
    realtime: { channel?: string } | boolean,
    logger: { warn(message: string): void },
  ) {
    const channel = (typeof realtime === 'object' && realtime.channel) || 'flags/ruleset';
    try {
      const transmit = (
        (await import('@adonisjs/transmit/services/main')) as unknown as {
          default: { broadcast(channel: string, payload: Record<string, unknown>): void };
        }
      ).default;
      runtime.source.onChange((ruleset) =>
        transmit.broadcast(channel, { version: ruleset.version }),
      );
    } catch {
      logger.warn('[flags] realtime is on but @adonisjs/transmit is not installed/configured');
    }
  }

  async boot() {
    await this.app.booted(async () => {
      let runtime: FlagsRuntime;
      try {
        runtime = await this.#build();
      } catch (error) {
        // A tenant missing url/token/partition fails the boot of a web server only; elsewhere
        // (ace, the REPL, tests) it is logged and `flags.manager` rejects with it when used.
        if (!(error instanceof TenantConfigError) || this.app.getEnvironment() === 'web') {
          throw error;
        }
        const logger = await this.app.container.make('logger');
        logger.warn(error.message);
        return;
      }
      const config = this.#config();
      // `@flag` in Edge views, when the app renders Edge at all.
      await registerEdgeTag();
      const secret = browserSecret(runtime, await this.#appKey());
      let controlPlane: ControlPlane | undefined;
      if (config.topology === 'control-plane') {
        const logger = await this.app.container.make('logger');
        controlPlane = new ControlPlane(
          runtime,
          {
            ...config.controlPlane,
            verifyTenant: config.verifyTenant,
            make: (cls) => this.app.container.make(cls),
            logger,
          },
          secret,
        );
        this.#controlPlane = controlPlane;
        runtime.controlPlane = controlPlane;
        // Brokers tenants talk through (tenantTransports.*). In ace commands only the passive ones
        // (`queue`: `node ace queue:work` runs its jobs); the others hold connections and loops.
        const environment = this.app.getEnvironment();
        // A broker that is down must not take the HTTP routes (browsers, OFREP) down with it.
        try {
          await controlPlane.serveTransports({
            app: this.app,
            redis: (connection) => this.#redis(connection),
            passiveOnly: environment === 'console' || environment === 'repl',
          });
        } catch (error) {
          logger.error(`[flags] tenant transports did not start: ${(error as Error).message}`);
        }
      }
      await this.#answerConsoleCommands(runtime, config);
      if (runtime.role === 'worker') return;
      const router = await this.app.container.make('router');
      // The HTTP routes are mounted whatever tenant transports are configured: browsers, OFREP
      // and HTTP tenants always use them.
      controlPlane?.register(router as never);
      if (config.browser) {
        const logger = await this.app.container.make('logger');
        runtime.browser = registerBrowser(router as never, runtime, {
          secret,
          controlPlane,
          logger,
        });
      }
    });
  }

  /**
   * `consoleCommands`, decided during `boot()`: explicit options, else the sibling libs booted in
   * this app (`@adonis-agora/crypto`, authkit's app calls, a control plane's own `verifyTenant`).
   * None resolving fails the boot of a web server (elsewhere it is logged). The channel itself is
   * started in `ready()`, by a web server only: ace commands, the REPL and tests never open its
   * Redis subscriptions. A Redis that cannot be reached is logged, not fatal.
   */
  async #answerConsoleCommands(runtime: FlagsRuntime, config: FlagsConfig): Promise<void> {
    if (config.topology === 'tenant') return;
    const environment = this.app.getEnvironment();
    if (environment === 'console' || environment === 'repl') return;
    const option = resolveConsoleCommands(config.consoleCommands, runtime.manager.app);
    if (!option) return;
    const logger = await this.app.container.make('logger');
    const make: VerifierMaker = (cls) => this.app.container.make(cls);
    const appKey = releaseSecret(await this.#appKey());
    const fallback =
      config.topology === 'control-plane' && config.verifyTenant !== undefined
        ? resolveTenantVerifier(config.verifyTenant, make)
        : undefined;
    const authkit = await authkitClientOf(this.app.container);
    const auth = resolveAppConsoleAuth({
      option,
      fallbackVerifyTenant: fallback,
      crypto: option.crypto === undefined ? await cryptoRuntimeOf(this.app.container) : undefined,
      authkit: option.verifyTenant === undefined ? authkit : undefined,
      hasAppKey: !!appKey && appKey.length >= 16,
      ...(appKey && appKey.length >= 16
        ? { tokenKeyId: publicKeyId(consoleCommandKeys(appKey, option.prefix).publicKey) }
        : {}),
    });
    if (auth.error) {
      // Only a web server fails its boot (§6); elsewhere (tests, workers) it is logged.
      if (environment === 'web') throw new ConsoleAuthConfigError(auth.error);
      logger.warn(auth.error);
      return;
    }
    let crypto = auth.crypto;
    if (auth.autoCrypto && crypto) {
      // Making sure of the key never fails the boot: one line to act on, retried on first use.
      const { runtime: cryptoRuntime, key } = auth.autoCrypto;
      const note = (n: { level: 'info' | 'warn'; line: string }) =>
        n.level === 'warn' ? logger.warn(n.line) : logger.info(n.line);
      if (cryptoRuntime.service) {
        const guard = embeddedKeyGuard(cryptoRuntime.service, cryptoRuntime.partition, key);
        await guard.boot({
          warn: (line) => logger.warn(line),
          info: (line) => logger.info(line),
        });
        crypto = { ...crypto, cipher: guard.wrap(cryptoRuntime.operations) };
      } else {
        // A crypto tenant: checked once at boot; afterwards a command's own decrypt is the retry.
        const watch = watchTenantConsoleKey(cryptoRuntime, note, key);
        await watch.atBoot();
        crypto = {
          ...crypto,
          cipher: { encrypt: cryptoRuntime.operations.encrypt, decrypt: watch.decrypt },
        };
      }
    }
    const verifyTenant =
      auth.verifyTenant === undefined ? undefined : resolveTenantVerifier(auth.verifyTenant, make);
    const keys = auth.appKeySealed ? consoleCommandKeys(appKey!, option.prefix) : undefined;
    // Token mode: publish the public half in authkit's key directory (§2e.B), so consoles find it
    // without copying it. Background and retried by authkit-client; never fails the boot. With
    // crypto active, crypto is enough: nothing is published (a console then picks crypto, §13a)
    // and nothing is said (§13e; the doctor shows it), unless crypto commands must carry a token
    // too (explicit crypto + verifyTenant, migrating): config's rule.
    if (keys && publishesTokenKey(auth)) {
      if (typeof authkit?.publishAppKey === 'function') {
        authkit
          .publishAppKey({ purpose: CONSOLE_KEY_PURPOSE, jwk: publicHalf(keys.publicKey) })
          .catch(() => undefined);
      } else if (!auth.crypto && auth.secret === undefined) {
        // Token mode is this app's only way to be reached, and no console can find its key.
        logger.warn(
          "[@adonis-agora/flags] console commands: token mode is this app's only way to be reached, but authkit-client's `service` is not configured, so its key is not in authkit's key directory: configure it, or give each console controlPlane.publicKey (`node ace flags:console-key` prints it)",
        );
      }
    }
    const actions = option.actions
      ? 'actions on'
      : 'actions off (set consoleCommands.actions to let the console act)';
    // Never the public key's material: its short id is in the token label (`node ace
    // flags:console-key` prints the key).
    logger.info(`[@adonis-agora/flags] console commands: ${auth.modes.join(' + ')}; ${actions}`);
    const rejected = new Set<string>();
    this.#startConsoleCommands = async () => {
      try {
        this.#consoleCommands = await answerConsoleCommands({
          client: (await this.#redis(option.connection)) as unknown as RedisLike,
          prefix: option.prefix,
          actions: option.actions,
          runtime: () => runtime,
          ...(auth.secret !== undefined ? { secret: auth.secret } : {}),
          ...(crypto !== undefined ? { crypto } : {}),
          ...(verifyTenant ? { verifyTenant, cryptoTokenRequired: auth.cryptoTokenRequired } : {}),
          ...(keys ? { keys } : {}),
          log: (line) => logger.info(line),
          // A refused or garbage message is dropped, and logged once per reason (§11b).
          onError: (error) => {
            const reason = (error as { reason?: unknown } | null)?.reason;
            const text = error instanceof Error ? error.message : String(error);
            const key = typeof reason === 'string' ? reason : text;
            if (rejected.has(key)) return;
            if (rejected.size < 100) rejected.add(key);
            if (typeof reason === 'string') logger.warn(text);
            else logger.error(`[@adonis-agora/flags] console commands: a command failed: ${text}`);
          },
        });
      } catch (error) {
        logger.error(
          `[@adonis-agora/flags] consoleCommands: not answering other consoles: ${(error as Error).message}`,
        );
      }
    };
  }

  /** Starts the console command channel: a web server only, once it is ready. */
  async ready() {
    if (this.app.getEnvironment() !== 'web') return;
    const start = this.#startConsoleCommands;
    this.#startConsoleCommands = undefined;
    await start?.();
  }

  /**
   * The app's name from its package.json (`@acme/shop` → `shop`). AdonisJS 7's `appName` is always
   * `adonisjs_app`, which would tag every app on a control-plane alike.
   */
  #packageName(): string | undefined {
    try {
      const raw = readFileSync(this.app.makePath('package.json'), 'utf8');
      const name = (JSON.parse(raw) as { name?: unknown }).name;
      if (typeof name !== 'string' || !name) return undefined;
      return name.replace(/^@[^/]+\//, '');
    } catch {
      return undefined;
    }
  }

  /** The app key (see {@link appKeyOf}). */
  #appKey(): Promise<unknown> {
    return appKeyOf(this.app);
  }

  async shutdown() {
    this.#startConsoleCommands = undefined;
    await this.#consoleCommands?.close();
    this.#consoleCommands = undefined;
    await this.#controlPlane?.close();
    this.#controlPlane = undefined;
    await this.#runtime?.close();
    setRuntime(undefined);
    this.#runtime = undefined;
    this.#building = undefined;
  }
}
