import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ReportsPage from './ReportsPage';

const mocks = vi.hoisted(() => ({
  fetchRepairsSummary: vi.fn(),
  fetchStockOverview: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchRepairsSummary: (...args: unknown[]) => mocks.fetchRepairsSummary(...args),
    fetchStockOverview: (...args: unknown[]) => mocks.fetchStockOverview(...args),
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@example.test', name: null },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1', 'b2'],
      role: 'manager',
      permissions: ['report:read'],
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
    permissions: ['report:read'],
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

describe('ReportsPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.fetchRepairsSummary.mockReset();
    mocks.fetchStockOverview.mockReset();
    mockAuth.tenantContext.permissions = ['report:read'];
    mocks.fetchRepairsSummary.mockResolvedValue({
      total: 12,
      byStatus: [
        { status: 'received', count: 5 },
        { status: 'in_repair', count: 7 },
      ],
      aging: [
        { bucket: '0-1d', count: 3 },
        { bucket: '2-7d', count: 4 },
        { bucket: '8-30d', count: 2 },
        { bucket: '30d+', count: 3 },
      ],
      snapshotAt: '2026-11-24T10:00:00.000Z',
    });
    mocks.fetchStockOverview.mockResolvedValue({
      summary: {
        totalParts: 4,
        totalOnHand: 100,
        totalReserved: 9,
        totalAvailable: 91,
        mismatchedRows: 1,
      },
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
          reservedLinesTotal: 3,
          discrepancy: 0,
          reconciled: true,
        },
        {
          partId: 'p2',
          partSku: 'BAT-9',
          partName: 'Battery',
          branchId: 'b1',
          branchName: 'Main',
          qtyOnHand: 8,
          reservedQty: 5,
          available: 3,
          reservedLinesTotal: 3,
          discrepancy: -2,
          reconciled: false,
        },
      ],
      nextCursor: null,
      snapshotAt: '2026-11-24T10:00:00.000Z',
    });
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <ReportsPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders repair counts, aging buckets and the stock reconciliation', async () => {
    renderPage();
    expect(await screen.findByText('التقارير')).toBeInTheDocument();
    // Wait for the summary data before asserting on it.
    expect(await screen.findByText('مستلم')).toBeInTheDocument();
    // Total repairs and the two status counts.
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('قيد الإصلاح')).toBeInTheDocument();
    // Aging buckets, localized.
    expect(screen.getByText('0–1 يوم')).toBeInTheDocument();
    expect(screen.getByText('2–7 أيام')).toBeInTheDocument();
    expect(screen.getByText('أكثر من 30 يوماً')).toBeInTheDocument();
    // Stock summary totals.
    expect(screen.getByText('100')).toBeInTheDocument();
    expect(screen.getByText('91')).toBeInTheDocument();
    // Reconciliation table: both parts, and the mismatched row is flagged.
    // 'مطابق' appears twice: the column header and the reconciled row.
    expect(screen.getAllByText('SCR-001')[0]).toBeInTheDocument();
    expect(screen.getAllByText('BAT-9')[0]).toBeInTheDocument();
    expect(screen.getAllByText('مطابق')).toHaveLength(2);
    expect(screen.getAllByText('غير مطابق')[0]).toBeInTheDocument();
    expect(screen.getAllByText('-2')[0]).toBeInTheDocument();
    // Snapshot labels: both sections show the same "as of" time.
    expect(screen.getAllByText(/اعتباراً من/)).toHaveLength(2);
    // Link to the filtered repairs list.
    expect(screen.getByText('عرض هذه الإصلاحات')).toBeInTheDocument();
  });

  it('is hidden without report:read', async () => {
    mockAuth.tenantContext.permissions = [];
    renderPage();
    expect(await screen.findByText('ليس لديك صلاحية لعرض هذه الصفحة.')).toBeInTheDocument();
    expect(mocks.fetchRepairsSummary).not.toHaveBeenCalled();
    expect(mocks.fetchStockOverview).not.toHaveBeenCalled();
  });
});
