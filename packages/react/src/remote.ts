/** What a remote source exposes to React (through `useSyncExternalStore`). */
export interface RemoteState {
  values: Record<string, unknown>;
  variants: Record<string, string>;
  /** Flag keys that are experiments: rendering them records an exposure. */
  experiments: ReadonlySet<string>;
  /** The first evaluation answered. Until then, hooks serve their fallbacks. */
  ready: boolean;
  error: Error | null;
}

export interface RemoteFlagsOptions {
  /** The flags server base URL, e.g. `https://flags.example.com/_flags`. */
  url: string;
  /**
   * The user's token: an authkit access token (`() => auth.getAccessToken()`), or a context your
   * backend signed with `signFlagsContext`. Called again whenever the server rejects it.
   */
  token: string | (() => string | Promise<string>);
  /** Non-identity attributes (locale, screen). They cannot change who the user is. */
  attributes?: Record<string, string | number | boolean>;
  /** Re-evaluate at least this often (ms). Default 30000; cheap thanks to ETags. */
  pollMs?: number;
  /** Listen for changes over server-sent events. Default `true` where `EventSource` exists. */
  stream?: boolean;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

type Listener = () => void;

interface QueuedEvent {
  type: 'exposure' | 'track';
  flag?: string;
  name?: string;
  value?: number;
  props?: Record<string, unknown>;
}

/**
 * Flags evaluated by a flags server (the control-plane's browser API) for a frontend that has no
 * Adonis backend of its own to ask — an SPA, a mobile app, a static site. Pass it to
 * `<FlagsProvider source={…}>`.
 */
export class RemoteFlags {
  #state: RemoteState = {
    values: {},
    variants: {},
    experiments: new Set(),
    ready: false,
    error: null,
  };
  #listeners = new Set<Listener>();
  #etag: string | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #stream: EventSource | undefined;
  #reconnect: ReturnType<typeof setTimeout> | undefined;
  #exposed = new Set<string>();
  #queue: QueuedEvent[] = [];
  #flushTimer: ReturnType<typeof setTimeout> | undefined;
  #started = 0;
  #inflight: Promise<void> | undefined;
  readonly #fetch: typeof fetch;

  constructor(readonly options: RemoteFlagsOptions) {
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
  }

  get #base() {
    return this.options.url.replace(/\/$/, '');
  }

  #token(): Promise<string> {
    const token = this.options.token;
    return Promise.resolve(typeof token === 'function' ? token() : token);
  }

  getSnapshot = (): RemoteState => this.#state;

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<RemoteState>) {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Evaluates now (a no-op answer when nothing changed). */
  refresh(): Promise<void> {
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<void> {
    try {
      const response = await this.#fetch(`${this.#base}/v1/client/evaluate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.#token()}`,
          ...(this.#etag ? { 'if-none-match': this.#etag } : {}),
        },
        body: JSON.stringify({ attributes: this.options.attributes ?? {} }),
      });
      if (response.status === 304) return;
      if (!response.ok) throw new Error(`flags server answered ${response.status}`);
      this.#etag = response.headers.get('etag') ?? undefined;
      const body = (await response.json()) as {
        values: Record<string, unknown>;
        variants: Record<string, string>;
        experiments: string[];
      };
      this.#set({
        values: body.values,
        variants: body.variants,
        experiments: new Set(body.experiments),
        ready: true,
        error: null,
      });
    } catch (error) {
      this.#set({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  }

  /** Starts polling and streaming. Reference-counted: every provider calls start/stop. */
  start(): void {
    if (this.#started++ > 0) return;
    void this.refresh();
    this.#timer = setInterval(() => void this.refresh(), this.options.pollMs ?? 30_000);
    const Source =
      this.options.EventSource ?? (globalThis as { EventSource?: typeof EventSource }).EventSource;
    if (this.options.stream !== false && Source) void this.#openStream(Source, 1000);
    if (typeof addEventListener === 'function') addEventListener('pagehide', this.#flushOnHide);
  }

  stop(): void {
    if (--this.#started > 0) return;
    this.#started = 0;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#reconnect) clearTimeout(this.#reconnect);
    this.#stream?.close();
    this.#stream = undefined;
    if (typeof removeEventListener === 'function')
      removeEventListener('pagehide', this.#flushOnHide);
    void this.flush();
  }

  async #openStream(Source: typeof EventSource, backoff: number) {
    if (this.#started === 0) return;
    let token: string;
    try {
      token = await this.#token();
    } catch {
      this.#reconnect = setTimeout(
        () => void this.#openStream(Source, Math.min(backoff * 2, 60_000)),
        backoff,
      );
      return;
    }
    const stream = new Source(`${this.#base}/v1/client/stream?token=${encodeURIComponent(token)}`);
    this.#stream = stream;
    stream.addEventListener('ruleset', () => void this.refresh());
    stream.onerror = () => {
      // Closed by the server (token expired) or the network: reopen with a fresh token.
      stream.close();
      if (this.#stream === stream) this.#stream = undefined;
      this.#reconnect = setTimeout(
        () => void this.#openStream(Source, Math.min(backoff * 2, 60_000)),
        backoff,
      );
    };
  }

  /** Records that the user saw an experiment flag. Once per flag per page load. */
  expose(key: string): void {
    if (!this.#state.experiments.has(key) || this.#exposed.has(key)) return;
    this.#exposed.add(key);
    this.#enqueue({ type: 'exposure', flag: key });
  }

  /** Records a conversion for the signed-in user. */
  track(name: string, options: { value?: number; props?: Record<string, unknown> } = {}): void {
    this.#enqueue({ type: 'track', name, ...options });
  }

  #enqueue(event: QueuedEvent) {
    this.#queue.push(event);
    this.#flushTimer ??= setTimeout(() => void this.flush(), 500);
  }

  /** Sends queued events now. */
  async flush(keepalive = false): Promise<void> {
    if (this.#flushTimer) clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
    if (this.#queue.length === 0) return;
    const events = this.#queue.splice(0, 200);
    try {
      const response = await this.#fetch(`${this.#base}/v1/client/events`, {
        method: 'POST',
        keepalive,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${await this.#token()}`,
        },
        body: JSON.stringify({ events }),
      });
      if (!response.ok) throw new Error(`flags server answered ${response.status}`);
    } catch {
      // Put them back for the next flush; analytics are best-effort from a browser.
      this.#queue.unshift(...events);
    }
    if (this.#queue.length > 0) this.#flushTimer = setTimeout(() => void this.flush(), 5000);
  }

  #flushOnHide = () => {
    void this.flush(true);
  };
}

/** A remote source for `<FlagsProvider source={remoteFlags({ url, token })}>`. */
export function remoteFlags(options: RemoteFlagsOptions): RemoteFlags {
  return new RemoteFlags(options);
}
