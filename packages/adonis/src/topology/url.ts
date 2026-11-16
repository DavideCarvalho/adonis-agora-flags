/**
 * A control-plane URL resolved on first use, e.g. `controlPlaneUrl()` from
 * `@adonis-agora/authkit-client`. `refresh()` is called after a connection error or a 404, so a
 * control plane that moved is found again.
 */
export type LazyTenantUrl = (() => Promise<string>) & { refresh?(): Promise<string> };

/** `tenant.url`: the control-plane base URL, or a function resolving it. */
export type TenantUrl = string | LazyTenantUrl;

/** Whether `value` is a usable `tenant.url`. */
export function isTenantUrl(value: unknown): value is TenantUrl {
  return (typeof value === 'string' && value.length > 0) || typeof value === 'function';
}

function checked(url: unknown): string {
  if (typeof url !== 'string' || url.length === 0)
    throw new Error('[flags] tenant.url resolved to an empty value');
  return url.replace(/\/$/, '');
}

/**
 * One resolved `tenant.url`, shared by every channel of a tenant (events, ruleset, browser keys).
 * A string is used as is; a function is called before the first request and re-resolved by
 * {@link refresh}.
 */
export class ControlPlaneAddress {
  #current: string | undefined;
  #inflight: Promise<string> | undefined;

  constructor(private readonly source: TenantUrl) {
    if (typeof source === 'string') this.#current = checked(source);
  }

  /** Whether the URL is resolved lazily (a function). */
  get lazy(): boolean {
    return typeof this.source === 'function';
  }

  /** The base URL, without a trailing slash. Resolves a lazy URL on first call. */
  async get(): Promise<string> {
    if (this.#current !== undefined) return this.#current;
    const source = this.source as LazyTenantUrl;
    this.#inflight ??= (async () => {
      try {
        this.#current = checked(await source());
        return this.#current;
      } finally {
        this.#inflight = undefined;
      }
    })();
    return this.#inflight;
  }

  /**
   * Re-resolves a lazy URL (its `refresh()`, else calling it again). `true` when the URL changed,
   * so the request is worth retrying. Never throws: a failed refresh keeps the previous URL.
   */
  async refresh(): Promise<boolean> {
    if (!this.lazy) return false;
    const source = this.source as LazyTenantUrl;
    const before = this.#current;
    try {
      this.#current = checked(await (source.refresh ? source.refresh() : source()));
    } catch {
      return false;
    }
    return this.#current !== before;
  }
}

/** A `ControlPlaneAddress` for `url`, reusing it when it already is one. */
export function controlPlaneAddress(url: TenantUrl | ControlPlaneAddress): ControlPlaneAddress {
  return url instanceof ControlPlaneAddress ? url : new ControlPlaneAddress(url);
}

/**
 * `fetch(<control-plane>/<path>)`. On a connection error or a 404, a lazy URL is refreshed and the
 * request retried once when the URL changed. `init` is built per attempt (fresh timeout signal).
 */
export async function fetchControlPlane(
  address: ControlPlaneAddress,
  path: string,
  init: () => Promise<RequestInit> | RequestInit,
  doFetch: typeof fetch = (input, options) => fetch(input, options),
): Promise<Response> {
  const attempt = async () => doFetch(`${await address.get()}${path}`, await init());
  let response: Response;
  try {
    response = await attempt();
  } catch (error) {
    // A request we aborted ourselves (closing the stream) is not a connection error.
    if ((error as Error)?.name === 'AbortError') throw error;
    if (!(await address.refresh())) throw error;
    return attempt();
  }
  if (response.status === 404 && (await address.refresh())) return attempt();
  return response;
}
