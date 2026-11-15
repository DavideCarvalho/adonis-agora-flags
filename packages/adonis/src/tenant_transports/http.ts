import { RULESET_SCHEMA_VERSION, type Ruleset } from '@adonis-agora/flags-core';
import type { TokenSource } from '../topology/token.js';
import type {
  RulesetChannel,
  RulesetChannelListener,
  TenantLinkContext,
  TenantPush,
  WatchTransport,
} from './types.js';

export interface HttpTenantTransportOptions {
  /** The control-plane base URL (`https://flags.example.com/_flags`). Default: `tenant.url`. */
  url?: string;
  /** Replaces the global `fetch` (a proxy, mTLS, tests). */
  fetch?: typeof fetch;
  /** Aborts a request after this many ms. Default: none (the SSE stream is never cut). */
  timeoutMs?: number;
  /** Retries per event batch on network errors, 429 and 5xx. Default 3. */
  retries?: number;
  /** Server-sent events for ruleset changes. Default `true`; polling always runs as a fallback. */
  stream?: boolean;
}

interface HttpOptions {
  url: string;
  token: TokenSource;
  partition: string;
  capabilities?: string[] | undefined;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

function base(url: string) {
  return url.replace(/\/$/, '');
}

function doFetch(options: HttpOptions): typeof fetch {
  return options.fetch ?? ((input, init) => fetch(input, init));
}

function signal(timeoutMs: number | undefined): { signal?: AbortSignal } {
  return timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {};
}

const PATHS = { events: '/v1/events', usage: '/v1/usage', declarations: '/v1/declarations' };

/** Tenant → control-plane over HTTP POST: what flags always did. */
export class HttpPush implements TenantPush {
  readonly driver = 'http';
  readonly maxBytes = Number.POSITIVE_INFINITY;

  constructor(private readonly options: HttpOptions & { retries?: number | undefined }) {}

  async send(kind: 'events' | 'usage' | 'declarations', body: unknown): Promise<void> {
    if (kind === 'events') return this.#sendEvents(body);
    const response = await doFetch(this.options)(`${base(this.options.url)}${PATHS[kind]}`, {
      method: 'POST',
      headers: await this.#headers(),
      body: JSON.stringify(body),
      ...signal(this.options.timeoutMs),
    });
    if (response.status === 401) this.options.token.invalidate?.();
    if (!response.ok)
      throw new Error(`control-plane answered ${response.status} on ${PATHS[kind]}`);
  }

  async #headers(): Promise<Record<string, string>> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${await this.options.token.get()}`,
      'x-flags-tenant': this.options.partition,
    };
  }

  async #sendEvents(body: unknown): Promise<void> {
    const retries = this.options.retries ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await doFetch(this.options)(`${base(this.options.url)}/v1/events`, {
          method: 'POST',
          headers: await this.#headers(),
          body: JSON.stringify(body),
          ...signal(this.options.timeoutMs),
        });
        if (response.ok) return;
        if (response.status === 401) this.options.token.invalidate?.();
        // 4xx other than 401/429 will not succeed on retry.
        if (response.status < 500 && response.status !== 429 && response.status !== 401) {
          throw new Error(
            `control-plane rejected events: ${response.status} ${await response.text()}`,
          );
        }
        lastError = new Error(`control-plane answered ${response.status}`);
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.startsWith('control-plane rejected'))
          throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
    }
    throw lastError;
  }

  async check(): Promise<void> {
    await httpCheck(this.options);
  }
}

async function httpCheck(options: HttpOptions): Promise<void> {
  const response = await doFetch(options)(`${base(options.url)}/v1/ruleset`, {
    headers: {
      authorization: `Bearer ${await options.token.get()}`,
      'x-flags-tenant': options.partition,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
  });
  if (response.status === 401) throw new Error('the control-plane refused the tenant token (401)');
  if (!response.ok && response.status !== 403)
    throw new Error(`the control-plane answered ${response.status}`);
}

/** The ruleset over HTTP: conditional GET by ETag, plus a server-sent events stream. */
export class HttpRulesetChannel implements RulesetChannel {
  readonly driver = 'http';

  constructor(private readonly options: HttpOptions & { stream?: boolean | undefined }) {}

  async #headers(): Promise<Record<string, string>> {
    return {
      authorization: `Bearer ${await this.options.token.get()}`,
      'x-flags-tenant': this.options.partition,
      'x-flags-capabilities': (
        this.options.capabilities ?? [`ruleset:v${RULESET_SCHEMA_VERSION}`]
      ).join(','),
    };
  }

  async fetch(knownVersion: string | undefined): Promise<Ruleset | null> {
    const headers = await this.#headers();
    if (knownVersion !== undefined) headers['if-none-match'] = `"${knownVersion}"`;
    const response = await doFetch(this.options)(`${base(this.options.url)}/v1/ruleset`, {
      headers,
      ...signal(this.options.timeoutMs),
    });
    if (response.status === 304) return null;
    if (response.status === 401) this.options.token.invalidate?.();
    if (!response.ok) throw new Error(`control-plane answered ${response.status}`);
    return (await response.json()) as Ruleset;
  }

  get subscribe(): RulesetChannel['subscribe'] {
    if (this.options.stream === false) return undefined;
    return (listener) => {
      let stopped = false;
      let controller: AbortController | undefined;
      void (async () => {
        let backoff = 1000;
        while (!stopped) {
          controller = new AbortController();
          try {
            const response = await doFetch(this.options)(
              `${base(this.options.url)}/v1/ruleset/stream`,
              {
                headers: { ...(await this.#headers()), accept: 'text/event-stream' },
                signal: controller.signal,
              },
            );
            if (response.status === 401) this.options.token.invalidate?.();
            if (!response.ok || !response.body)
              throw new Error(`stream answered ${response.status}`);
            listener.connected(true);
            backoff = 1000;
            await readEvents(response.body, listener);
          } catch (error) {
            if (stopped) break;
            listener.error(error);
          } finally {
            listener.connected(false);
          }
          if (stopped) break;
          // The server closes the stream when the token expires; reconnect fetches a fresh one.
          await new Promise((resolve) => setTimeout(resolve, backoff).unref());
          backoff = Math.min(backoff * 2, 30_000);
          listener.changed();
        }
      })();
      return () => {
        stopped = true;
        controller?.abort();
      };
    };
  }

  async check(): Promise<void> {
    await httpCheck(this.options);
  }
}

async function readEvents(body: NonNullable<Response['body']>, listener: RulesetChannelListener) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const message = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (/^event: ruleset$/m.test(message)) listener.changed();
      boundary = buffer.indexOf('\n\n');
    }
  }
}

function needUrl(options: HttpTenantTransportOptions, ctx: TenantLinkContext): string {
  const url = options.url ?? ctx.url;
  if (!url)
    throw new Error(
      '[flags] the "http" tenant transport needs tenant.url (or tenantTransports.http({ url }))',
    );
  return url;
}

/** The default: POST for events, ETag + server-sent events for the ruleset. No peer. */
export function httpTransport(options: HttpTenantTransportOptions = {}): WatchTransport {
  const common = (ctx: TenantLinkContext): HttpOptions => ({
    url: needUrl(options, ctx),
    token: ctx.token,
    partition: ctx.partition,
    capabilities: ctx.capabilities,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  return {
    driver: 'http',
    canWatch: true,
    async push(ctx) {
      return new HttpPush({ ...common(ctx), retries: options.retries });
    },
    async watch(ctx) {
      return new HttpRulesetChannel({ ...common(ctx), stream: options.stream });
    },
    // The control-plane's HTTP routes are always mounted (browsers and OFREP use them too).
    async serve() {
      return { driver: 'http' };
    },
  };
}
