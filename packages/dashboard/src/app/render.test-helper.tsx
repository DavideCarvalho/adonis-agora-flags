import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, type RenderResult, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { NuqsHashAdapter } from '../agora-kit/url-state/nuqs-hash-adapter';
import type { Meta } from '../client/flags-client';
import { EnvProvider } from './env';

/** Test helper: a screen inside a fresh query client, an environment and the URL-state adapter the
 *  App provides (screens keep their filters in the hash's query). Specs only. */
export function renderScreen(
  ui: ReactNode,
  options: { environment?: string; meta?: Meta } = {},
): RenderResult {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });
  return render(
    <NuqsHashAdapter>
      <QueryClientProvider client={client}>
        <EnvProvider
          value={{ environment: options.environment ?? 'production', meta: options.meta }}
        >
          {ui}
        </EnvProvider>
      </QueryClientProvider>
    </NuqsHashAdapter>,
  );
}

export const META: Meta = {
  app: 'shop',
  topology: 'standalone',
  environment: 'production',
  environments: ['production', 'staging'],
  approvals: { production: true, staging: false },
  actor: { id: 'alice' },
  operators: ['in', 'contains', 'gte', 'exists'],
  analytics: true,
  experiments: ['checkout'],
};

/**
 * Picks `option` in the kit combobox labelled `label`: opens it (Base UI opens on ArrowDown, not
 * on input), types `text` to filter, then clicks the matching option. With `creatable`, the typed
 * text itself is the option “Use “text””. Specs only.
 */
export async function pickCombo(
  label: string,
  text: string,
  option: string | RegExp = text,
): Promise<void> {
  const input = screen.getByRole('combobox', { name: label });
  await act(async () => {
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.change(input, { target: { value: text } });
    await new Promise((r) => setTimeout(r, 20));
  });
  const item = await screen.findByRole('option', {
    name: typeof option === 'string' ? new RegExp(`^(Use “)?${escapeRegExp(option)}”?$`) : option,
  });
  await act(async () => {
    fireEvent.click(item);
    await new Promise((r) => setTimeout(r, 20));
  });
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
