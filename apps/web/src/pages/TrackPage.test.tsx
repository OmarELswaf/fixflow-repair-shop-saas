import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../api/client';
import { LanguageContext } from '../i18n';
import TrackPage from './TrackPage';

const fetchTrackingMock = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, fetchTracking: (...a: unknown[]) => fetchTrackingMock(...a) };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LanguageContext.Provider value="ar">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/t/abc']}>
          <Routes>
            <Route path="/t/:token" element={<TrackPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </LanguageContext.Provider>,
  );
}

describe('TrackPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    fetchTrackingMock.mockReset();
  });

  it('shows the status and timeline without any customer data', async () => {
    fetchTrackingMock.mockResolvedValue({
      shop: { name: 'ورشة النور' },
      device: { brand: 'Samsung', model: 'A54' },
      status: 'in_repair',
      expectedReadyAt: null,
      updatedAt: '2026-11-26T01:00:00.000Z',
      timeline: [
        { status: 'received', at: '2026-11-25T10:00:00.000Z' },
        { status: 'in_repair', at: '2026-11-26T01:00:00.000Z' },
      ],
    });
    renderPage();
    expect(await screen.findByText('ورشة النور')).toBeInTheDocument();
    expect(screen.getByText('Samsung A54')).toBeInTheDocument();
    expect(screen.getByTestId('track-status')).toHaveTextContent('قيد الإصلاح');
    expect(fetchTrackingMock).toHaveBeenCalledWith('abc');
  });

  it('shows one not-found message for an invalid link', async () => {
    fetchTrackingMock.mockRejectedValue(new ApiError(404, 'Link not found.'));
    renderPage();
    expect(
      await screen.findByText('الرابط غير صالح أو انتهت صلاحيته. اتصل بالمحل.'),
    ).toBeInTheDocument();
  });
});
