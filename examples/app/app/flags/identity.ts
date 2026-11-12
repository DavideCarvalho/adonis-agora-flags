import { randomUUID } from 'node:crypto'
import type { HttpContext } from '@adonisjs/core/http'
import { Bouncer } from '@adonisjs/bouncer'
import type { Actor, AdminAction, FlagsIdentityProvider } from '@adonis-agora/flags'
import User from '#models/user'
import { changeProductionFlags, manageFlags } from '#abilities/main'

/**
 * The identity provider of docs/authentication.mdx ("Your own provider"), verbatim apart from
 * types: @adonisjs/auth sessions, Bouncer abilities, and a cookie id for anonymous visitors.
 */
export default class AppFlagsIdentity implements FlagsIdentityProvider {
  /** Signed-in users by id; visitors by a cookie, so they keep their variant until they sign up. */
  async subject(ctx: HttpContext) {
    if (await ctx.auth.check()) return { id: ctx.auth.user!.id, type: 'user' }
    let anonymousId = ctx.request.cookie('anon_id')
    if (!anonymousId) {
      anonymousId = randomUUID()
      ctx.response.cookie('anon_id', anonymousId, { maxAge: '1y' })
    }
    return { id: anonymousId, type: 'anonymous' }
  }

  async actor(ctx: HttpContext) {
    if (!(await ctx.auth.check())) return undefined
    const user = ctx.auth.user!
    return { id: String(user.id), name: user.fullName ?? user.email }
  }

  async authorizeConsole(ctx: HttpContext) {
    if (!(await ctx.auth.check())) return { redirectTo: '/login' }
    return ctx.bouncer.allows(manageFlags)
  }

  /** Runs outside HTTP too, so it loads the user from the actor's id. */
  async can(actor: Actor, action: AdminAction, { environment }: { environment: string }) {
    if (actor.id.startsWith('cli:')) return true // node ace flags:* — shell access is already trusted
    if (action === 'read') return true
    const user = await User.find(actor.id)
    if (!user) return false
    const bouncer = new Bouncer(user)
    return environment === 'production'
      ? bouncer.allows(changeProductionFlags)
      : bouncer.allows(manageFlags)
  }
}
