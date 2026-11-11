import { emptyRuleset, type Ruleset } from '@adonis-agora/flags-core';
import type { FlagsStore } from './stores/store.js';

export interface SourceStatus {
  version: string;
  loadedAt: Date | null;
  lastError: string | null;
  /** Serving a ruleset loaded before the latest failure (last known good). */
  stale: boolean;
  /** How the source learns about changes right now. */
  mode: 'notify' | 'poll' | 'stream';
}

/**
 * Where a process gets its ruleset. Every implementation keeps the last ruleset it loaded and serves
 * it when the backing store or the control-plane is unreachable — evaluation never waits on I/O.
 */
export interface RulesetSource {
  start(): Promise<void>;
  current(): Ruleset;
  /** Reloads if the version moved. Resolves `true` when a new ruleset was loaded. */
  refresh(): Promise<boolean>;
  onChange(listener: (ruleset: Ruleset) => void): () => void;
  status(): SourceStatus;
  stop(): Promise<void>;
}

abstract class BaseSource implements RulesetSource {
  protected ruleset: Ruleset = emptyRuleset('0');
  protected loadedAt: Date | null = null;
  protected lastError: string | null = null;
  #listeners = new Set<(ruleset: Ruleset) => void>();

  abstract start(): Promise<void>;
  abstract refresh(): Promise<boolean>;
  abstract stop(): Promise<void>;
  abstract status(): SourceStatus;

  current(): Ruleset {
    return this.ruleset;
  }

  onChange(listener: (ruleset: Ruleset) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  protected set(ruleset: Ruleset) {
    this.ruleset = ruleset;
    this.loadedAt = new Date();
    this.lastError = null;
    for (const listener of this.#listeners) {
      try {
        listener(ruleset);
      } catch {
        // A listener must never break reloading.
      }
    }
  }
}

/** A ruleset the app sets by hand (tests, `flags.fake()`, static configs). */
export class StaticSource extends BaseSource {
  constructor(ruleset: Ruleset = emptyRuleset('0')) {
    super();
    this.ruleset = ruleset;
    this.loadedAt = new Date();
  }

  async start() {}
  async refresh() {
    return false;
  }
  async stop() {}
  replace(ruleset: Ruleset) {
    this.set(ruleset);
  }
  status(): SourceStatus {
    return {
      version: this.ruleset.version,
      loadedAt: this.loadedAt,
      lastError: null,
      stale: false,
      mode: 'poll',
    };
  }
}

export interface StoreSourceOptions {
  environment: string;
  /** Version poll interval (ms). Default 5000; the fallback when notifications are unavailable. */
  intervalMs?: number;
  /**
   * Subscribe to change notifications (Postgres `LISTEN`) for near-instant propagation. Holds one
   * pool connection per process. Default `true` when the store supports it.
   */
  notify?: boolean;
  onError?: (error: unknown) => void;
}

/** Store-backed source for `standalone` and `control-plane` processes. */
export class StoreSource extends BaseSource {
  #timer: NodeJS.Timeout | undefined;
  #unlisten: (() => Promise<void>) | undefined;
  #refreshing: Promise<boolean> | undefined;

  constructor(
    private readonly store: FlagsStore & {
      listen?(onMessage: (payload: string) => void): Promise<() => Promise<void>>;
      canListen?: boolean;
    },
    private readonly options: StoreSourceOptions,
  ) {
    super();
  }

  async start(): Promise<void> {
    try {
      this.set(await this.store.readRuleset(this.options.environment));
    } catch (error) {
      this.#fail(error);
    }
    if (this.options.notify !== false && this.store.listen && this.store.canListen !== false) {
      try {
        this.#unlisten = await this.store.listen((payload) => {
          if (payload.startsWith(`${this.options.environment}:`)) void this.refresh();
        });
      } catch (error) {
        this.#fail(error);
      }
    }
    this.#timer = setInterval(() => void this.refresh(), this.options.intervalMs ?? 5000);
    this.#timer.unref();
  }

  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<boolean> {
    try {
      const version = await this.store.version(this.options.environment);
      if (version === this.ruleset.version && this.loadedAt) {
        this.lastError = null;
        return false;
      }
      this.set(await this.store.readRuleset(this.options.environment));
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  #fail(error: unknown) {
    this.lastError = error instanceof Error ? error.message : String(error);
    this.options.onError?.(error);
  }

  status(): SourceStatus {
    return {
      version: this.ruleset.version,
      loadedAt: this.loadedAt,
      lastError: this.lastError,
      stale: this.lastError !== null && this.loadedAt !== null,
      mode: this.#unlisten ? 'notify' : 'poll',
    };
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#unlisten?.().catch(() => {});
    this.#unlisten = undefined;
  }
}
