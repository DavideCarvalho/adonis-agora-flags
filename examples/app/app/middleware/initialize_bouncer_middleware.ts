import { Bouncer } from '@adonisjs/bouncer'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import * as abilities from '#abilities/main'

/** `ctx.bouncer` for the request's user, as `node ace configure @adonisjs/bouncer` publishes it. */
export default class InitializeBouncerMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    ctx.bouncer = new Bouncer(() => ctx.auth.user || null, abilities, {}).setContainerResolver(
      ctx.containerResolver
    )
    return next()
  }
}

declare module '@adonisjs/core/http' {
  export interface HttpContext {
    bouncer: Bouncer<Exclude<HttpContext['auth']['user'], undefined>, typeof abilities, {}>
  }
}
