import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { App, FLAGS_ACCENT } from './App';
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
    <ThemeProvider storageKey="agora-flags-theme" accent={FLAGS_ACCENT}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
