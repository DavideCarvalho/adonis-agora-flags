import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChangeRequest } from '../client/flags-client';
import { clearConfig, injectConfig, status, stubFetch } from '../client/test-config.test-helper';
import { Approvals } from './Approvals';
import { META, renderScreen } from './render.test-helper';

const originalFetch = globalThis.fetch;

function request(id: string, by: string): ChangeRequest {
  return {
    id,
    environment: 'production',
    change: { entity: 'flag', key: 'new_player', value: { enabled: false } },
    note: 'kill it',
    requestedBy: { id: by },
    requestedAt: '2026-11-11T10:00:00.000Z',
    status: 'pending',
    baseVersion: '3',
  };
}

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

describe('approvals', () => {
  it('offers approve/reject on someone else’s request and only withdraw on your own', async () => {
    stubFetch(() => ({
      requiresApproval: true,
      actor: { id: 'alice' },
      data: [request('mine', 'alice'), request('theirs', 'bob')],
      meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
    }));
    renderScreen(<Approvals />, { meta: META });
    const mine = await screen.findByRole('listitem', { name: 'Change request mine' });
    const theirs = screen.getByRole('listitem', { name: 'Change request theirs' });
    expect(mine.textContent).toContain('Withdraw');
    expect(mine.textContent).not.toContain('Approve and apply');
    expect(theirs.textContent).toContain('Approve and apply');
    expect(theirs.textContent).toContain('Reject');
  });

  it('approves with a note', async () => {
    const { calls } = stubFetch((method) =>
      method === 'POST'
        ? { version: '4', request: { ...request('theirs', 'bob'), status: 'applied' } }
        : {
            requiresApproval: true,
            actor: { id: 'alice' },
            data: [request('theirs', 'bob')],
            meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
          },
    );
    renderScreen(<Approvals />, { meta: META });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Review note for theirs' }), {
      target: { value: 'lgtm' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and apply' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/f/api/change-requests/theirs/approve',
      body: { note: 'lgtm' },
    });
  });

  it('shows the server’s refusal — the two-person rule is enforced there, not here', async () => {
    stubFetch((method) =>
      method === 'POST'
        ? status(403, { error: 'a change cannot be approved by the person who requested it' })
        : {
            requiresApproval: true,
            actor: { id: 'alice' },
            data: [request('theirs', 'bob')],
            meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
          },
    );
    renderScreen(<Approvals />, { meta: META });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and apply' }));
    expect(await screen.findByText(/person who requested it/)).toBeTruthy();
  });
});
