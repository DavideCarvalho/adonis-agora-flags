import { randomUUID } from 'node:crypto';
import type { Ruleset } from '@adonis-agora/flags-core';
import { consume, loadPeer, sleep } from './common.js';
import { byteLength, createMessage, DEFAULT_MAX_MESSAGE_BYTES } from './message.js';
import type {
  ControlPlaneLinkContext,
  RulesetChannel,
  TenantLinkContext,
  WatchTransport,
} from './types.js';

/** The workflow the control-plane registers and tenants start, one run per message. */
export const TENANT_MESSAGE_WORKFLOW = 'flags.tenant.message';

/** The slice of durable's `WorkflowEngine` this driver uses. */
export interface DurableTenantEngine {
  register(
    name: string,
    version: string,
    fn: (ctx: unknown, input: never) => Promise<unknown>,
    opts?: { origin?: string },
  ): void;
  start(workflow: string, input: unknown, runId: string): Promise<unknown>;
  waitForRun(
    runId: string,
    opts?: { timeoutMs?: number; terminal?: boolean },
  ): Promise<{ status: string; output?: unknown; error?: { message?: string } | undefined }>;
}

/** The slice of durable's `ControlPlane` (broadcast) this driver uses. */
export interface DurableBroadcast {
  publishControl(msg: never): Promise<void>;
  onControl(handler: (msg: { kind: string; from?: string }) => void): void;
  close?(): Promise<void>;
}

type BroadcastOption =
  | DurableBroadcast
  | ((ctx: { app: unknown }) => Promise<DurableBroadcast>)
  | false;

export interface DurableTenantTransportOptions {
  /**
   * The broadcast that tells tenants the ruleset changed: durable's `controlPlanes.redis(...)` or a
   * `ControlPlane`. Default: the `controlPlane` of `config/durable.ts`; `false` to only poll.
   */
  controlPlane?: BroadcastOption;
  /** The engine, outside AdonisJS. Default: durable's `WorkflowEngine` from the container. */
  engine?: DurableTenantEngine;
  /** How long a tenant waits for its ruleset run (ms). Default 30000. */
  timeoutMs?: number;
  /** Largest message accepted (bytes). Default 1 MiB. */
  maxMessageBytes?: number;
  /** Control-plane: attempts per message before it is dead-lettered. Default 5. */
  maxAttempts?: number;
}

interface DurableModule {
  WorkflowEngine: abstract new (...args: never[]) => unknown;
}

async function engineOf(
  options: DurableTenantTransportOptions,
  ctx: { app?: TenantLinkContext['app'] },
): Promise<DurableTenantEngine> {
  if (options.engine) return options.engine;
  const durable = await loadPeer<DurableModule>('@adonis-agora/durable', 'durable');
  const container = ctx.app?.container;
  if (!container?.hasBinding(durable.WorkflowEngine as never))
    throw new Error(
      '[flags] the "durable" tenant transport needs @adonis-agora/durable with its provider registered',
    );
  return (await container.make(durable.WorkflowEngine as never)) as DurableTenantEngine;
}

async function broadcastOf(
  options: DurableTenantTransportOptions,
  ctx: { app?: TenantLinkContext['app'] },
): Promise<{ broadcast?: DurableBroadcast; owned: boolean }> {
  let option = options.controlPlane;
  if (option === false) return { owned: false };
  if (option === undefined) {
    option = ctx.app?.config.get<{ controlPlane?: BroadcastOption } | undefined>(
      'durable',
    )?.controlPlane;
    if (!option) return { owned: false };
  }
  // Built from a factory: a connection of our own, closed with the link.
  if (typeof option === 'function')
    return { broadcast: await option({ app: ctx.app }), owned: true };
  return { broadcast: option, owned: false };
}

const BROADCAST_KIND = 'flags.ruleset';

/**
 * Tenant messages as durable runs (retried, visible in the durable console); the ruleset fetched by
 * a run, with changes announced on durable's control plane. Both apps run on the same durable
 * cluster. Needs `@adonis-agora/durable`.
 */
export function durableTransport(options: DurableTenantTransportOptions = {}): WatchTransport {
  const maxBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const start = async (
    engine: DurableTenantEngine,
    ctx: TenantLinkContext,
    kind: 'events' | 'usage' | 'declarations' | 'ruleset',
    body: unknown,
  ) => {
    const message = createMessage(kind, ctx.partition, await ctx.token.get(), body);
    if (byteLength(JSON.stringify(message)) > maxBytes)
      throw new Error(`[flags] message exceeds ${maxBytes} bytes`);
    const runId = `flags-${message.id}`;
    await engine.start(TENANT_MESSAGE_WORKFLOW, message, runId);
    return runId;
  };
  return {
    driver: 'durable',
    canWatch: true,
    // Registers a workflow: `node ace durable:work` must see it too.
    passive: true,
    async push(ctx) {
      const engine = await engineOf(options, ctx);
      return {
        driver: 'durable',
        maxBytes,
        async send(kind, body) {
          await start(engine, ctx, kind, body);
        },
      };
    },
    async watch(ctx) {
      const engine = await engineOf(options, ctx);
      const { broadcast } = await broadcastOf(options, ctx);
      const channel: RulesetChannel = {
        driver: 'durable',
        async fetch(knownVersion) {
          const runId = await start(engine, ctx, 'ruleset', {
            ...(knownVersion !== undefined ? { version: knownVersion } : {}),
            capabilities: ctx.capabilities ?? [],
          });
          const result = await engine.waitForRun(runId, {
            terminal: true,
            timeoutMs: options.timeoutMs ?? 30_000,
          });
          if (result.status !== 'completed')
            throw new Error(
              `ruleset run ${result.status}${result.error?.message ? `: ${result.error.message}` : ''}`,
            );
          return ((result.output as { ruleset?: Ruleset | null } | undefined)?.ruleset ??
            null) as Ruleset | null;
        },
        ...(broadcast
          ? {
              subscribe(listener) {
                let active = true;
                broadcast.onControl((msg) => {
                  if (active && msg.kind === BROADCAST_KIND) listener.changed();
                });
                listener.connected(true);
                return () => {
                  active = false;
                  listener.connected(false);
                };
              },
            }
          : {}),
      };
      return channel;
    },
    async serve(ctx: ControlPlaneLinkContext) {
      const engine = await engineOf(options, ctx);
      const { broadcast, owned } = await broadcastOf(options, ctx);
      const from = `flags-cp-${randomUUID().slice(0, 8)}`;
      const watching = new Map<string, () => void>();
      const maxAttempts = options.maxAttempts ?? 5;
      const announce = (environment: string) => {
        if (!broadcast || watching.has(environment)) return;
        watching.set(
          environment,
          ctx.handler.watchEnvironment(environment, (ruleset) => {
            void broadcast
              .publishControl({ kind: BROADCAST_KIND, version: ruleset.version, from } as never)
              .catch((error: unknown) =>
                ctx.logger?.warn(`[flags] durable ruleset broadcast: ${(error as Error).message}`),
              );
          }),
        );
      };
      engine.register(
        TENANT_MESSAGE_WORKFLOW,
        '1',
        async (_run, input: never) => {
          for (let attempt = 1; ; attempt++) {
            try {
              const handled = await consume(ctx.handler, 'durable', input, {
                attempt,
                maxAttempts,
              });
              if (!handled) throw Object.assign(new Error('dead-lettered'), { dead: true });
              if (handled.message.kind === 'ruleset') {
                announce(handled.environment);
                return { ruleset: handled.ruleset ?? null };
              }
              return { status: handled.status };
            } catch (error) {
              if ((error as { dead?: boolean }).dead) throw error;
              await sleep(Math.min(200 * 2 ** attempt, 10_000));
            }
          }
        },
        { origin: '@adonis-agora/flags' },
      );
      return {
        driver: 'durable',
        async close() {
          for (const stop of watching.values()) stop();
          watching.clear();
          if (owned) await broadcast?.close?.().catch(() => {});
        },
      };
    },
  };
}
