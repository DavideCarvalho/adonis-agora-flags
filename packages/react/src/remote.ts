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

/** What an app's token endpoint (`GET /_flags/token`) answers. */
export interface BrowserToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
  /** The flags API the token is for. */
  url: string;
}

interface CommonOptions {
  /** Non-identity attributes (locale, screen). They cannot change who the user is. */
  attributes?: Record<string, string | number | boolean>;
  /** Re-evaluate at least this often (ms). Default 30000; cheap thanks to ETags. */
  pollMs?: number;
  /** Listen for changes over server-sent events. Default `true` where `EventSource` exists. */
  stream?: boolean;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

/** Tokens from your Adonis backend's token endpoint (`browser` in `config/flags.ts`). */
export interface EndpointOptions extends CommonOptions {
  /** The app's token endpoint, e.g. `/_flags/token`. Called with the session cookie. */
  endpoint: string;
  /** Cookies on the token request. Default `same-origin`; `include` when the API is on another origin. */
  credentials?: RequestCredentials;
  /**
   * Extra headers on the token request — e.g. `() => ({ authorization: \`Bearer ${apiToken}\` })`
   * when your app authenticates the SPA with `@adonisjs/auth` access tokens instead of a cookie.
   */
  headers?:
    | Record<string, string>
    | (() => Record<string, string> | Promise<Record<string, string>>);
  /** A token already in the page (from `browserToken(ctx)`), to skip the first round-trip. */
  initial?: BrowserToken;
}

/** Your own token and flags API URL — e.g. an authkit access token held by a mobile app. */
export interface TokenOptions extends CommonOptions {
  /** The flags API base URL, e.g. `https://flags.example.com/_flags`. */
  url: string;
  /** The token, or a function called for every request (cache it yourself). */
  token: string | (() => string | Promise<string>);
}

export type RemoteFlagsOptions = EndpointOptions | TokenOptions;

type Listener = () => void;

interface QueuedEvent {
  type: 'exposure' | 'track';
  flag?: string;
  name?: string;
  value?: number;
  props?: Record<string, unknown>;
}

/**
 * Flags evaluated by the flags API for a frontend that does not render through Inertia — an SPA, a
 * mobile app, a static site. Pass it to `<FlagsProvider source={…}>`.
 *
 * With `endpoint`, tokens come from your Adonis backend (`GET /_flags/token`), which signs the
 * session's user — authkit or not — and says where the flags API is.
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
  #session: BrowserToken | undefined;
  #sessionLoad: Promise<BrowserToken> | undefined;
  readonly #fetch: typeof fetch;

  constructor(readonly options: RemoteFlagsOptions) {
    this.#fetch = options.fetch ?? ((...args) => fetch(...args));
    if ('endpoint' in options && options.initial) this.#session = options.initial;
  }

  /** The token and flags API URL to use now: cached until shortly before the token expires. */
  async #auth(): Promise<{ url: string; token: string }> {
    const options = this.options;
    if (!('endpoint' in options)) {
      const token = typeof options.token === 'function' ? await options.token() : options.token;
      return { url: options.url.replace(/\/$/, ''), token };
    }
    if (this.#session && this.#session.expiresAt - 30_000 > Date.now()) {
      return { url: this.#session.url.replace(/\/$/, ''), token: this.#session.token };
    }
    this.#sessionLoad ??= (async () => {
      const response = await this.#fetch(options.endpoint, {
        credentials: options.credentials ?? 'same-origin',
        headers: {
          accept: 'application/json',
          ...(typeof options.headers === 'function'
            ? await options.headers()
            : (options.headers ?? {})),
        },
      });
      if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
      const body = (await response.json()) as BrowserToken;
      // A relative API URL is relative to the token endpoint's origin.
      const url = /^https?:\/\//.test(body.url)
        ? body.url
        : /^https?:\/\//.test(options.endpoint)
          ? new URL(body.url, options.endpoint).toString()
          : body.url;
      this.#session = { ...body, url };
      return this.#session;
    })().finally(() => {
      this.#sessionLoad = undefined;
    });
    const session = await this.#sessionLoad;
    return { url: session.url.replace(/\/$/, ''), token: session.token };
  }

  /** A request to the flags API; on a 401, fetches a new token once and retries. */
  async #call(path: string, init: RequestInit): Promise<Response> {
    const send = async () => {
      const { url, token } = await this.#auth();
      return this.#fetch(`${url}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
      });
    };
    const response = await send();
    if (response.status !== 401 || !('endpoint' in this.options)) return response;
    this.#session = undefined;
    return send();
  }

  /**
   * The user signed in or out: drop the token and the exposures already recorded, then evaluate
   * again for whoever the session now holds.
   */
  reload(): Promise<void> {
    this.#session = undefined;
    this.#etag = undefined;
    this.#exposed.clear();
    if (this.#started > 0 && this.#stream) {
      this.#stream.close();
      this.#stream = undefined;
      const Source =
        this.options.EventSource ??
        (globalThis as { EventSource?: typeof EventSource }).EventSource;
      if (Source) void this.#openStream(Source, 1000);
    }
    return this.refresh();
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
      const response = await this.#call('/v1/client/evaluate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
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
    let auth: { url: string; token: string };
    try {
      auth = await this.#auth();
    } catch {
      this.#reconnect = setTimeout(
        () => void this.#openStream(Source, Math.min(backoff * 2, 60_000)),
        backoff,
      );
      return;
    }
    const stream = new Source(
      `${auth.url}/v1/client/stream?token=${encodeURIComponent(auth.token)}`,
    );
    this.#stream = stream;
    stream.addEventListener('ruleset', () => void this.refresh());
    stream.onerror = () => {
      // Closed by the server (token expired) or the network: reopen with a fresh token.
      stream.close();
      if (this.#stream !== stream) return;
      this.#stream = undefined;
      this.#session = undefined;
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
      const response = await this.#call('/v1/client/events', {
        method: 'POST',
        keepalive,
        headers: { 'content-type': 'application/json' },
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

/** A remote source: `remoteFlags({ endpoint: '/_flags/token' })`, or `remoteFlags({ url, token })`. */
export function remoteFlags(options: RemoteFlagsOptions): RemoteFlags {
  return new RemoteFlags(options);
}
