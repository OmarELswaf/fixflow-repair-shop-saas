import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import App from './App';
import theme from './theme';

describe('App', () => {
  beforeEach(() => {
    // Unauthenticated: the refresh cookie yields no session.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ statusCode: 401, message: 'Unauthorized' }), {
            status: 401,
          }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('redirects unauthenticated users to login and the language toggle changes dir', async () => {
    render(<App theme={theme} />);
    expect(await screen.findByText('تسجيل الدخول إلى FixFlow')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    fireEvent.click(screen.getByLabelText('language-toggle'));
    expect(document.documentElement.dir).toBe('ltr');
    expect(document.documentElement.lang).toBe('en');
  });
});
