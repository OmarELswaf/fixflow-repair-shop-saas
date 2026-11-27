import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import RepairsPage from './RepairsPage';

const listRepairsMock = vi.fn();

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listRepairs: (...args: unknown[]) => listRepairsMock(...args),
    listCustomers: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getCustomer: vi.fn(),
    createRepair: vi.fn(),
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', email: 'a@example.test', name: null },
    memberships: [{ tenantId: 't1', branchIds: ['b1', 'b2'], role: 'manager', permissions: [] }],
    tenantContext: {
      userId: 'u1',
      tenantId: 't1',
      branchIds: ['b1', 'b2'],
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

describe('RepairsPage', () => {
  // Vitest here runs without globals, so Testing Library does not
  // auto-cleanup between tests; unmount explicitly.
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    listRepairsMock.mockReset();
    listRepairsMock.mockResolvedValue({
      items: [
        {
          id: 'r1',
          tenantId: 't1',
          branchId: 'b1',
          customerId: 'c1',
          deviceId: 'd1',
          status: 'received',
          problemDescription: 'الشاشة لا تعمل',
          version: 0,
          createdAt: '2026-11-24T00:00:00.000Z',
          updatedAt: '2026-11-24T00:00:00.000Z',
        },
        {
          id: 'r2',
          tenantId: 't1',
          branchId: 'b2',
          customerId: 'c2',
          deviceId: 'd2',
          customer: { name: 'سارة', phone: '+201000000001' },
          device: { brand: 'Samsung', model: 'A54' },
          status: 'in_repair',
          version: 2,
          createdAt: '2026-11-24T00:00:00.000Z',
          updatedAt: '2026-11-24T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <RepairsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders repairs from the API with status filter and branch filter present', async () => {
    renderPage();
    expect(await screen.findByText('#R1')).toBeInTheDocument();
    expect(screen.getByText('#R2')).toBeInTheDocument();
    // Title is the short repair number plus customer name; the second line is device and problem.
    expect(screen.getByText('الشاشة لا تعمل')).toBeInTheDocument();
    expect(screen.getByText(/سارة/)).toBeInTheDocument();
    expect(screen.getByText('Samsung A54')).toBeInTheDocument();
    expect(screen.queryByText('c1')).not.toBeInTheDocument();
    expect(screen.getByLabelText('الحالة')).toBeInTheDocument();
    // Two branch selects exist: the list filter and the new-repair form.
    expect(screen.getAllByLabelText('الفرع')).toHaveLength(2);
    expect(listRepairsMock).toHaveBeenCalledWith({
      status: undefined,
      branchId: undefined,
      limit: 50,
    });
  });

  it('syncs the status filter with the URL without remounting', async () => {
    // Regression: the filter used to be read from the URL once on
    // mount, so a dashboard chip (/repairs?status=X) or the bottom
    // navigation (/repairs) while already on /repairs left the list
    // showing the old filter. The filter is now derived from the URL.
    function NavButtons() {
      const navigate = useNavigate();
      return (
        <>
          <button onClick={() => navigate('/repairs?status=in_repair')}>go filtered</button>
          <button onClick={() => navigate('/repairs')}>go unfiltered</button>
        </>
      );
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <MemoryRouter initialEntries={['/repairs']}>
        <QueryClientProvider client={queryClient}>
          <NavButtons />
          <Routes>
            <Route path="/repairs" element={<RepairsPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('#R1')).toBeInTheDocument();
    const filterGroup = screen.getByRole('group', { name: 'الحالة' });
    expect(filterGroup.querySelector('[aria-pressed="true"]')).toHaveTextContent('كل الحالات');

    fireEvent.click(screen.getByRole('button', { name: 'go filtered' }));
    await screen.findByText('#R1');
    expect(listRepairsMock).toHaveBeenCalledWith({
      status: 'in_repair',
      branchId: undefined,
      limit: 50,
    });
    expect(filterGroup.querySelector('[aria-pressed="true"]')).toHaveTextContent('قيد الإصلاح');

    // Same-route navigation back to /repairs (as the bottom nav does)
    // clears the filter instead of leaving the old one applied.
    fireEvent.click(screen.getByRole('button', { name: 'go unfiltered' }));
    await screen.findByText('#R1');
    expect(listRepairsMock).toHaveBeenCalledWith({
      status: undefined,
      branchId: undefined,
      limit: 50,
    });
    expect(filterGroup.querySelector('[aria-pressed="true"]')).toHaveTextContent('كل الحالات');
  });

  it('renders the new-repair form', async () => {
    renderPage();
    expect(await screen.findByText('إصلاح جديد')).toBeInTheDocument();
    // The description field is required, so MUI appends an asterisk to its label.
    expect(screen.getByLabelText(/وصف المشكلة/)).toBeInTheDocument();
  });
});
