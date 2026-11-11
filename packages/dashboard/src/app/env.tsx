import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useState } from 'react';
import type { Meta, WriteResult } from '../client/flags-client';

/**
 * The environment every screen reads and writes. It comes from the hash (`?env=`) and falls back
 * to the app's own; the shell owns it, screens only read it.
 */
export interface EnvState {
  environment: string;
  meta: Meta | undefined;
}

const EnvContext = createContext<EnvState>({ environment: 'production', meta: undefined });

export function EnvProvider({ value, children }: { value: EnvState; children: ReactNode }) {
  return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
}

export function useEnv(): EnvState {
  return useContext(EnvContext);
}

/** What the operator is told after a write: applied, or waiting for someone else. */
export function describeWrite(result: WriteResult): string {
  if (result.status === 'applied') return `Applied (version ${result.version}).`;
  return 'Filed for approval: a second person has to approve it in Approvals before it applies.';
}

/**
 * A write: runs it, refetches every query (a flag edit changes the list, the detail, the audit
 * trail and maybe the pending approvals), and keeps the outcome sentence for the screen to show.
 */
export function useWrite<TInput>(
  run: (input: TInput) => Promise<WriteResult>,
  /** Also told the outcome — for a parent that outlives the component doing the write. */
  onNotice?: (notice: string) => void,
) {
  const client = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: run,
    onSuccess: async (result) => {
      setNotice(describeWrite(result));
      onNotice?.(describeWrite(result));
      await client.invalidateQueries();
    },
    onError: () => setNotice(null),
  });
  return { ...mutation, notice, clearNotice: () => setNotice(null) };
}

/** The outcome line under a form. */
export function Notice({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <p role="status" className="text-[11px] text-zinc-400">
      {text}
    </p>
  );
}
