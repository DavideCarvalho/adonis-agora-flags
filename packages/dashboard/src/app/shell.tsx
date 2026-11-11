import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Issue } from '../client/flags-client';
import { cn } from './ui/cn';

/** A bordered surface with a heading — the one container every screen uses. */
export function Panel({
  title,
  subtitle,
  actions,
  className,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('rounded-sm border border-line bg-panel', className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm text-zinc-200">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="min-w-0 max-w-full">{actions}</div>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

/** Loading / error / empty, rendered once. The error shows the server's own sentence. */
export function QueryState<T>({
  query,
  empty,
  emptyMessage,
  children,
}: {
  query: UseQueryResult<T>;
  empty: boolean;
  emptyMessage?: string;
  children: ReactNode;
}) {
  if (query.isPending) return <p className="p-4 text-sm text-zinc-500">Loading…</p>;
  if (query.isError) return <ErrorBox error={query.error} />;
  if (empty) {
    return <p className="p-4 text-sm text-zinc-500">{emptyMessage ?? 'Nothing here yet.'}</p>;
  }
  return <>{children}</>;
}

export function ErrorBox({ error }: { error: unknown }) {
  const issues = (error as { issues?: Issue[] } | null)?.issues ?? [];
  return (
    <div role="alert" className="rounded-sm border border-bad/40 bg-bad/10 p-3">
      <p className="text-sm text-rose-300">
        {error instanceof Error ? error.message : 'Request failed.'}
      </p>
      <IssueList issues={issues} />
    </div>
  );
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`} className="text-rose-200">
          <span className="mono text-rose-300/80">{issue.path}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** A table with the console's header styling. */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="border-b border-line text-[10px] uppercase tracking-wider text-zinc-500">
        <tr>
          {head.map((label) => (
            <th key={label} className="px-4 py-2 font-normal">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line-soft">{children}</tbody>
    </table>
  );
}

/** "2026-11-11 14:05" in the viewer's zone — every timestamp in the console. */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
