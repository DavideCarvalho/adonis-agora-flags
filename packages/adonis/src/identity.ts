import type { HttpContext } from '@adonisjs/core/http';
import type { AdminAction, AdminAuthorizer } from './admin.js';
import type { ConsoleAuthorizeResult } from './dashboard/console_authorize.js';
import { authkitIdentity, defaultSubject, subjectFromIdentity } from './http/subject_resolver.js';
import type { Actor } from './stores/store.js';
import type { SubjectLike } from './subject.js';

/**
 * How flags learns who people are — the one contract between this package and your auth, the way
 * a user provider is for `@adonisjs/auth`. Implement it for any auth setup, or use a built-in:
 * `identities.authkit()` or `identities.adonisAuth()`.
 *
 * | Method | Used by |
 * |---|---|
 * | `subject` | `ctx.flags`, the route guard, Edge, the browser token endpoint |
 * | `actor` | the console: audit log and approvals |
 * | `authorizeConsole` | the console: who may open it |
 * | `can` | every change — console, `node ace flags:*`, the admin API |
 *
 * Options set directly in the configs win over the provider: `subject` and `authorize` in
 * `config/flags.ts`, `actor` and `authorize` in `config/flags_dashboard.ts`.
 */
export interface FlagsIdentityProvider {
  /** Who flags are evaluated for in this request. `undefined`: an anonymous visitor. */
  subject(ctx: HttpContext): SubjectLike | Promise<SubjectLike>;
  /**
   * The person acting in the console. `id` is what approvals compare: nobody approves their own
   * change. `undefined`: anonymous, refused in environments that need approval.
   */
  actor?(ctx: HttpContext): Actor | undefined | Promise<Actor | undefined>;
  /**
   * Who may open the console. Same answers as every Agora console: `true`/`false`,
   * `{ allowed: false, reason: 'unauthenticated' }` (401), `{ redirectTo: '/login' }`.
   */
  authorizeConsole?(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
  /**
   * Whether `actor` may `read`, `write` or `approve` in an environment. Runs outside HTTP too
   * (commands act as `cli:<os user>`), so load what you need from the actor's id.
   */
  can?(
    actor: Actor,
    action: AdminAction,
    target: Parameters<AdminAuthorizer>[2],
  ): boolean | Promise<boolean>;
}

interface AuthkitLike {
  getIdentity(): Promise<{ globalRoles?: string[] } | null>;
}

interface GuardLike {
  user?: Record<string, unknown> | null;
  check?(): Promise<boolean>;
}

interface AuthLike extends GuardLike {
  use?(guard: string): GuardLike;
}

function nameOf(user: Record<string, unknown>): string | undefined {
  return [user.fullName, user.name, user.email].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
}

export interface AuthkitIdentityOptions {
  /** Global role required to open the console. Default `ADMIN`. */
  consoleRole?: string;
  /** Where to send people who are not signed in. Default: answer 401. */
  loginPath?: string;
  /** Who may change what. Default: anyone the console lets in (and every command). */
  can?: FlagsIdentityProvider['can'];
}

export interface AdonisAuthIdentityOptions<User = Record<string, unknown>> {
  /** The guard to read. Default: the default guard. */
  guard?: string;
  /** Subject type stored on events. Default `user`. */
  type?: string;
  /** Where to send people who are not signed in. Default: answer 401. */
  loginPath?: string;
  /**
   * Who may open the console, once signed in — typically a Bouncer ability:
   * `(user, ctx) => ctx.bouncer.allows(manageFlags)`. Without it, the console falls back to its
   * default (open outside production, closed in production).
   */
  canOpenConsole?(user: User, ctx: HttpContext): boolean | Promise<boolean>;
  /** Who may change what. Default: anyone the console lets in (and every command). */
  can?: FlagsIdentityProvider['can'];
}

/** The signed-in user of `ctx.auth` (or one guard), checking the request silently. */
async function signedInUser(ctx: HttpContext, guard?: string) {
  const auth = (ctx as unknown as { auth?: AuthLike }).auth;
  if (!auth) return null;
  const scoped = guard && auth.use ? auth.use(guard) : auth;
  if (scoped.user) return scoped.user;
  if (typeof scoped.check !== 'function') return null;
  try {
    return (await scoped.check()) ? (scoped.user ?? null) : null;
  } catch {
    return null;
  }
}

export const identities = {
  /**
   * `@adonis-agora/authkit-client`: the session's identity as subject (`sub`, email, global roles,
   * active organization) and as the console actor; the console needs the `ADMIN` global role.
   */
  authkit(options: AuthkitIdentityOptions = {}): FlagsIdentityProvider {
    return {
      async subject(ctx) {
        const identity = await authkitIdentity(ctx);
        return identity ? subjectFromIdentity(identity) : undefined;
      },
      async actor(ctx) {
        const identity = await authkitIdentity(ctx);
        if (!identity) return undefined;
        const name = identity.profile?.name ?? identity.email;
        return name ? { id: identity.userId, name } : { id: identity.userId };
      },
      async authorizeConsole(ctx) {
        const authkit = (ctx as unknown as { authkit?: AuthkitLike }).authkit;
        const identity = authkit ? await authkit.getIdentity().catch(() => null) : null;
        if (!identity) {
          return options.loginPath
            ? { redirectTo: options.loginPath }
            : { allowed: false, reason: 'unauthenticated' };
        }
        return (identity.globalRoles ?? []).includes(options.consoleRole ?? 'ADMIN');
      },
      ...(options.can ? { can: options.can } : {}),
    };
  },

  /**
   * `@adonisjs/auth`: `ctx.auth.user` as subject (its `id`) and as the console actor (its `id`, and
   * `fullName`/`name`/`email`). Gate the console with `canOpenConsole` — a Bouncer ability, a role
   * column, anything. Targeting attributes come from `attributes` in `config/flags.ts`.
   */
  adonisAuth<User = Record<string, unknown>>(
    options: AdonisAuthIdentityOptions<User> = {},
  ): FlagsIdentityProvider {
    return {
      async subject(ctx) {
        const user = await signedInUser(ctx, options.guard);
        if (!user || (typeof user.id !== 'string' && typeof user.id !== 'number')) return undefined;
        return { id: user.id, type: options.type ?? 'user' };
      },
      async actor(ctx) {
        const user = await signedInUser(ctx, options.guard);
        if (!user || user.id === undefined || user.id === null) return undefined;
        const name = nameOf(user);
        return name ? { id: String(user.id), name } : { id: String(user.id) };
      },
      ...(options.canOpenConsole
        ? {
            async authorizeConsole(ctx: HttpContext): Promise<ConsoleAuthorizeResult> {
              const user = await signedInUser(ctx, options.guard);
              if (!user) {
                return options.loginPath
                  ? { redirectTo: options.loginPath }
                  : { allowed: false, reason: 'unauthenticated' };
              }
              return options.canOpenConsole!(user as User, ctx);
            },
          }
        : {}),
      ...(options.can ? { can: options.can } : {}),
    };
  },
};

/** The subject resolver in effect: `config.subject`, else the provider's, else the default. */
export function subjectResolver(config: {
  subject?: ((ctx: HttpContext) => SubjectLike | Promise<SubjectLike>) | undefined;
  identity?: FlagsIdentityProvider | undefined;
}): (ctx: HttpContext) => Promise<SubjectLike> {
  if (config.subject) {
    const subject = config.subject;
    return async (ctx) => subject(ctx);
  }
  const identity = config.identity;
  if (identity) return async (ctx) => identity.subject(ctx);
  return defaultSubject;
}
