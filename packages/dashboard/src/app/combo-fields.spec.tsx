import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FlagDefinition, FlagRow } from '../client/flags-client';
import { clearConfig, injectConfig, stubFetch } from '../client/test-config.test-helper';
import { Activity } from './Activity';
import { DeclarationDetails } from './DeclarationDetails';
import { ExperimentEditor, PrerequisitesEditor, RulesEditor } from './editor-parts';
import { FlagsList } from './FlagsList';
import { Layers } from './Layers';
import { NewFlag } from './NewFlag';
import { pickCombo, renderScreen } from './render.test-helper';

/**
 * The fields that pick from a known list (tags, owners, keys, segments, layers, flags) are kit
 * comboboxes: they suggest what is in use and, where the list can be incomplete, take typed text.
 */

const originalFetch = globalThis.fetch;

function row(key: string, owner: string | null, tags: string[]): FlagRow {
  return {
    key,
    declaration: null,
    inRuleset: true,
    enabled: true,
    serving: { kind: 'fixed', variant: 'on' },
    tags,
    owner,
    expiresAt: null,
    experiment: false,
    rules: 0,
    overrides: 0,
    stale: [],
  };
}

const FLAGS = [
  row('checkout', 'payments', ['billing', 'web']),
  row('new_player', 'video', ['web']),
];
const flagList = { environment: 'production', version: '1', data: FLAGS };

beforeEach(() => injectConfig({ api: '/f/api' }));
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearConfig();
});

describe('tags and owners suggest what is in use', () => {
  it('new flag: picks an owner in use and adds a new tag next to a known one', async () => {
    const { calls } = stubFetch((method, url) =>
      method === 'POST' ? { status: 'applied', version: '2' } : url.includes('/flags') && flagList,
    );
    renderScreen(<NewFlag onCreated={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('promo_banner'), {
      target: { value: 'promo' },
    });
    await pickCombo('Owner', 'pay', 'payments');
    await pickCombo('Tags', 'bil', 'billing');
    await pickCombo('Tags', 'launch');
    fireEvent.click(screen.getByRole('button', { name: 'Create flag' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      key: 'promo',
      declaration: { owner: 'payments', tags: ['billing', 'launch'] },
    });
  });

  it('console declaration details: saves the picked owner and tags as a list', async () => {
    const { calls } = stubFetch((method) =>
      method === 'PUT' ? { status: 'applied', version: '2' } : flagList,
    );
    renderScreen(
      <DeclarationDetails
        flagKey="promo"
        declaration={{ type: 'boolean', default: false, apps: [], source: 'console', tags: ['x'] }}
      />,
    );
    await pickCombo('Owner', 'vid', 'video');
    await pickCombo('Tags', 'web');
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      declaration: { owner: 'video', tags: ['x', 'web'] },
    });
  });

  it('flag list: the tag filter suggests the tags in use and goes into the URL', async () => {
    window.history.replaceState(null, '', '/flags#/flags');
    stubFetch(() => flagList);
    renderScreen(<FlagsList onOpen={() => {}} />);
    await screen.findByText('checkout');
    await pickCombo('Tag', 'bill', 'billing');
    await waitFor(() => expect(window.location.hash).toBe('#/flags?tag=billing'));
    expect(screen.queryByText('new_player')).toBeNull();
  });
});

describe('audit log key', () => {
  it('suggests the keys of the entity picked', async () => {
    window.history.replaceState(null, '', '/#/activity?entity=segment');
    stubFetch((_method, url) =>
      url.includes('/segments')
        ? {
            environment: 'production',
            data: [{ key: 'staff', segment: {}, usedBy: [] }],
          }
        : { data: [], meta: { nextCursor: null, prevCursor: null } },
    );
    renderScreen(<Activity />);
    await pickCombo('Filter by key', 'sta', 'staff');
    await waitFor(() => expect(window.location.hash).toBe('#/activity?entity=segment&key=staff'));
  });
});

describe('editor pickers', () => {
  const base: FlagDefinition = {
    variants: { on: true, off: false },
    enabled: true,
    offVariant: 'off',
    fallthrough: { variant: 'off' },
  };

  it('segment condition: picks a segment by typing', async () => {
    let latest: unknown = null;
    renderScreen(
      <RulesEditor
        rules={[{ id: 'r1', conditions: [{ segment: '' }], serve: { variant: 'on' } }]}
        variants={['on', 'off']}
        operators={['in']}
        segments={['beta_testers', 'staff']}
        onChange={(next) => {
          latest = next;
        }}
      />,
    );
    await pickCombo('Rule 1 condition 1 segment', 'sta', 'staff');
    expect(latest).toEqual([
      { id: 'r1', conditions: [{ segment: 'staff' }], serve: { variant: 'on' } },
    ]);
  });

  it('prerequisite: picks a flag and resets the variant to its first one', async () => {
    let latest: unknown = null;
    renderScreen(
      <PrerequisitesEditor
        prerequisites={[{ flag: 'checkout', variant: 'on' }]}
        flags={{ checkout: ['on', 'off'], new_player: ['control', 'one_page'] }}
        onChange={(next) => {
          latest = next;
        }}
      />,
    );
    await pickCombo('Prerequisite 1 flag', 'new', 'new_player');
    expect(latest).toEqual([{ flag: 'new_player', variant: 'control' }]);
  });

  it('experiment layer: picks a layer by typing', async () => {
    let latest: FlagDefinition | null = null;
    renderScreen(
      <ExperimentEditor
        definition={{ ...base, experiment: {} }}
        layers={['checkout_layer', 'onboarding']}
        onChange={(next) => {
          latest = next;
        }}
      />,
    );
    await pickCombo('Layer', 'onb', 'onboarding');
    expect((latest as FlagDefinition | null)?.experiment).toEqual({ layer: 'onboarding' });
  });

  it('layers: adds an experiment of the layer from the picker', async () => {
    stubFetch(() => ({
      environment: 'production',
      data: [{ key: 'checkout_layer', layer: { allocations: {} }, allocatedPercent: 0 }],
      holdout: null,
      experiments: [
        { flag: 'checkout', experiment: 'checkout', layer: 'checkout_layer', holdout: true },
        { flag: 'new_player', experiment: 'new_player', layer: 'checkout_layer', holdout: true },
      ],
    }));
    renderScreen(<Layers />);
    await screen.findByText('checkout_layer');
    await pickCombo('Add an experiment to checkout_layer', 'player', 'new_player');
    expect(await screen.findByLabelText('new_player start')).toBeTruthy();
  });
});
