import type { TenantTokenSource } from './token.js';
import { FLAGS_RESOURCE } from './token.js';
import type { LazyTenantUrl, TenantUrl } from './url.js';

/**
 * Zero-config tenant topology: `@adonis-agora/authkit-client`'s `tenantOf(resource)` (the
 * `'authkit.client'` binding, read structurally: this package never imports it) supplies
 * `tenant.url`, `tenant.token` and `tenant.partition` when config/flags.ts leaves them out.
 */

/** What `tenantOf(resource)` returns (authkit-client ≥ the release that added it). */
export interface AuthkitTenant {
  /** The control-plane URL discovered from the issuer; `refresh()` looks it up again. */
  url: LazyTenantUrl;
  /** The service token for the resource (client credentials), cached; `reset()` drops it. */
  token: (() => Promise<string>) & { reset?(): void };
  /** `service.partition` when configured, else `service.name`. */
  partition: string;
}

/** The part of the `'authkit.client'` binding this module uses. */
export interface AuthkitTenantSource {
  tenantOf(resource: string): AuthkitTenant;
}

/** Where each tenant field came from, shown by `agora:doctor`. */
export type TenantFieldSource = 'auto' | 'explicit' | 'none';

export interface TenantSources {
  url: TenantFieldSource;
  token: TenantFieldSource;
  partition: TenantFieldSource;
}

type TenantField = keyof TenantSources;
const FIELDS: readonly TenantField[] = ['url', 'token', 'partition'];

/** The tenant fields this module fills. */
export interface TenantFields {
  auto?: boolean;
  url?: TenantUrl | unknown;
  token?: TenantTokenSource | unknown;
  partition?: string;
}

interface ContainerLike {
  hasBinding(binding: never): boolean;
  make(binding: never): Promise<unknown>;
}

/**
 * authkit-client's binding when it is booted here and has `tenantOf` (an older authkit-client
 * without it counts as absent), else `undefined`. Never throws.
 */
export async function authkitTenantSourceOf(
  container: unknown,
): Promise<AuthkitTenantSource | undefined> {
  const c = container as ContainerLike | undefined;
  try {
    if (typeof c?.hasBinding !== 'function' || !c.hasBinding('authkit.client' as never)) {
      return undefined;
    }
    const client = (await c.make('authkit.client' as never)) as { tenantOf?: unknown } | undefined;
    return client && typeof client.tenantOf === 'function'
      ? (client as AuthkitTenantSource)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a field is set in config/flags.ts (`''`, `null` and `undefined` are not). */
function given(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** `tenant.url` is needed only where HTTP is used (the default transport, the ruleset, browsers). */
export function tenantNeedsUrl(
  tenant: { transport?: { driver?: string; canWatch?: boolean }; watch?: { driver?: string } },
  browser: boolean,
): boolean {
  const push = tenant.transport;
  const watch = tenant.watch;
  const usesHttp =
    !push || push.driver === 'http' || (watch ? watch.driver === 'http' : push.canWatch !== true);
  return usesHttp || browser;
}

/** The fields still missing from `tenant` (url only where it is needed). */
export function missingTenantFields(
  tenant: (TenantFields & Parameters<typeof tenantNeedsUrl>[0]) | undefined,
  browser: boolean,
): TenantField[] {
  const t = tenant ?? {};
  const missing: TenantField[] = [];
  if (!given(t.url) && tenantNeedsUrl(t, browser)) missing.push('url');
  if (!given(t.token)) missing.push('token');
  if (!given(t.partition)) missing.push('partition');
  return missing;
}

/** The boot error naming the missing fields and both fixes. */
export class TenantConfigError extends Error {
  constructor(
    readonly missing: string[],
    cause?: string,
  ) {
    super(
      `[@adonis-agora/flags] topology 'tenant' needs tenant.${missing.join(', ')}. Configure @adonis-agora/authkit-client's \`service\` (config/authkit.ts: service: { name, clientId, clientSecret }) so they are discovered from the issuer, or pass tenant: { url, token, partition } in config/flags.ts.${cause ? ` (authkit-client: ${cause})` : ''}`,
    );
    this.name = 'TenantConfigError';
  }
}

/**
 * Fills the tenant fields config/flags.ts leaves out from authkit-client's `tenantOf`, field by
 * field (anything explicit wins). `tenantOf` is called only when a needed field is missing and
 * `tenant.auto` is not `false`. Throws {@link TenantConfigError} when a needed field stays missing.
 */
export async function resolveTenantFields<T extends TenantFields>(
  tenant: T | undefined,
  options: {
    container?: unknown;
    browser?: boolean;
    resource?: string;
  } = {},
): Promise<{
  tenant: T & { token: TenantTokenSource; partition: string };
  sources: TenantSources;
}> {
  const explicit = (tenant ?? {}) as T;
  const browser = options.browser ?? false;
  const sources: TenantSources = {
    url: given(explicit.url) ? 'explicit' : 'none',
    token: given(explicit.token) ? 'explicit' : 'none',
    partition: given(explicit.partition) ? 'explicit' : 'none',
  };
  const merged: TenantFields = { ...explicit };
  const missing = missingTenantFields(explicit as never, browser);
  let cause: string | undefined;
  if (missing.length > 0 && explicit.auto !== false) {
    const source = await authkitTenantSourceOf(options.container);
    if (source) {
      try {
        const auto = source.tenantOf(options.resource ?? FLAGS_RESOURCE);
        for (const field of FIELDS) {
          if (sources[field] === 'explicit') continue;
          const value = auto?.[field];
          if (!given(value)) continue;
          (merged as Record<string, unknown>)[field] = value;
          sources[field] = 'auto';
        }
      } catch (error) {
        cause = error instanceof Error ? error.message : String(error);
      }
    }
  }
  const still = missingTenantFields(merged as never, browser);
  if (still.length > 0) throw new TenantConfigError(still, cause);
  return {
    tenant: merged as T & { token: TenantTokenSource; partition: string },
    sources,
  };
}

/** `tenant url: authkit-client (auto), token: explicit, partition: explicit`. */
export function describeTenantSources(sources: TenantSources): string {
  const label = (source: TenantFieldSource) =>
    source === 'auto' ? 'authkit-client (auto)' : source === 'explicit' ? 'explicit' : 'none';
  return `tenant url: ${label(sources.url)}, token: ${label(sources.token)}, partition: ${label(sources.partition)}`;
}
