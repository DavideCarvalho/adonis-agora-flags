import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyRuleset, type Ruleset } from '@adonis-agora/flags-core';
import type { RulesetSource, SourceStatus } from '../ruleset_source.js';
import type { RulesetChannel } from '../tenant_transports/types.js';

export interface RemoteSourceOptions {
  /** How the ruleset arrives (`tenant.watch`): http, redis, durable. */
  channel: RulesetChannel;
  /**
   * Local file holding the last ruleset received. Read at boot when the control-plane is
   * unreachable, so a deploy during an outage still serves real targeting. Default: none.
   */
  snapshotPath?: string;
  /** Listen for pushed changes. Default `true`; polling always runs as a fallback. */
  stream?: boolean;
  /** Poll interval (ms). Default 30000 with push notifications, 5000 without. */
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * A tenant's ruleset: fetched from the control-plane over its watch channel, kept fresh by the
 * channel's change notifications with polling as a fallback, and snapshotted to disk. Evaluation
 * stays local.
 */
export class RemoteSource implements RulesetSource {
  #ruleset: Ruleset = emptyRuleset('0');
  #loadedAt: Date | null = null;
  #lastError: string | null = null;
  #listeners = new Set<(ruleset: Ruleset) => void>();
  #timer: NodeJS.Timeout | undefined;
  #unsubscribe: (() => void) | undefined;
  #streaming = false;
  #refreshing: Promise<boolean> | undefined;
  /** Snapshot writes, one at a time: two at once would share the temp file. */
  #writing: Promise<void> = Promise.resolve();

  constructor(private readonly options: RemoteSourceOptions) {}

  async start(): Promise<void> {
    const loaded = await this.refresh();
    if (!loaded && !this.#loadedAt && this.options.snapshotPath) {
      try {
        const snapshot = JSON.parse(await readFile(this.options.snapshotPath, 'utf8')) as Ruleset;
        this.#set(snapshot, false);
      } catch {
        // No snapshot yet: serve code defaults until the control-plane answers.
      }
    }
    const subscribe = this.options.stream !== false ? this.options.channel.subscribe : undefined;
    this.#timer = setInterval(
      () => void this.refresh(),
      this.options.intervalMs ?? (subscribe ? 30_000 : 5000),
    );
    this.#timer.unref();
    if (subscribe) {
      this.#unsubscribe = subscribe.call(this.options.channel, {
        changed: () => void this.refresh(),
        connected: (up) => {
          this.#streaming = up;
        },
        error: (error) => this.options.onError?.(error),
      });
    }
  }

  current(): Ruleset {
    return this.#ruleset;
  }

  onChange(listener: (ruleset: Ruleset) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  refresh(): Promise<boolean> {
    this.#refreshing ??= this.#refresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #refresh(): Promise<boolean> {
    try {
      const ruleset = await this.options.channel.fetch(
        this.#loadedAt ? this.#ruleset.version : undefined,
      );
      this.#lastError = null;
      if (!ruleset) return false;
      if (this.#loadedAt && ruleset.version === this.#ruleset.version) return false;
      this.#set(ruleset, true);
      return true;
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      this.options.onError?.(error);
      return false;
    }
  }

  #set(ruleset: Ruleset, persist: boolean) {
    this.#ruleset = ruleset;
    this.#loadedAt = new Date();
    if (persist) this.#lastError = null;
    for (const listener of this.#listeners) {
      try {
        listener(ruleset);
      } catch {
        // ignore
      }
    }
    if (persist && this.options.snapshotPath) {
      this.#writing = this.#writing.then(() => this.#snapshot(ruleset));
    }
  }

  async #snapshot(ruleset: Ruleset) {
    const path = this.options.snapshotPath!;
    try {
      await mkdir(dirname(path), { recursive: true });
      // Write-then-rename: a crash mid-write never leaves a truncated snapshot.
      await writeFile(`${path}.tmp`, JSON.stringify(ruleset));
      await rename(`${path}.tmp`, path);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  status(): SourceStatus {
    return {
      version: this.#ruleset.version,
      loadedAt: this.#loadedAt,
      lastError: this.#lastError,
      stale: this.#lastError !== null && this.#loadedAt !== null,
      mode: this.#streaming ? 'stream' : 'poll',
    };
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#unsubscribe?.();
    await this.options.channel.close?.();
  }
}
