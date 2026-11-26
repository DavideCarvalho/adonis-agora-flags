import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useState } from 'react';
import {
  type ConsoleCapabilityTable,
  consoleCapabilityAllows,
} from '../client/console_capabilities';
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

/** The console capabilities the UI gates on (the server refuses the same with `403`). */
export const CAN_WRITE = 'flags:console:write';
export const CAN_APPROVE = 'flags:console:approve';

/** flags' console capabilities for the shared matcher (approve is in neither list on purpose). */
const TABLE: ConsoleCapabilityTable = {
  'flags:console:read': 'read',
  [CAN_WRITE]: 'write',
};

/** Whether the viewer may do `capability`: everything when the server sent no capabilities. */
export function canDo(meta: Meta | undefined, capability: string): boolean {
  const capabilities = meta?.capabilities;
  return capabilities === undefined || consoleCapabilityAllows(capabilities, capability, TABLE);
}

export function useCan(capability: string): boolean {
  return canDo(useEnv().meta, capability);
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
  const allowed = useCan(CAN_WRITE);
  const [notice, setNotice] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (input: TInput) => {
      if (!allowed) throw new Error(`You lack ${CAN_WRITE}: this console is read-only for you.`);
      return run(input);
    },
    onSuccess: async (result) => {
      setNotice(describeWrite(result));
      onNotice?.(describeWrite(result));
      await client.invalidateQueries();
    },
    onError: () => setNotice(null),
  });
  return {
    ...mutation,
    /** Whether the viewer may make this change at all. */
    allowed,
    /** Disable the control: the write is running, or the viewer may not make it. */
    blocked: mutation.isPending || !allowed,
    notice,
    clearNotice: () => setNotice(null),
  };
}

/** The outcome line under a form. */
export function Notice({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <p role="status" className="text-[11px] text-dim">
      {text}
    </p>
  );
}
