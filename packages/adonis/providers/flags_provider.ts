import type { ApplicationService } from '@adonisjs/core/types';
import type { FlagsConfig } from '../src/define_config.js';
import { type DurableEngineLike, registerDurableWorkflows } from '../src/durable.js';
import { ControlPlane } from '../src/http/control_plane.js';
import { registerEdgeTag } from '../src/http/edge_tag.js';
import type { FlagsManager } from '../src/manager.js';
import { createRuntime, type FlagsRuntime } from '../src/runtime.js';
import { setRuntime } from '../src/services/accessor.js';
import type { SqlDatabase } from '../src/sql.js';
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

  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton('flags.runtime', () => this.#build());
    this.app.container.singleton('flags.manager', async () => (await this.#build()).manager);
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
          async db(connection?: string) {
            if (!lucid) throw new Error('@adonisjs/lucid is not configured');
            const db = (await container.make('lucid.db')) as unknown as {
              connection(name?: string): SqlDatabase;
            };
            return db.connection(connection);
          },
          async redis(connection?: string) {
            if (!container.hasBinding('redis'))
              throw new Error('@adonisjs/redis is not configured');
            const redis = (await container.make('redis')) as unknown as {
              connection(name?: string): { ioConnection: RedisStreamClient };
            };
            return redis.connection(connection).ioConnection;
          },
          autoCreateSchema: (config as { autoCreateSchema?: boolean }).autoCreateSchema ?? true,
          partitionEvents: (config as { partitionEvents?: boolean }).partitionEvents ?? false,
        },
        {
          logger,
          // Timers run in servers and tests; one-shot ace commands only read and write.
          start: true,
          runWorker: false,
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
      const runtime = await this.#build();
      const config = this.#config();
      // `@flag` in Edge views, when the app renders Edge at all.
      await registerEdgeTag();
      if (config.topology === 'control-plane' && runtime.role !== 'worker') {
        const router = await this.app.container.make('router');
        new ControlPlane(runtime, config.controlPlane).register(router as never);
      }
    });
  }

  async shutdown() {
    await this.#runtime?.close();
    setRuntime(undefined);
    this.#runtime = undefined;
    this.#building = undefined;
  }
}
