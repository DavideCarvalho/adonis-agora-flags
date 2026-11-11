import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { emptyRuleset, RULESET_SCHEMA_VERSION, type Ruleset } from '@adonis-agora/flags-core';
import type { RulesetSource, SourceStatus } from '../ruleset_source.js';
import type { TokenSource } from './token.js';

export interface RemoteSourceOptions {
  /** The control-plane base URL (`https://flags.example.com/_flags`). */
  url: string;
  token: TokenSource;
  /** The tenant's partition (sent as `x-flags-tenant`; the token decides what it really is). */
  partition: string;
  /**
   * Local file holding the last ruleset received. Read at boot when the control-plane is
   * unreachable, so a deploy during an outage still serves real targeting. Default: none.
   */
  snapshotPath?: string;
  /** Use server-sent events for push updates. Default `true`; polling always runs as a fallback. */
  stream?: boolean;
  /** Poll interval (ms). Default 30000 with streaming, 5000 without. */
  intervalMs?: number;
  /** Advertised capabilities (sent as `x-flags-capabilities`). */
  capabilities?: string[];
  fetch?: typeof fetch;
  onError?: (error: unknown) => void;
}

/**
 * A tenant's ruleset: fetched from the control-plane (conditional GET by ETag), kept fresh by an SSE
 * stream with polling as a fallback, and snapshotted to disk. Evaluation stays local.
 */
export class RemoteSource implements RulesetSource {
  #ruleset: Ruleset = emptyRuleset('0');
  #loadedAt: Date | null = null;
  #lastError: string | null = null;
  #listeners = new Set<(ruleset: Ruleset) => void>();
  #timer: NodeJS.Timeout | undefined;
  #stream: AbortController | undefined;
  #streaming = false;
  #stopped = false;
  #refreshing: Promise<boolean> | undefined;
  readonly #fetch: typeof fetch;

  constructor(private readonly options: RemoteSourceOptions) {
    this.#fetch = options.fetch ?? fetch;
  }

  get #base() {
    return this.options.url.replace(/\/$/, '');
  }

  async #headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.options.token.get()}`,
      'x-flags-tenant': this.options.partition,
      'x-flags-capabilities': (
        this.options.capabilities ?? [`ruleset:v${RULESET_SCHEMA_VERSION}`]
      ).join(','),
    };
  }

  async start(): Promise<void> {
    this.#stopped = false;
    const loaded = await this.refresh();
    if (!loaded && !this.#loadedAt && this.options.snapshotPath) {
      try {
        const snapshot = JSON.parse(await readFile(this.options.snapshotPath, 'utf8')) as Ruleset;
        this.#set(snapshot, false);
      } catch {
        // No snapshot yet: serve code defaults until the control-plane answers.
      }
    }
    const streaming = this.options.stream !== false;
    this.#timer = setInterval(
      () => void this.refresh(),
      this.options.intervalMs ?? (streaming ? 30_000 : 5000),
    );
    this.#timer.unref();
    if (streaming) void this.#openStream();
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
      const headers = await this.#headers();
      if (this.#loadedAt) headers['if-none-match'] = `"${this.#ruleset.version}"`;
      const response = await this.#fetch(`${this.#base}/v1/ruleset`, { headers });
      if (response.status === 304) {
        this.#lastError = null;
        return false;
      }
      if (response.status === 401) this.options.token.invalidate?.();
      if (!response.ok) throw new Error(`control-plane answered ${response.status}`);
      const ruleset = (await response.json()) as Ruleset;
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
    if (persist && this.options.snapshotPath) void this.#snapshot(ruleset);
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

  /** Reads `event: ruleset` messages; reconnects with backoff while the source runs. */
  async #openStream() {
    let backoff = 1000;
    while (!this.#stopped) {
      this.#stream = new AbortController();
      try {
        const response = await this.#fetch(`${this.#base}/v1/ruleset/stream`, {
          headers: { ...(await this.#headers()), accept: 'text/event-stream' },
          signal: this.#stream.signal,
        });
        if (response.status === 401) this.options.token.invalidate?.();
        if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
        this.#streaming = true;
        backoff = 1000;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let boundary = buffer.indexOf('\n\n');
          while (boundary !== -1) {
            const message = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            if (/^event: ruleset$/m.test(message)) void this.refresh();
            boundary = buffer.indexOf('\n\n');
          }
        }
      } catch (error) {
        if (this.#stopped) break;
        this.options.onError?.(error);
      } finally {
        this.#streaming = false;
      }
      if (this.#stopped) break;
      // The server closes the stream when the token expires; reconnect fetches a fresh one.
      await new Promise((resolve) => setTimeout(resolve, backoff).unref());
      backoff = Math.min(backoff * 2, 30_000);
      void this.refresh();
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
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#stream?.abort();
  }
}
