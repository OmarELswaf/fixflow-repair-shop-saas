import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiError } from '../api/client';
import { LanguageContext } from '../i18n';
import ApprovePage from './ApprovePage';

const fetchMock = vi.fn();
const decideMock = vi.fn();
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchEstimate: (...a: unknown[]) => fetchMock(...a),
    decideEstimate: (...a: unknown[]) => decideMock(...a),
  };
});

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LanguageContext.Provider value="ar">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/a/abc']}>
          <Routes>
            <Route path="/a/:token" element={<ApprovePage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </LanguageContext.Provider>,
  );
}

const estimate = {
  shop: { name: 'ورشة النور' },
  device: { brand: 'Samsung', model: 'A54' },
  description: 'تغيير شاشة',
  amount: '450.5',
  status: 'pending',
  decidedAt: null,
};

describe('ApprovePage', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    fetchMock.mockReset();
    decideMock.mockReset();
  });

  it('shows amount and records an approval', async () => {
    fetchMock.mockResolvedValue(estimate);
    decideMock.mockResolvedValue({ status: 'approved' });
    renderPage();
    expect(await screen.findByTestId('approve-amount')).toHaveTextContent('450.5');
    fireEvent.click(screen.getByRole('button', { name: 'أوافق' }));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith('abc', 'approve'));
    expect(await screen.findByText('تم تسجيل ردك. شكرًا لك.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'أوافق' })).toBeNull();
  });

  it('shows the already-answered message on 409', async () => {
    fetchMock.mockResolvedValue(estimate);
    decideMock.mockRejectedValue(new ApiError(409, 'x'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'أرفض' }));
    expect(await screen.findByText('تم الرد على هذا العرض من قبل.')).toBeInTheDocument();
  });

  it('shows one generic message for an unknown link', async () => {
    fetchMock.mockRejectedValue(new ApiError(404, 'x'));
    renderPage();
    expect(
      await screen.findByText('الرابط غير صالح أو انتهت صلاحيته. اتصل بالمحل.'),
    ).toBeInTheDocument();
  });
});
