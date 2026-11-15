import type { Ruleset } from '@adonis-agora/flags-core';
import type { ApplicationService } from '@adonisjs/core/types';
import type { TokenSource } from '../topology/token.js';
import type { VerifiedTenant } from '../topology/verify.js';
import type { DeadLetter, MessageDedupe, TenantMessage, TenantMessageKind } from './message.js';

/** The logger slice drivers use. */
export interface LinkLogger {
  info?(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** What a driver gets on a tenant. */
export interface TenantLinkContext {
  app?: ApplicationService | undefined;
  /** `tenant.url`, when set. */
  url?: string | undefined;
  partition: string;
  token: TokenSource;
  /** Advertised capabilities (`tenant.capabilities`). */
  capabilities?: string[] | undefined;
  logger?: LinkLogger | undefined;
  /** A raw ioredis connection from `config/redis.ts` (`@adonisjs/redis`). */
  redis(connection?: string): Promise<unknown>;
}

/** What a driver gets on the control-plane. */
export interface ControlPlaneLinkContext {
  app?: ApplicationService | undefined;
  logger?: LinkLogger | undefined;
  redis(connection?: string): Promise<unknown>;
  /** Handles every message the driver receives. */
  handler: TenantMessageHandler;
}

/** Push channel on a tenant: events, usage and declarations go out through `send`. */
export interface TenantPush {
  readonly driver: string;
  /** Largest serialized message the driver accepts. Events are split to fit. */
  readonly maxBytes: number;
  send(kind: Exclude<TenantMessageKind, 'ruleset'>, body: unknown): Promise<void>;
  /** Doctor: throws when the broker (or the control-plane) is unreachable. */
  check?(): Promise<void>;
  close?(): Promise<void>;
}

/** Callbacks a watch channel reports to. */
export interface RulesetChannelListener {
  /** Something changed on the control-plane: fetch again. */
  changed(): void;
  /** The push connection went up (`true`) or down (`false`). */
  connected(up: boolean): void;
  error(error: unknown): void;
}

/** Watch channel on a tenant: how it gets its ruleset and hears about changes. */
export interface RulesetChannel {
  readonly driver: string;
  /** The ruleset, or `null` when it is still `knownVersion`. Throws when unreachable. */
  fetch(knownVersion: string | undefined): Promise<Ruleset | null>;
  /** Push notifications. Without it the source polls. Returns a stop function. */
  subscribe?: ((listener: RulesetChannelListener) => () => void) | undefined;
  check?(): Promise<void>;
  close?(): Promise<void>;
}

/** The control-plane side of a driver: consumes tenant messages, publishes ruleset changes. */
export interface ControlPlaneLink {
  readonly driver: string;
  check?(): Promise<void>;
  close?(): Promise<void>;
}

/** What `handle` answers for a message that was applied. */
export interface HandledMessage {
  status: 'ok' | 'duplicate';
  message: TenantMessage;
  verified: VerifiedTenant;
  /** The verified environment. */
  environment: string;
  /** `ruleset` messages: the ruleset, or `null` when the tenant already has this version. */
  ruleset?: Ruleset | null;
}

/**
 * The control-plane's message entry point, shared by every broker driver. Verifies the token of
 * every message, takes partition / environment / capabilities from the verified token only, dedupes
 * and applies. Throws {@link PoisonMessageError} for messages that can never succeed (the driver
 * dead-letters them through `deadLetter`) and any other error for transient failures (retry).
 */
export interface TenantMessageHandler {
  readonly maxMessageBytes: number;
  handle(
    raw: unknown,
    driver: string,
    options?: { dedupe?: MessageDedupe | undefined },
  ): Promise<HandledMessage>;
  deadLetter(letter: Omit<DeadLetter, 'at'>): Promise<void>;
  /** Calls `listener` with the ruleset of `environment` each time it changes. */
  watchEnvironment(environment: string, listener: (ruleset: Ruleset) => void): () => void;
  /** The current ruleset of `environment`. */
  ruleset(environment: string): Promise<Ruleset>;
}

/**
 * A tenant ↔ control-plane transport (`tenantTransports.*`). Configure the same driver on both
 * sides: `tenant.transport` on the app, `controlPlane.transports` on the flags server.
 */
export interface TenantTransport {
  readonly driver: 'http' | 'queue' | 'bullmq' | 'redis' | 'durable';
  /** Whether it can carry the ruleset (`tenant.watch`). */
  readonly canWatch: boolean;
  /**
   * The control-plane side holds no connection or loop of its own (`queue`: your queue workers run
   * the jobs), so it is served in ace commands too (`node ace queue:work`).
   */
  readonly passive?: boolean;
  push(ctx: TenantLinkContext): Promise<TenantPush>;
  watch?(ctx: TenantLinkContext): Promise<RulesetChannel>;
  /** The control-plane side. */
  serve(ctx: ControlPlaneLinkContext): Promise<ControlPlaneLink>;
}

/** A transport that also carries the ruleset: the only kind `tenant.watch` accepts. */
export interface WatchTransport extends TenantTransport {
  readonly canWatch: true;
  watch(ctx: TenantLinkContext): Promise<RulesetChannel>;
}

/** A push-only transport (`queue`, `bullmq`). */
export interface PushTransport extends TenantTransport {
  readonly canWatch: false;
}
