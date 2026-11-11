import type { FlagEvent } from '../events/event.js';
import type { TokenSource } from '../topology/token.js';
import type { Transport } from './transport.js';

export interface HttpTransportOptions {
  /** The control-plane base URL (`https://flags.example.com/_flags`). */
  url: string;
  token: TokenSource;
  /** The tenant's partition, sent as `x-flags-tenant` (the token decides what it really is). */
  partition: string;
  /** Retries per batch on network errors and 5xx. Default 3. */
  retries?: number;
  fetch?: typeof fetch;
}

/**
 * A tenant's transport: batches go to the control-plane over HTTP, which writes them into its own
 * transport and fans them out to the sinks. Nothing is stored locally, so there is no relay on a
 * tenant — the buffer in front of it retries, and events still unsent when the process dies are lost.
 */
export class HttpTransport implements Transport {
  readonly name = 'http';
  readonly capabilities = { transactional: false, durable: false };
  readonly #fetch: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.#fetch = options.fetch ?? fetch;
  }

  async publish(events: FlagEvent[]): Promise<void> {
    if (events.length === 0) return;
    const retries = this.options.retries ?? 3;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await this.#fetch(`${this.options.url.replace(/\/$/, '')}/v1/events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${await this.options.token.get()}`,
            'x-flags-tenant': this.options.partition,
          },
          body: JSON.stringify({ events }),
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
}
