import { vi } from 'vitest';
import { CONFIG_ELEMENT_ID } from './flags-client';

/**
 * Test helper: puts (or extends) the provider's JSON config block on the page, the way
 * `renderIndexHtml` does. Only specs import it, so it never reaches the SPA bundle.
 */
export function injectConfig(config: Record<string, unknown>): void {
  let el = document.getElementById(CONFIG_ELEMENT_ID);
  const current: Record<string, unknown> = el ? JSON.parse(el.textContent ?? '{}') : {};
  if (!el) {
    el = document.createElement('script');
    el.setAttribute('type', 'application/json');
    el.id = CONFIG_ELEMENT_ID;
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify({ ...current, ...config });
}

/** Removes the config block, so the next test starts from a page the provider never injected. */
export function clearConfig(): void {
  document.getElementById(CONFIG_ELEMENT_ID)?.remove();
}

export interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

/**
 * Stubs `fetch` with a router: `route(method, url)` returns the JSON body (or `{ status, body }`).
 * Every call is recorded so a spec can assert what the screen sent.
 */
export function stubFetch(route: (method: string, url: string, body: unknown) => unknown): {
  calls: Call[];
} {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = route(method, url, body);
    const { status, payload } =
      typeof answer === 'object' && answer !== null && '__status' in answer
        ? {
            status: (answer as { __status: number }).__status,
            payload: (answer as unknown as { body: unknown }).body,
          }
        : { status: 200, payload: answer };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'ERR',
      json: async () => payload,
    } as Response;
  }) as typeof globalThis.fetch;
  return { calls };
}

/** A non-200 answer for {@link stubFetch}. */
export function status(code: number, body: unknown) {
  return { __status: code, body };
}
