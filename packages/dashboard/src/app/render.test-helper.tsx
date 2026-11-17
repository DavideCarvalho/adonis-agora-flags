import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
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
