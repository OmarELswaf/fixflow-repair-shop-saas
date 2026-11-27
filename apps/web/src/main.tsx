import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { queryClient } from './api/client';
import theme from './theme';
import './fonts/fonts.css';

export const appQueryClient: QueryClient = queryClient;

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App theme={theme} />
    </QueryClientProvider>
  </React.StrictMode>,
);
