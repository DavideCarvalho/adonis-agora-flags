import type { Actor } from '../stores/store.js';

/** Who a change is attributed to when nobody can be identified. */
export const FALLBACK_ACTOR: Actor = { id: 'dashboard', anonymous: true };

/**
 * The default `actor`: the signed-in user (`ctx.auth.user`, read structurally — this package does
 * not depend on `@adonisjs/auth`). `id` is the user's `id`; `name` its `email` or `name`.
 * `'dashboard'` when nobody is signed in.
 */
export function defaultActor(ctx: unknown): Actor {
  const user = (ctx as { auth?: { user?: Record<string, unknown> | null } } | null)?.auth?.user;
  if (!user) return FALLBACK_ACTOR;
  const id = user.id;
  const name = [user.email, user.name].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  if (typeof id === 'string' && id !== '') return name ? { id, name } : { id };
  if (typeof id === 'number' || typeof id === 'bigint') {
    return name ? { id: String(id), name } : { id: String(id) };
  }
  return name ? { id: name, name } : FALLBACK_ACTOR;
}

/** Normalize what a configured `actor` resolver returned. */
export function toActor(value: unknown): Actor {
  if (typeof value === 'string' && value !== '') return { id: value };
  if (typeof value === 'object' && value !== null) {
    const { id, name } = value as { id?: unknown; name?: unknown };
    if (typeof id === 'string' && id !== '') {
      return typeof name === 'string' && name !== '' ? { id, name } : { id };
    }
  }
  return FALLBACK_ACTOR;
}
