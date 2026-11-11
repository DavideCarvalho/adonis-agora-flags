import type { HttpContext } from '@adonisjs/core/http';
import type { NextFn } from '@adonisjs/core/types/http';
import type { FlagsScope } from '../manager.js';
import { getRuntime } from '../services/accessor.js';
import { defaultSubject } from './subject_resolver.js';

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /** Flags for this request's subject. Set by `@adonis-agora/flags/flags_middleware`. */
    flags: FlagsScope;
  }
}

/**
 * Puts `ctx.flags` on every request, and shares it with Edge views as `flags`. The subject is
 * resolved lazily — on the first flag read — so requests that never read a flag pay nothing, and
 * the auth middleware may run before or after this one.
 *
 * Register it in `start/kernel.ts` (router middleware): `() => import('@adonis-agora/flags/flags_middleware')`.
 */
export default class FlagsMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const runtime = getRuntime();
    const resolve = runtime.config.subject ?? defaultSubject;
    ctx.flags = runtime.manager.forLazy(() => resolve(ctx));
    const view = (ctx as unknown as { view?: { share(data: Record<string, unknown>): void } }).view;
    view?.share({ flags: ctx.flags });
    return next();
  }
}
