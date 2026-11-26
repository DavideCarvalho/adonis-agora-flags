import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { parseAsStringLiteral, useQueryState } from 'nuqs';
import { useState } from 'react';
import { api, type ChangeRequest } from '../client/flags-client';
import { CAN_APPROVE, CAN_WRITE, useCan, useEnv } from './env';
import { ErrorBox, Panel, QueryState, Stamps } from './shell';
import { Badge } from './ui/badge';
import { Button, Input } from './ui/form';
import { Segmented } from './ui/segmented';

function describeChange(request: ChangeRequest): string {
  const { change } = request;
  const verb = change.value === null ? 'delete' : change.entity === 'ruleset' ? 'replace' : 'set';
  return `${verb} ${change.entity}${change.key ? ` ${change.key}` : ''}`;
}

function RequestRow({ request, me }: { request: ChangeRequest; me: string }) {
  const client = useQueryClient();
  const [note, setNote] = useState('');
  const done = () => client.invalidateQueries();
  const approve = useMutation({
    mutationFn: () => api.approve(request.id, note || undefined),
    onSuccess: done,
  });
  const reject = useMutation({
    mutationFn: () => api.reject(request.id, note || undefined),
    onSuccess: done,
  });
  const cancel = useMutation({ mutationFn: () => api.cancel(request.id), onSuccess: done });
  const mine = request.requestedBy.id === me;
  const error = approve.error ?? reject.error ?? cancel.error;
  const busy = approve.isPending || reject.isPending || cancel.isPending;
  // What the viewer's capabilities allow (the server refuses the same).
  const canDecide = useCan(CAN_APPROVE);
  const canWithdraw = useCan(CAN_WRITE);

  return (
    <li
      className="space-y-2 border-b border-line px-4 py-3 last:border-b-0"
      aria-label={`Change request ${request.id}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-fg">{describeChange(request)}</span>
        <span className={`s-${request.status}`}>{request.status}</span>
        <span className="text-dim">
          by {request.requestedBy.name ?? request.requestedBy.id} · base v{request.baseVersion}
        </span>
        <Stamps
          createdAt={request.createdAt ?? request.requestedAt}
          updatedAt={request.updatedAt}
        />
        {mine && <Badge>yours</Badge>}
      </div>
      {request.note && <p className="text-xs text-fg-2">“{request.note}”</p>}
      {request.reviewedBy && (
        <p className="text-[11px] text-dim">
          reviewed by {request.reviewedBy.name ?? request.reviewedBy.id}
          {request.reviewNote ? `: “${request.reviewNote}”` : ''}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-[11px] text-dim">Proposed value</summary>
        <pre className="mono mt-1 max-h-64 overflow-auto text-[10px] text-fg-2">
          {JSON.stringify(request.change.value, null, 2)}
        </pre>
      </details>
      {request.status === 'pending' && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`Review note for ${request.id}`}
            placeholder="Note (optional)"
            className="w-64"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {mine ? (
            <>
              <span className="text-[11px] text-dim">
                Someone else has to approve your request.
              </span>
              <Button
                variant="danger"
                disabled={busy || !canWithdraw}
                onClick={() => cancel.mutate()}
              >
                Withdraw
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={busy || !canDecide}
                onClick={() => approve.mutate()}
              >
                Approve and apply
              </Button>
              <Button
                variant="danger"
                disabled={busy || !canDecide}
                onClick={() => reject.mutate()}
              >
                Reject
              </Button>
            </>
          )}
        </div>
      )}
      {error && <ErrorBox error={error} />}
    </li>
  );
}

type Status = 'pending' | 'all';

/**
 * Two-person approvals. The console hides "Approve" on your own requests, but that is a courtesy:
 * the server refuses a requester approving their own change whatever the UI shows.
 */
export function Approvals() {
  const { environment, meta } = useEnv();
  // `?status=all` in the hash; pending (the default) leaves the URL.
  const [status, setStatus] = useQueryState(
    'status',
    parseAsStringLiteral(['pending', 'all'] as const)
      .withDefault('pending')
      .withOptions({ history: 'push' }),
  );
  const query = useQuery({
    queryKey: ['change-requests', environment, status],
    queryFn: () => api.changeRequests(environment, status),
  });
  const requests = query.data?.data ?? [];
  const me = query.data?.actor.id ?? meta?.actor.id ?? '';
  return (
    <Panel
      title="Change requests"
      subtitle={
        query.data?.requiresApproval
          ? `Changes to ${environment} need a second person.`
          : `${environment} applies changes directly; requests only exist where approvals are on.`
      }
      actions={
        <Segmented
          aria-label="Request status"
          value={status}
          onChange={(value: Status) => void setStatus(value)}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'all', label: 'All' },
          ]}
        />
      }
    >
      <QueryState
        query={query}
        empty={requests.length === 0}
        emptyMessage={
          status === 'pending' ? 'Nothing waiting for approval.' : 'No change requests.'
        }
      >
        <ul>
          {requests.map((request) => (
            <RequestRow key={request.id} request={request} me={me} />
          ))}
        </ul>
      </QueryState>
    </Panel>
  );
}
