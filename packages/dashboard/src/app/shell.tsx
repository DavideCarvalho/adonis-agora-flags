import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { RegionError } from '../agora-kit/blocks/error-boundary';
import { errorStatus } from '../agora-kit/blocks/query-boundary';
import { cn } from '../agora-kit/lib/utils';
import { Card } from '../agora-kit/ui/card';
import { Skeleton } from '../agora-kit/ui/skeleton';
import type { Issue } from '../client/flags-client';

/**
 * A titled card (the kit's Panel look: authkit `.panel`): title and a one-line subtitle on the
 * left, actions on the right, the body edge to edge under the header rule so tables and forms run
 * full width. The flags screens' one container.
 */
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
    <Card
      className={cn(
        'agora-surface agora-rise gap-0 rounded-lg border border-border py-0 shadow-none ring-0',
        className,
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[12.5px] font-semibold tracking-[0.02em] text-fg">{title}</h2>
          {subtitle !== undefined && <p className="mt-0.5 text-[11px] text-faint">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="min-w-0 max-w-full">{actions}</div>}
      </header>
      <div className="overflow-x-auto">{children}</div>
    </Card>
  );
}

/** Table-shaped stand-in while a list loads: a header rule and a few rows of bars. */
export function TableSkeleton({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <div className="divide-y divide-line-soft" aria-hidden data-testid="table-skeleton">
      {Array.from({ length: rows }, (_, row) => `row-${row}`).map((rowKey) => (
        <div key={rowKey} className="flex items-center gap-4 px-4 py-3">
          {Array.from({ length: columns }, (_, col) => `${rowKey}-${col}`).map((key, col) => (
            <Skeleton
              key={key}
              className={cn('h-3', col === 0 ? 'w-1/4' : col === columns - 1 ? 'w-12' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A data region's four states, rendered once: a shaped skeleton while pending, a retryable error
 * (the server's own sentence and its issues; an access message on 401/403), a designed empty
 * state, then the content.
 */
export function QueryState<T>({
  query,
  empty,
  emptyMessage,
  emptyTitle,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  empty: boolean;
  emptyMessage?: string;
  emptyTitle?: string;
  skeleton?: ReactNode;
  children: ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <TableSkeleton />}</>;
  if (query.isError) {
    const status = errorStatus(query.error);
    if (status === 401 || status === 403) {
      return (
        <div className="p-4">
          <RegionError
            title={status === 401 ? 'Signed out' : 'Not allowed'}
            error={
              status === 401
                ? 'Your session ended. Sign in again to continue.'
                : 'Your account is not allowed to read this.'
            }
          />
        </div>
      );
    }
    return (
      <div className="p-4">
        <ErrorBox error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }
  if (empty) {
    return (
      <EmptyState
        title={emptyTitle ?? 'Nothing here yet'}
        description={emptyMessage ?? 'Nothing to show for this environment.'}
      />
    );
  }
  return <>{children}</>;
}

/** A failed request or write: the server's sentence, the issues by field, and a retry. */
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const issues = (error as { issues?: Issue[] } | null)?.issues ?? [];
  // A failed read carries no issues: the kit's retryable region error. A failed write keeps its
  // issues by field.
  if (onRetry && issues.length === 0) {
    return <RegionError title="Request failed" error={messageOf(error)} onRetry={onRetry} />;
  }
  return (
    <div role="alert" className="rounded-lg border border-bad/25 bg-bad/5 p-3">
      <p className="text-sm text-bad">{messageOf(error)}</p>
      <IssueList issues={issues} />
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.';
}

export function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`} className="text-fg-2">
          <span className="mono text-bad">{issue.path}</span> {issue.message}
        </li>
      ))}
    </ul>
  );
}

/** A table with the kit's header styling (authkit `table`: caps faint head, hairline rows). */
export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full text-left text-xs">
      <thead className="border-b border-border text-[10px] font-semibold uppercase tracking-[0.1em] text-faint">
        <tr>
          {head.map((label) => (
            <th key={label} className="whitespace-nowrap px-4 py-2.5 font-semibold">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-line-soft text-fg-2">{children}</tbody>
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
