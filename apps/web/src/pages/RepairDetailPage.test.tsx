import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RepairDetailPage from './RepairDetailPage';

const mocks = vi.hoisted(() => ({
  getRepair: vi.fn(),
  getReceipt: vi.fn(),
  listTechnicians: vi.fn(),
  listRepairParts: vi.fn(),
  listStock: vi.fn(),
  reservePart: vi.fn(),
  releasePart: vi.fn(),
  consumePart: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getRepair: (...args: unknown[]) => mocks.getRepair(...args),
    getReceipt: (...args: unknown[]) => mocks.getReceipt(...args),
    listTechnicians: (...args: unknown[]) => mocks.listTechnicians(...args),
    listRepairParts: (...args: unknown[]) => mocks.listRepairParts(...args),
    listStock: (...args: unknown[]) => mocks.listStock(...args),
    reservePart: (...args: unknown[]) => mocks.reservePart(...args),
    releasePart: (...args: unknown[]) => mocks.releasePart(...args),
    consumePart: (...args: unknown[]) => mocks.consumePart(...args),
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@example.test', name: null },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1'],
      role: 'manager',
      permissions: ['inventory:read', 'stock:reserve', 'stock:release', 'stock:consume'],
      branches: [{ id: 'b1', name: 'Main' }],
    },
  ],
  tenantContext: {
    userId: 'u1',
    tenantId: 't1',
    branchIds: ['b1'],
    role: 'manager',
    permissions: ['inventory:read', 'stock:reserve', 'stock:release', 'stock:consume'],
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

function makeDetail(assignedTechnician: { id: string; name: string; email: string } | null) {
  const order = {
    id: 'r1',
    tenantId: 't1',
    branchId: 'b1',
    customerId: 'c1',
    deviceId: 'd1',
    status: 'in_repair',
    version: 1,
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
  return {
    order,
    customer: { id: 'c1', name: 'Ahmed', phone: null, createdAt: '2026-11-24T00:00:00.000Z' },
    device: {
      id: 'd1',
      brand: 'Samsung',
      model: 'A54',
      serial: null,
      createdAt: '2026-11-24T00:00:00.000Z',
    },
    branch: { id: 'b1', name: 'Main' },
    events: [],
    assignedTechnician,
  };
}

describe('RepairDetailPage — parts section', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.getRepair.mockReset();
    mocks.getReceipt.mockReset();
    mocks.listTechnicians.mockReset();
    mocks.listRepairParts.mockReset();
    mocks.listStock.mockReset();
    mocks.reservePart.mockReset();
    mocks.releasePart.mockReset();
    mocks.consumePart.mockReset();
    mockAuth.tenantContext.role = 'manager';
    mockAuth.tenantContext.userId = 'u1';
    mockAuth.tenantContext.permissions = [
      'inventory:read',
      'stock:reserve',
      'stock:release',
      'stock:consume',
    ];
    mocks.getRepair.mockResolvedValue(makeDetail(null));
    mocks.getReceipt.mockResolvedValue({
      order: makeDetail(null).order,
      customer: makeDetail(null).customer,
      device: makeDetail(null).device,
      branch: { id: 'b1', name: 'Main' },
      tenant: { id: 't1', name: 'Shop' },
      events: [],
      issuedAt: '2026-11-24T00:00:00.000Z',
    });
    mocks.listTechnicians.mockResolvedValue([]);
    mocks.listRepairParts.mockResolvedValue({
      items: [
        {
          id: 'l1',
          orderId: 'r1',
          partId: 'p1',
          partSku: 'SCR-001',
          partName: 'Screen',
          qty: 2,
          status: 'reserved',
          createdAt: '2026-11-24T00:00:00.000Z',
        },
        {
          id: 'l2',
          orderId: 'r1',
          partId: 'p2',
          partSku: 'BAT-9',
          partName: 'Battery',
          qty: 1,
          status: 'consumed',
          createdAt: '2026-11-24T00:00:00.000Z',
        },
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
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter initialEntries={['/repairs/r1']}>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route path="/repairs/:id" element={<RepairDetailPage />} />
          </Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('shows the reserve form and release/consume only on reserved lines', async () => {
    renderPage();
    expect(await screen.findByText('قطع غيار الإصلاح')).toBeInTheDocument();
    expect(screen.getByText('حجز قطعة')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'تحرير' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'استهلاك' })).toHaveLength(1);
    expect(screen.getByText(/مستهلكة/)).toBeInTheDocument();
    expect(mocks.listRepairParts).toHaveBeenCalledWith('r1');
  });

  it('hides the reserve form without stock:reserve but still lists lines', async () => {
    mockAuth.tenantContext.permissions = ['inventory:read'];
    renderPage();
    expect(await screen.findByText('قطع غيار الإصلاح')).toBeInTheDocument();
    expect(screen.queryByText('حجز قطعة')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'تحرير' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'استهلاك' })).not.toBeInTheDocument();
  });

  it('hides consume for a technician on a repair assigned to nobody', async () => {
    mockAuth.tenantContext.role = 'technician';
    mockAuth.tenantContext.userId = 'u-tech';
    mockAuth.tenantContext.permissions = ['inventory:read', 'stock:consume'];
    renderPage();
    expect(await screen.findByText('قطع غيار الإصلاح')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'استهلاك' })).not.toBeInTheDocument();
  });

  it('shows consume for a technician on a repair assigned to them', async () => {
    mockAuth.tenantContext.role = 'technician';
    mockAuth.tenantContext.userId = 'u-tech';
    mockAuth.tenantContext.permissions = ['inventory:read', 'stock:consume'];
    mocks.getRepair.mockResolvedValue(
      makeDetail({ id: 'u-tech', name: 'Tech', email: 'tech@example.test' }),
    );
    renderPage();
    expect(await screen.findByText('قطع غيار الإصلاح')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'استهلاك' })).toHaveLength(1);
  });
});
