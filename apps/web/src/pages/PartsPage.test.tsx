import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import PartsPage from './PartsPage';

const mocks = vi.hoisted(() => ({
  listParts: vi.fn(),
  createPart: vi.fn(),
  getPart: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    listParts: (...args: unknown[]) => mocks.listParts(...args),
    createPart: (...args: unknown[]) => mocks.createPart(...args),
    getPart: (...args: unknown[]) => mocks.getPart(...args),
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@example.test', name: null },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1'],
      role: 'manager',
      permissions: ['inventory:read', 'inventory:write'],
      branches: [{ id: 'b1', name: 'Main' }],
    },
  ],
  tenantContext: {
    userId: 'u1',
    tenantId: 't1',
    branchIds: ['b1'],
    role: 'manager',
    permissions: ['inventory:read', 'inventory:write'],
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

describe('PartsPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.listParts.mockReset();
    mocks.createPart.mockReset();
    mocks.getPart.mockReset();
    mockAuth.tenantContext.permissions = ['inventory:read', 'inventory:write'];
    mocks.listParts.mockResolvedValue({
      items: [
        {
          id: 'p1',
          sku: 'SCR-001',
          name: 'Screen',
          createdAt: '2026-11-24T00:00:00.000Z',
        },
        {
          id: 'p2',
          sku: 'BAT-9',
          name: 'Battery',
          createdAt: '2026-11-24T00:00:00.000Z',
        },
      ],
      nextCursor: null,
    });
    mocks.getPart.mockResolvedValue({
      id: 'p1',
      sku: 'SCR-001',
      name: 'Screen',
      createdAt: '2026-11-24T00:00:00.000Z',
      stock: [
        { branchId: 'b1', branchName: 'Main', qtyOnHand: 10, reservedQty: 3, available: 7 },
        { branchId: 'b2', branchName: 'North', qtyOnHand: 4, reservedQty: 0, available: 4 },
      ],
    });
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <PartsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders parts from the API search', async () => {
    renderPage();
    expect(await screen.findByText(/Screen/)).toBeInTheDocument();
    expect(screen.getByText('SCR-001')).toBeInTheDocument();
    expect(screen.getByText(/Battery/)).toBeInTheDocument();
    expect(mocks.listParts).toHaveBeenCalledWith({ search: undefined, limit: 50 });
  });

  it('searches by the debounced term', async () => {
    renderPage();
    await screen.findByText(/Screen/);
    fireEvent.change(screen.getByLabelText(/بحث بالرمز أو الاسم/), {
      target: { value: 'BAT' },
    });
    await waitFor(() => expect(mocks.listParts).toHaveBeenCalledWith({ search: 'BAT', limit: 50 }));
  });

  it('shows the create form with inventory:write and submits it', async () => {
    renderPage();
    await screen.findByText(/Screen/);
    expect(screen.getByText('قطعة جديدة')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/رمز القطعة/), { target: { value: 'CHG-2' } });
    fireEvent.change(screen.getByLabelText(/اسم القطعة/), { target: { value: 'Charger' } });
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء القطعة' }));
    await waitFor(() =>
      expect(mocks.createPart).toHaveBeenCalledWith({ sku: 'CHG-2', name: 'Charger' }),
    );
  });

  it('hides the create form without inventory:write', async () => {
    mockAuth.tenantContext.permissions = ['inventory:read'];
    renderPage();
    expect(await screen.findByText(/Screen/)).toBeInTheDocument();
    expect(screen.queryByText('قطعة جديدة')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/رمز القطعة/)).not.toBeInTheDocument();
  });

  it('shows per-branch stock for the selected part', async () => {
    renderPage();
    await screen.findByText(/Screen/);
    fireEvent.click(screen.getAllByRole('button', { name: 'تفاصيل القطعة' })[0]);
    expect(await screen.findByText('Main')).toBeInTheDocument();
    expect(screen.getByText('North')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(mocks.getPart).toHaveBeenCalledWith('p1');
  });
});
