import type { HttpContext } from '@adonisjs/core/http';
import type { SubjectLike } from '../subject.js';

interface AuthLike {
  user?: { id?: string | number } | null;
  check?(): Promise<boolean>;
}

/**
 * The default subject of `ctx.flags`: the authenticated user (`ctx.auth.user`), checking the
 * request's credentials silently when no middleware authenticated it yet. Anonymous otherwise.
 */
export async function defaultSubject(ctx: HttpContext): Promise<SubjectLike> {
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
