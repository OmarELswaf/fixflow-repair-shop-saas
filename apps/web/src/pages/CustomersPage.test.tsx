import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CustomersPage from './CustomersPage';

const mocks = vi.hoisted(() => ({
  listCustomers: vi.fn(),
  createCustomer: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listCustomers: (...args: unknown[]) => mocks.listCustomers(...args),
    createCustomer: (...args: unknown[]) => mocks.createCustomer(...args),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@example.test', name: null },
    memberships: [{ tenantId: 't1', branchIds: ['b1'], role: 'manager', permissions: [] }],
    tenantContext: {
      userId: 'u1',
      tenantId: 't1',
      branchIds: ['b1'],
      role: 'manager',
      permissions: [],
      entitlements: [],
    },
    tenantChoices: [],
    needsTenantSelection: false,
    isAuthenticated: true,
    loading: false,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    selectTenant: vi.fn(),
    refreshMe: vi.fn(),
  }),
}));

const PAGE_1 = {
  items: [{ id: 'c1', name: 'Ahmed', phone: '0100', createdAt: '2026-11-24T00:00:00.000Z' }],
  nextCursor: 'c1',
};
const PAGE_2 = {
  items: [{ id: 'c2', name: 'Sara', phone: '0200', createdAt: '2026-11-24T00:00:00.000Z' }],
  nextCursor: null,
};

describe('CustomersPage — pagination', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.listCustomers.mockReset();
    mocks.createCustomer.mockReset();
    mocks.listCustomers.mockImplementation(async (params: { cursor?: string | null }) =>
      params.cursor ? PAGE_2 : PAGE_1,
    );
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <CustomersPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('loads the first page, then loads more with the cursor', async () => {
    renderPage();
    expect(await screen.findByText('Ahmed')).toBeInTheDocument();
    expect(screen.queryByText('Sara')).not.toBeInTheDocument();
    expect(mocks.listCustomers).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'عرض المزيد' }));
    expect(await screen.findByText('Sara')).toBeInTheDocument();
    // Both pages stay visible; the second call carries the cursor.
    expect(screen.getByText('Ahmed')).toBeInTheDocument();
    expect(mocks.listCustomers).toHaveBeenCalledTimes(2);
    expect(mocks.listCustomers).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c1' }));
    // No further pages: the button disappears.
    expect(screen.queryByRole('button', { name: 'عرض المزيد' })).not.toBeInTheDocument();
  });
});
