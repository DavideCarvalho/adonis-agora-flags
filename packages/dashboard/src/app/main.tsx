import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

/**
 * Refetch every 15s: a ruleset changes when someone edits it, not second to second, and the ops
 * numbers are the only thing that moves on its own. The flag editor opts out — refetching under a
 * person typing would only fight them.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 15_000, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
