import type { HttpContext } from '@adonisjs/core/http';
import type { Subject, SubjectLike } from '../subject.js';

interface AuthLike {
  user?: { id?: string | number } | null;
  check?(): Promise<boolean>;
}

/** The part of `@adonis-agora/authkit-client`'s `Identity` this package reads. */
export interface AuthkitIdentityLike {
  userId: string;
  email?: string;
  globalRoles?: string[];
  profile?: { name?: string };
  orgId?: string | null;
  orgSlug?: string | null;
  orgRole?: string | null;
}

interface AuthkitLike {
  getIdentity(): Promise<AuthkitIdentityLike | null>;
}

/**
 * The subject for an authkit identity: the `sub` claim as id — the same person in every app, so a
 * user lands in the same bucket everywhere — and the verified claims as targeting attributes:
 *
 * | Attribute | From |
 * |---|---|
 * | `email`, `emailDomain` | the `email` claim |
 * | `globalRoles` | authkit global roles (an array: `in` matches any) |
 * | `orgId`, `orgSlug`, `orgRole` | the session's active organization |
 *
 * Roll out per organization with `bucketBy: 'orgId'`.
 */
export function subjectFromIdentity(identity: AuthkitIdentityLike): Subject {
  const attributes: Record<string, unknown> = {};
  if (identity.email) {
    attributes.email = identity.email;
    attributes.emailDomain = identity.email.split('@')[1]?.toLowerCase();
  }
  if (identity.globalRoles) attributes.globalRoles = identity.globalRoles;
  if (identity.orgId) attributes.orgId = identity.orgId;
  if (identity.orgSlug) attributes.orgSlug = identity.orgSlug;
  if (identity.orgRole) attributes.orgRole = identity.orgRole;
  return { id: identity.userId, type: 'user', attributes };
}

/**
 * The request's authkit surface: `ctx.authkit` (authkit-client 1.x), else `ctx.auth` when it is
 * authkit's authenticator (authkit-client 0.x's `authkit_middleware` puts it there and never sets
 * `ctx.authkit`). `@adonisjs/auth`'s authenticator has no `getIdentity`, so it is never mistaken
 * for it.
 */
function authkitOf(ctx: HttpContext): AuthkitLike | undefined {
  const holder = ctx as unknown as { authkit?: AuthkitLike; auth?: AuthkitLike };
  if (holder.authkit && typeof holder.authkit.getIdentity === 'function') return holder.authkit;
  if (holder.auth && typeof holder.auth.getIdentity === 'function') return holder.auth;
  return undefined;
}

/** The authkit identity of the request, from `@adonis-agora/authkit-client` (0.x or 1.x). */
export async function authkitIdentity(ctx: HttpContext): Promise<AuthkitIdentityLike | null> {
  const authkit = authkitOf(ctx);
  if (!authkit) return null;
  try {
    return await authkit.getIdentity();
  } catch {
    // An unreadable session is an anonymous visitor, not a flags error.
    return null;
  }
}

/**
 * A `subject` resolver for `config/flags.ts` that uses authkit only:
 * `subject: authkitSubject`. The default resolver already prefers authkit when it is installed.
 */
export async function authkitSubject(ctx: HttpContext): Promise<SubjectLike> {
  const identity = await authkitIdentity(ctx);
  return identity ? subjectFromIdentity(identity) : undefined;
}

/**
 * The default subject of `ctx.flags`:
 *
 * 1. the authkit identity (`ctx.authkit`, from `@adonis-agora/authkit-client`), with its claims as
 *    attributes — see {@link subjectFromIdentity};
 * 2. otherwise `ctx.auth.user` (`@adonisjs/auth`), checking the request's credentials silently when
 *    no middleware authenticated it yet;
 * 3. otherwise anonymous.
 */
export async function defaultSubject(ctx: HttpContext): Promise<SubjectLike> {
  const identity = await authkitIdentity(ctx);
  if (identity) return subjectFromIdentity(identity);
  const auth = (ctx as unknown as { auth?: AuthLike }).auth;
  if (!auth) return undefined;
  if (auth.user) return auth.user as SubjectLike;
  if (typeof auth.check === 'function') {
    try {
      if (await auth.check()) return (auth.user ?? undefined) as SubjectLike;
    } catch {
      // A broken credential is an anonymous visitor, not a flags error.
    }
  }
  return undefined;
}
