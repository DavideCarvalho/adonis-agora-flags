import type { EvaluationContext } from '@adonis-agora/flags-core';

/**
 * Who a flag is evaluated for. Same vocabulary as `@adonis-agora/authz`: a subject has an id and a
 * type (`user`, `organization`, …). With authkit as the IdP, use the `sub` claim as the id so the
 * same person lands in the same bucket in every app.
 */
export interface Subject {
  id: string | number;
  /** Default `user`. Stored on events; does not change bucketing. */
  type?: string;
  /** Targeting attributes (`plan`, `country`, `orgId`, …). Must come from trusted server state. */
  attributes?: Record<string, unknown>;
}

/** Anything `flags.for()` accepts: a subject, a bare id, or a model with an `id`. */
export type SubjectLike = Subject | string | number | { id: string | number } | null | undefined;

/** Normalizes {@link SubjectLike}. `null`/`undefined` is the anonymous subject (no targeting key). */
export function toSubject(input: SubjectLike): Subject | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === 'string' || typeof input === 'number') return { id: input };
  const candidate = input as Partial<Subject>;
  if (candidate.id === undefined || candidate.id === null) return undefined;
  return {
    id: candidate.id,
    ...(candidate.type !== undefined ? { type: candidate.type } : {}),
    ...(candidate.attributes !== undefined ? { attributes: candidate.attributes } : {}),
  };
}

/**
 * The evaluation context for a subject. The targeting key is the subject id; the type travels as
 * the `subjectType` attribute so rules can target it.
 */
export function toContext(
  subject: Subject | undefined,
  extra: Record<string, unknown> = {},
): EvaluationContext {
  if (!subject) return { ...extra };
  return {
    ...extra,
    ...subject.attributes,
    subjectType: subject.type ?? 'user',
    targetingKey: String(subject.id),
  };
}
