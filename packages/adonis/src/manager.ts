import {
  type EvaluateOptions,
  type EvaluationContext,
  type EvaluationDetails,
  evaluate,
  type JsonValue,
  type Ruleset,
} from '@adonis-agora/flags-core';
import type { FlagsAdmin } from './admin.js';
import { type ExperimentResults, HOLDOUT_VARIANT } from './analytics/results.js';
import type { FlagDeclaration } from './declare.js';
import { type Enricher, runEnrichers } from './enrichers.js';
import type { EventBuffer } from './events/buffer.js';
import { EVENT_SCHEMA_VERSION, exposureId, type FlagEvent, uuidv7 } from './events/event.js';
import type { RulesetSource } from './ruleset_source.js';
import type { SqlClient } from './sql.js';
import { type Subject, type SubjectLike, toContext, toSubject } from './subject.js';
import type { Transport } from './transports/transport.js';
import type { BooleanFlagKey, FlagKey, FlagValue } from './types.js';
import type { UsageCounter } from './usage.js';

export interface TrackOptions {
  /** Numeric value (revenue, duration). */
  value?: number;
  props?: Record<string, unknown>;
  /**
   * A Lucid transaction: with the `db` transport the event commits or rolls back with it. Other
   * transports send it after the transaction commits.
   */
  client?: SqlClient & { after?(event: 'commit', handler: () => void | Promise<void>): void };
}

export interface ManagerDeps {
  app: string;
  environment: string;
  declarations: Record<string, FlagDeclaration>;
  source: RulesetSource;
  buffer?: EventBuffer;
  transport?: Transport;
  enrichers?: Enricher[];
  usage?: UsageCounter;
  /** Sticky assignments of a subject: flag key → variant (from the exposures table). */
  sticky?: (subject: string) => Promise<Record<string, string>>;
  /** Extra targeting attributes resolved for every subject (plan, org, …). */
  attributes?: (subject: Subject) => Record<string, unknown> | Promise<Record<string, unknown>>;
  admin?: FlagsAdmin;
  results?: (experiment: string, environment?: string) => Promise<ExperimentResults | null>;
  forget?: (subject: string) => Promise<void>;
  logger?: { warn(message: string): void; error(message: string): void };
}

type Overrides = Map<string, JsonValue>;

/**
 * The entry point: `flags.for(user).enabled('new_player')`. Evaluation is in memory against the
 * ruleset the source keeps fresh; nothing here waits on the database except an opt-in sticky lookup
 * (once per scope).
 */
export class FlagsManager {
  #fakes: Overrides | undefined;
  #warnedTransactional = false;

  constructor(readonly deps: ManagerDeps) {}

  get environment() {
    return this.deps.environment;
  }

  get app() {
    return this.deps.app;
  }

  get admin(): FlagsAdmin {
    if (!this.deps.admin) {
      throw new Error(
        'flags admin is not available here (a tenant edits flags on its control-plane)',
      );
    }
    return this.deps.admin;
  }

  get declarations() {
    return this.deps.declarations;
  }

  /** The ruleset this process evaluates against. */
  ruleset(): Ruleset {
    return this.deps.source.current();
  }

  status() {
    return {
      app: this.deps.app,
      environment: this.deps.environment,
      source: this.deps.source.status(),
      buffer: this.deps.buffer
        ? {
            pending: this.deps.buffer.pending,
            published: this.deps.buffer.published,
            dropped: this.deps.buffer.dropped,
          }
        : null,
      transport: this.deps.transport
        ? { name: this.deps.transport.name, ...this.deps.transport.capabilities }
        : null,
    };
  }

  /** Reloads the ruleset now (after an edit in this process, or from a command). */
  refresh() {
    return this.deps.source.refresh();
  }

  /** A scope for one subject. In HTTP handlers prefer `ctx.flags`, which the middleware builds. */
  for(subject?: SubjectLike, attributes: Record<string, unknown> = {}): FlagsScope {
    return new FlagsScope(this, toSubject(subject), attributes);
  }

  /** A scope whose subject is resolved on the first flag read. */
  forLazy(
    resolve: () => Promise<SubjectLike> | SubjectLike,
    attributes: Record<string, unknown> = {},
  ): FlagsScope {
    return new FlagsScope(this, resolve, attributes);
  }

  /** The default value declared in code (or `undefined` for undeclared keys). */
  declaredDefault(key: string): JsonValue | undefined {
    return this.deps.declarations[key]?.default;
  }

  /** @internal Evaluation with fakes, usage counting and enrichers. */
  evaluateFor<T extends JsonValue>(
    key: string,
    fallback: T,
    context: EvaluationContext,
    options: EvaluateOptions,
  ): EvaluationDetails<T> {
    this.deps.usage?.hit(key);
    const fake = this.#fakes;
    let details: EvaluationDetails<T>;
    if (fake?.has(key)) {
      details = {
        flagKey: key,
        value: fake.get(key) as T,
        variant: String(fake.get(key)),
        reason: 'STATIC',
        flagMetadata: { faked: true },
      };
    } else {
      details = evaluate(this.ruleset(), key, fallback, context, options);
    }
    if (details.errorCode && details.errorCode !== 'FLAG_NOT_FOUND') {
      this.deps.logger?.warn(
        `[flags] ${key}: ${details.errorCode} ${details.errorMessage ?? ''}`.trim(),
      );
    }
    const enrichers = this.deps.enrichers ?? [];
    runEnrichers(enrichers, (e) => e.onEvaluation?.(details, context));
    return details;
  }

  /** @internal Records an exposure for an experiment assignment. */
  expose(subject: Subject, details: EvaluationDetails): void {
    const experiment = details.flagMetadata.experiment;
    if (typeof experiment !== 'string' || details.variant === undefined) return;
    const holdout = details.flagMetadata.holdout === true;
    if (details.reason !== 'SPLIT' && !holdout) return;
    const subjectId = String(subject.id);
    const event: FlagEvent = {
      id: exposureId(this.deps.app, this.deps.environment, experiment, subjectId),
      schemaVersion: EVENT_SCHEMA_VERSION,
      app: this.deps.app,
      environment: this.deps.environment,
      type: 'exposure',
      flag: details.flagKey,
      experiment,
      variant: holdout ? HOLDOUT_VARIANT : details.variant,
      subject: subjectId,
      subjectType: subject.type ?? 'user',
      ...(holdout ? { props: { holdout: true } } : {}),
      ts: Date.now(),
    };
    if (this.deps.buffer?.push(event)) {
      runEnrichers(this.deps.enrichers ?? [], (e) => e.onEvent?.(event));
    }
  }

  /** Records a tracked event (a conversion) for a subject. */
  async track(subject: SubjectLike, name: string, options: TrackOptions = {}): Promise<void> {
    const normalized = toSubject(subject);
    if (!normalized) throw new Error('flags.track() needs a subject');
    if (this.#fakes) return;
    const event: FlagEvent = {
      id: uuidv7(),
      schemaVersion: EVENT_SCHEMA_VERSION,
      app: this.deps.app,
      environment: this.deps.environment,
      type: 'track',
      name,
      subject: String(normalized.id),
      subjectType: normalized.type ?? 'user',
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.props !== undefined ? { props: options.props } : {}),
      ts: Date.now(),
    };
    runEnrichers(this.deps.enrichers ?? [], (e) => e.onEvent?.(event));
    const transport = this.deps.transport;
    if (options.client && transport) {
      if (transport.capabilities.transactional) {
        await transport.publish([event], { client: options.client });
        return;
      }
      if (!this.#warnedTransactional) {
        this.#warnedTransactional = true;
        this.deps.logger?.warn(
          `[flags] the "${transport.name}" transport is not transactional: tracked events are sent after commit, and are lost if the process dies in between`,
        );
      }
      if (options.client.after) {
        options.client.after('commit', () => {
          this.deps.buffer?.push(event);
        });
        return;
      }
    }
    this.deps.buffer?.push(event);
  }

  /** Experiment results as last computed by the worker (or `null`), for this process's environment by default. */
  results(experiment: string, environment?: string): Promise<ExperimentResults | null> {
    return this.deps.results ? this.deps.results(experiment, environment) : Promise.resolve(null);
  }

  /** Deletes everything stored about a subject in every sink that supports it. */
  async forget(subject: SubjectLike): Promise<void> {
    const normalized = toSubject(subject);
    if (!normalized) return;
    await this.deps.forget?.(String(normalized.id));
  }

  /** @internal */
  async attributesFor(subject: Subject | undefined): Promise<Record<string, unknown>> {
    if (!subject || !this.deps.attributes) return {};
    return this.deps.attributes(subject);
  }

  /** @internal */
  stickyFor(subject: Subject | undefined): Promise<Record<string, string>> | undefined {
    if (!subject || !this.deps.sticky) return undefined;
    return this.deps.sticky(String(subject.id));
  }

  /**
   * Replaces flag values for the duration of a test. Every evaluation of a faked key returns the
   * given value; tracked events are dropped. Returns a function that restores real evaluation.
   *
   * ```ts
   * const restore = flags.fake({ checkout_v2: 'b' })
   * // …
   * restore()
   * ```
   */
  fake(values: Partial<Record<FlagKey, JsonValue>>): () => void {
    this.#fakes = new Map(Object.entries(values) as Array<[string, JsonValue]>);
    return () => this.restore();
  }

  restore() {
    this.#fakes = undefined;
  }
}

/**
 * Flags for one subject. Results are memoized for the life of the scope (one request), so a flag
 * cannot change value halfway through rendering a page. The subject may be given directly or as a
 * resolver that runs on the first read (what `ctx.flags` uses).
 */
export class FlagsScope {
  #memo = new Map<string, EvaluationDetails>();
  #subject: Promise<Subject | undefined>;
  #context: Promise<EvaluationContext> | undefined;
  #sticky: Promise<Record<string, string>> | undefined;
  #resolver: (() => Promise<Subject | undefined>) | undefined;
  #resolved: Promise<Subject | undefined> | undefined;

  constructor(
    readonly manager: FlagsManager,
    subject: Subject | undefined | (() => Promise<SubjectLike> | SubjectLike),
    readonly attributes: Record<string, unknown> = {},
  ) {
    if (typeof subject === 'function') {
      const resolve = subject;
      this.#resolver = async () => toSubject(await resolve());
      this.#subject = Promise.resolve(undefined);
    } else {
      this.#subject = Promise.resolve(subject);
    }
  }

  /** The subject this scope evaluates for (resolved on first use). */
  subject(): Promise<Subject | undefined> {
    if (!this.#resolver) return this.#subject;
    this.#resolved ??= this.#resolver();
    return this.#resolved;
  }

  #ctx(): Promise<EvaluationContext> {
    this.#context ??= this.subject().then(async (subject) => {
      const resolved = await this.manager.attributesFor(subject);
      return toContext(subject, { ...resolved, ...this.attributes });
    });
    return this.#context;
  }

  async #options(key: string): Promise<EvaluateOptions> {
    const flag = this.manager.ruleset().flags[key];
    if (!flag?.experiment) return {};
    this.#sticky ??= this.subject().then(
      (subject) => this.manager.stickyFor(subject)?.catch(() => ({})) ?? {},
    );
    return { sticky: await this.#sticky };
  }

  async #evaluate(key: string): Promise<EvaluationDetails> {
    const cached = this.#memo.get(key);
    if (cached) return cached;
    const fallback = (this.manager.declaredDefault(key) ?? null) as JsonValue;
    const details = this.manager.evaluateFor(
      key,
      fallback,
      await this.#ctx(),
      await this.#options(key),
    );
    this.#memo.set(key, details);
    return details;
  }

  /** Full evaluation details (value, variant, reason, error). Records an exposure for experiments. */
  async details<K extends FlagKey>(key: K): Promise<EvaluationDetails<FlagValue<K>>> {
    const details = await this.#evaluate(key);
    const subject = await this.subject();
    if (subject) this.manager.expose(subject, details);
    return details as EvaluationDetails<FlagValue<K>>;
  }

  /** The flag's value. */
  async value<K extends FlagKey>(key: K): Promise<FlagValue<K>> {
    return (await this.details(key)).value;
  }

  /** Whether a boolean flag is on. */
  async enabled<K extends BooleanFlagKey>(key: K): Promise<boolean> {
    return (await this.details(key)).value === true;
  }

  async disabled<K extends BooleanFlagKey>(key: K): Promise<boolean> {
    return !(await this.enabled(key));
  }

  /**
   * `true` when a boolean flag is on, or — given variants — when the flag serves one of them.
   * What the Edge `@flag` tag compiles to.
   */
  async matches<K extends FlagKey>(key: K, ...variants: string[]): Promise<boolean> {
    const details = await this.details(key);
    if (variants.length === 0) return details.value === true;
    return variants.includes(details.variant ?? String(details.value));
  }

  /** The variant name served (experiments). Falls back to the value as a string. */
  async variant<K extends FlagKey>(key: K): Promise<string> {
    const details = await this.details(key);
    return details.variant ?? String(details.value);
  }

  /**
   * Values of several flags at once — for the frontend. Without `keys`, only flags declared with
   * `client: true` are included, so internal flag names never reach the browser by accident.
   * Experiment exposures are NOT recorded here unless `expose: true`: values sent to a page are not
   * necessarily seen.
   */
  async all(
    keys?: FlagKey[],
    options: { expose?: boolean } = {},
  ): Promise<Record<string, JsonValue>> {
    const declarations = this.manager.declarations;
    const list =
      keys ?? (Object.keys(declarations).filter((key) => declarations[key]?.client) as FlagKey[]);
    const out: Record<string, JsonValue> = {};
    for (const key of list) {
      out[key] = options.expose
        ? ((await this.details(key)).value as JsonValue)
        : (await this.#evaluate(key)).value;
    }
    return out;
  }

  /** Records a tracked event for this scope's subject. */
  async track(name: string, options: TrackOptions = {}): Promise<void> {
    const subject = await this.subject();
    if (!subject) throw new Error('cannot track for an anonymous subject');
    return this.manager.track(subject, name, options);
  }
}
