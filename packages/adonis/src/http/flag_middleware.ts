import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import { subjectResolver } from '../identity.js';
import { getRuntime } from '../services/accessor.js';
import type { FlagKey } from '../types.js';

export interface FlagGuardOptions {
  /** The flag that must be on (boolean) or serve one of `variants`. */
  flag: FlagKey;
  /** For multivariate flags: the variants allowed through. */
  variants?: string[];
  /** Status when the flag says no. Default 404 — a hidden feature should look absent. */
  status?: number;
}

/**
 * Route guard: lets the request through only when a flag allows it.
 *
 * ```ts
 * // start/kernel.ts
 * export const middleware = router.named({
 *   flag: () => import('@adonis-agora/flags/flag_middleware'),
 * })
 * // start/routes.ts
 * router.get('/checkout/new', [NewCheckoutController]).use(middleware.flag({ flag: 'new_checkout' }))
 * ```
 */
export default class FlagMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: FlagGuardOptions) {
    const runtime = getRuntime();
    const scope =
      (ctx as Partial<HttpContext>).flags ??
      runtime.manager.forLazy(() => subjectResolver(runtime.config)(ctx));
    const details = await scope.details(options.flag);
    const allowed = options.variants
      ? details.variant !== undefined && options.variants.includes(details.variant)
      : details.value === true;
    if (!allowed) {
      return ctx.response.status(options.status ?? 404).send({ message: 'Not found' });
    }
    return next();
  }
}
