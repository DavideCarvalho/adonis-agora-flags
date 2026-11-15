import { isPoison, type MessageDedupe, PoisonMessageError } from './message.js';
import type { HandledMessage, TenantMessageHandler } from './types.js';

/** The fields of a raw payload worth showing on a dead letter (never the token). */
export function describeRaw(raw: unknown): { id?: string; kind?: string; partition?: string } {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  const pick = (key: string) =>
    typeof v[key] === 'string' ? { [key]: (v[key] as string).slice(0, 200) } : {};
  return { ...pick('id'), ...pick('kind'), ...pick('partition') };
}

/**
 * Runs one broker message through the handler. Answers the handled message, or `null` when it was
 * dead-lettered (poison, or `attempt` reached `maxAttempts`). Throws on a transient failure so the
 * broker retries it.
 */
export async function consume(
  handler: TenantMessageHandler,
  driver: string,
  raw: unknown,
  options: {
    dedupe?: MessageDedupe | undefined;
    attempt?: number;
    maxAttempts?: number;
    /** Extra place to keep the dead letter (a dead stream, a failed job set). */
    onDead?: (error: Error) => Promise<void>;
  } = {},
): Promise<HandledMessage | null> {
  try {
    return await handler.handle(raw, driver, { dedupe: options.dedupe });
  } catch (error) {
    const poison = isPoison(error);
    const exhausted =
      options.maxAttempts !== undefined && (options.attempt ?? 1) >= options.maxAttempts;
    if (!poison && !exhausted) throw error;
    const err = error as Error;
    await handler.deadLetter({
      driver,
      ...describeRaw(raw),
      reason: poison ? (error as PoisonMessageError).reason : 'exhausted',
      error: err.message,
    });
    await options.onDead?.(err).catch(() => {});
    return null;
  }
}

/** Waits `ms` without holding the process open. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}

/** Loads an optional peer, with a clear message when it is missing. */
export async function loadPeer<T>(name: string, driver: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ name)) as T;
  } catch (error) {
    throw new Error(
      `[flags] the "${driver}" tenant transport needs ${name} (npm install ${name}): ${(error as Error).message}`,
    );
  }
}
