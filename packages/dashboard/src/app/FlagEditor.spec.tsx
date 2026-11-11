import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlagDetail } from '../client/flags-client';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { FlagEditor } from './FlagEditor';
import { META, renderScreen } from './render.test-helper';

const originalFetch = globalThis.fetch;

function detail(overrides: Partial<FlagDetail> = {}): FlagDetail {
  const definition = {
    variants: { on: true, off: false },
    enabled: true,
    offVariant: 'off',
    fallthrough: { variant: 'off' },
  };
  return {
    environment: 'staging',
    version: '3',
    key: 'new_player',
    declaration: { type: 'boolean', default: false, owner: 'video', apps: ['shop'] },
    stored: definition,
    definition,
    serving: { kind: 'fixed', variant: 'off' },
    audit: [
      {
        id: 'a1',
        environment: 'staging',
        entity: 'flag',
        key: 'new_player',
        action: 'create',
        before: null,
        after: definition,
        actor: { id: 'bob' },
        version: '3',
        at: '2026-11-10T09:00:00.000Z',
      },
    ],
    schedules: [],
    pendingRequests: [],
    requiresApproval: false,
    segments: ['staff'],
    layers: [],
    flags: {},
    ...overrides,
  };
}

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

describe('the flag editor', () => {
  it('validates the draft live and blocks saving an invalid one', async () => {
    stubFetch((_method, url, body) => {
      if (url.includes('/preview')) {
        const change = (body as { change: { value: { offVariant: string } } }).change;
        return change.value.offVariant === 'off'
          ? { valid: true, issues: [], serving: { kind: 'fixed', variant: 'on' } }
          : {
              valid: false,
              issues: [{ path: 'flags.new_player.offVariant', message: 'unknown variant "x"' }],
            };
      }
      return detail();
    });
    renderScreen(<FlagEditor flagKey="new_player" onClose={() => {}} />, {
      environment: 'staging',
      meta: META,
    });
    expect(await screen.findByText(/Valid\./, {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.getByText('declared in', { exact: false })).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
  });

  it('saves the whole cleaned definition with a note, in the current environment', async () => {
    const { calls } = stubFetch((method, url) => {
      if (url.includes('/preview')) return { valid: true, issues: [], serving: null };
      if (method === 'PUT') return { status: 'applied', version: '4' };
      return detail();
    });
    renderScreen(<FlagEditor flagKey="new_player" onClose={() => {}} />, {
      environment: 'staging',
      meta: META,
    });
    const mode = await screen.findByRole('combobox', { name: 'Fallthrough variant' });
    fireEvent.change(mode, { target: { value: 'on' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Change note' }), {
      target: { value: 'launch' },
    });
    await screen.findByText(/Valid\./, {}, { timeout: 2000 });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: '/f/api/flags/new_player',
      body: {
        environment: 'staging',
        note: 'launch',
        definition: {
          variants: { on: true, off: false },
          enabled: true,
          offVariant: 'off',
          fallthrough: { variant: 'on' },
        },
      },
    });
    expect(await screen.findByText('Applied (version 4).')).toBeTruthy();
  });

  it('shows the issues the server would refuse', async () => {
    stubFetch((_method, url) =>
      url.includes('/preview')
        ? {
            valid: false,
            issues: [
              {
                path: 'flags.new_player.rules[0].conditions[0].values',
                message: 'operator "in" needs at least one value',
              },
            ],
          }
        : detail(),
    );
    renderScreen(<FlagEditor flagKey="new_player" onClose={() => {}} />, { meta: META });
    expect(await screen.findByText(/needs at least one value/, {}, { timeout: 2000 })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('says "Request change" where approvals are on', async () => {
    stubFetch((_method, url) =>
      url.includes('/preview') ? { valid: true, issues: [] } : detail({ requiresApproval: true }),
    );
    renderScreen(<FlagEditor flagKey="new_player" onClose={() => {}} />, { meta: META });
    expect(await screen.findByRole('button', { name: 'Request change' })).toBeTruthy();
    expect(screen.getByText(/needs a second person/)).toBeTruthy();
  });

  it('evaluates a context against the draft', async () => {
    const { calls } = stubFetch((_method, url) => {
      if (url.includes('/preview')) return { valid: true, issues: [] };
      if (url.includes('/evaluate')) {
        return {
          environment: 'production',
          result: {
            flagKey: 'new_player',
            value: true,
            variant: 'on',
            reason: 'TARGETING_MATCH',
            flagMetadata: { ruleId: 'staff' },
          },
        };
      }
      return detail();
    });
    renderScreen(<FlagEditor flagKey="new_player" onClose={() => {}} />, { meta: META });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Targeting key' }), {
      target: { value: 'u1' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Attributes' }), {
      target: { value: '{"plan":"pro"}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Evaluate' }));
    expect((await screen.findByTestId('evaluated-value')).textContent).toBe('true');
    expect(screen.getByText('TARGETING_MATCH')).toBeTruthy();
    expect(calls.find((c) => c.url.includes('/evaluate'))?.body).toMatchObject({
      flag: 'new_player',
      context: { plan: 'pro', targetingKey: 'u1' },
      definition: { offVariant: 'off' },
    });
  });
});
