import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import StockPage from './StockPage';

const mocks = vi.hoisted(() => ({
  listParts: vi.fn(),
  listStock: vi.fn(),
  listMovements: vi.fn(),
  adjustStock: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listParts: (...args: unknown[]) => mocks.listParts(...args),
    listStock: (...args: unknown[]) => mocks.listStock(...args),
    listMovements: (...args: unknown[]) => mocks.listMovements(...args),
    adjustStock: (...args: unknown[]) => mocks.adjustStock(...args),
    newIdempotencyKey: () => 'test-key-1',
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@example.test', name: null },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1', 'b2'],
      role: 'manager',
      permissions: ['inventory:read'],
      branches: [
        { id: 'b1', name: 'Main' },
        { id: 'b2', name: 'North' },
      ],
    },
  ],
  tenantContext: {
    userId: 'u1',
    tenantId: 't1',
    branchIds: ['b1', 'b2'],
    role: 'manager',
    permissions: ['inventory:read'],
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
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

describe('StockPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.listParts.mockReset();
    mocks.listStock.mockReset();
    mocks.listMovements.mockReset();
    mocks.adjustStock.mockReset();
    mockAuth.tenantContext.permissions = ['inventory:read'];
    mockAuth.tenantContext.role = 'manager';
    mocks.listParts.mockResolvedValue({
      items: [
        { id: 'p1', sku: 'SCR-001', name: 'Screen', createdAt: '2026-11-24T00:00:00.000Z' },
        { id: 'p2', sku: 'BAT-9', name: 'Battery', createdAt: '2026-11-24T00:00:00.000Z' },
      ],
      nextCursor: null,
    });
    mocks.listStock.mockResolvedValue({
      items: [
        {
          partId: 'p1',
          partSku: 'SCR-001',
          partName: 'Screen',
          branchId: 'b1',
          branchName: 'Main',
          qtyOnHand: 10,
          reservedQty: 3,
          available: 7,
        },
      ],
      nextCursor: null,
    });
    mocks.listMovements.mockResolvedValue({
      items: [
        {
          id: 'm1',
          partId: 'p1',
          partSku: 'SCR-001',
          partName: 'Screen',
          branchId: 'b1',
          branchName: 'Main',
          qty: -2,
          reason: 'consume',
          createdAt: '2026-11-24T10:00:00.000Z',
        },
        {
          id: 'm2',
          partId: 'p1',
          partSku: 'SCR-001',
          partName: 'Screen',
          branchId: 'b1',
          branchName: 'Main',
          qty: 5,
          reason: 'adjust',
          createdAt: '2026-11-24T09:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    mocks.adjustStock.mockResolvedValue({
      partId: 'p1',
      partSku: 'SCR-001',
      partName: 'Screen',
      branchId: 'b1',
      branchName: 'Main',
      qtyOnHand: 15,
      reservedQty: 3,
      available: 12,
    });
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <StockPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders stock rows with the branch filter', async () => {
    renderPage();
    // SCR-001 appears in the stock table and in both movement lines.
    expect((await screen.findAllByText('SCR-001')).length).toBe(3);
    expect(screen.getByText('Main')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByLabelText('الفرع')).toBeInTheDocument();
    expect(mocks.listStock).toHaveBeenCalledWith({
      branchId: undefined,
      partId: undefined,
      limit: 50,
    });
  });

  it('renders the movement ledger with signed quantities and localized reasons', async () => {
    renderPage();
    expect(await screen.findByText('-2')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText(/استهلاك/)).toBeInTheDocument();
    expect(screen.getByText(/تعديل/)).toBeInTheDocument();
  });

  it('hides the adjust form without inventory:write', async () => {
    renderPage();
    expect((await screen.findAllByText('SCR-001')).length).toBe(3);
    expect(screen.queryByText('تعديل المخزون')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/التغيير/)).not.toBeInTheDocument();
  });

  it('shows the adjust form with inventory:write and submits a signed delta', async () => {
    mockAuth.tenantContext.permissions = ['inventory:read', 'inventory:write'];
    renderPage();
    expect(await screen.findByText('تعديل المخزون')).toBeInTheDocument();

    // Two "الفرع" selects exist: the list filter and the adjust form.
    const branchSelects = screen.getAllByRole('combobox', { name: 'الفرع' });
    fireEvent.mouseDown(branchSelects[1]);
    fireEvent.click(await screen.findByRole('option', { name: 'Main' }));

    // The part field is a server-search picker: type, wait for the
    // debounced search, then pick the option.
    fireEvent.change(screen.getByRole('combobox', { name: 'اختر القطعة' }), {
      target: { value: 'SCR' },
    });
    fireEvent.click(await screen.findByRole('option', { name: /SCR-001/ }));

    fireEvent.change(screen.getByLabelText(/التغيير/), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'تعديل' }));
    await waitFor(() =>
      expect(mocks.adjustStock).toHaveBeenCalledWith({
        branchId: 'b1',
        partId: 'p1',
        delta: 5,
        reason: undefined,
        idempotencyKey: 'test-key-1',
      }),
    );
  });
});
