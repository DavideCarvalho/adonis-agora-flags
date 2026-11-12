/**
 * Routes `@adonisjs/shield`'s CSRF check must skip: the flags API (`<prefix>/v1/*`) and OFREP
 * (`/ofrep/v1/*`). They authenticate every request with a bearer token and never with cookies, so
 * there is nothing for a cross-site request to forge — but left in, shield refuses their POSTs
 * (browsers calling the flags API, tenants sending events to a control-plane).
 *
 * ```ts
 * // config/shield.ts
 * import { flagsCsrfExceptions } from '@adonis-agora/flags'
 *
 * csrf: {
 *   enabled: true,
 *   exceptRoutes: (ctx) => flagsCsrfExceptions(ctx.request.url()),
 * }
 * ```
 *
 * The console and the token endpoint stay protected: they run on the session cookie.
 */
export function flagsCsrfExceptions(url: string, options: { prefix?: string } = {}): boolean {
  const prefix = (options.prefix ?? '/_flags').replace(/\/$/, '');
  const path = url.split('?')[0] ?? '';
  return path.startsWith(`${prefix}/v1/`) || path.startsWith('/ofrep/v1/');
}
