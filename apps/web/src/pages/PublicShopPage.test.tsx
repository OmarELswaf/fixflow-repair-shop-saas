import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../api/client';
import { LanguageContext } from '../i18n';
import PublicShopPage from './PublicShopPage';

const fetchPublicShopMock = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchPublicShop: (...args: unknown[]) => fetchPublicShopMock(...args),
  };
});

const profile = {
  slug: 'my-shop',
  displayName: 'ورشتي',
  description: 'إصلاح الهواتف.',
  logoUrl: null,
  theme: 'green',
  services: [],
  contact: null,
  hours: null,
};

describe('PublicShopPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    fetchPublicShopMock.mockReset();
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <LanguageContext.Provider value="ar">
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/s/my-shop']}>
            <Routes>
              <Route path="/s/:slug" element={<PublicShopPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </LanguageContext.Provider>,
    );
  }

  it('shows a loading state while the page loads', () => {
    fetchPublicShopMock.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByLabelText('loading')).toBeInTheDocument();
  });

  it('shows the not-found message for an unpublished or unknown slug', async () => {
    fetchPublicShopMock.mockRejectedValue(new ApiError(404, 'Not found'));
    renderPage();
    expect(await screen.findByText('هذه الصفحة غير موجودة أو غير منشورة.')).toBeInTheDocument();
    expect(fetchPublicShopMock).toHaveBeenCalledWith('my-shop');
  });

  it('shows the server message for a non-404 error', async () => {
    fetchPublicShopMock.mockRejectedValue(new ApiError(500, 'Server exploded.'));
    renderPage();
    expect(await screen.findByText('Server exploded.')).toBeInTheDocument();
  });

  it('renders the published profile', async () => {
    fetchPublicShopMock.mockResolvedValue(profile);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'ورشتي' })).toBeInTheDocument();
    expect(screen.getByText('إصلاح الهواتف.')).toBeInTheDocument();
  });
});
