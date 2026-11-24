import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../api/client';
import HomePage from './HomePage';

const mocks = vi.hoisted(() => ({
  fetchHealth: vi.fn(),
  fetchRepairsSummary: vi.fn(),
  fetchStockOverview: vi.fn(),
  listRepairs: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchHealth: (...args: unknown[]) => mocks.fetchHealth(...args),
    fetchRepairsSummary: (...args: unknown[]) => mocks.fetchRepairsSummary(...args),
    fetchStockOverview: (...args: unknown[]) => mocks.fetchStockOverview(...args),
    listRepairs: (...args: unknown[]) => mocks.listRepairs(...args),
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'a@example.test', name: null },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1'],
      role: 'owner',
      permissions: ['admin', 'report:read', 'inventory:read', 'inventory:write'],
      tenantName: 'ورشة الاختبار',
      branches: [{ id: 'b1', name: 'الفرع الرئيسي' }],
    },
  ],
  tenantContext: {
    userId: 'u1',
    tenantId: 't1',
    branchIds: ['b1'],
    role: 'owner',
    permissions: ['admin', 'report:read', 'inventory:read', 'inventory:write'],
    entitlements: [],
    tenantName: 'ورشة الاختبار',
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

describe('HomePage dashboard', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.fetchHealth.mockReset();
    mocks.fetchRepairsSummary.mockReset();
    mocks.fetchStockOverview.mockReset();
    mocks.listRepairs.mockReset();
    mockAuth.tenantContext.permissions = [
      'admin',
      'report:read',
      'inventory:read',
      'inventory:write',
    ];
    mocks.fetchHealth.mockResolvedValue({ status: 'ok' });
    mocks.fetchRepairsSummary.mockResolvedValue({
      total: 12,
      byStatus: [
        { status: 'received', count: 5 },
        { status: 'in_repair', count: 4 },
        { status: 'awaiting_approval', count: 2 },
        { status: 'awaiting_parts', count: 1 },
        { status: 'delivered', count: 2 },
        { status: 'cancelled', count: 1 },
      ],
      aging: [
        { bucket: '0-1d', count: 3 },
        { bucket: '2-7d', count: 4 },
        { bucket: '8-30d', count: 2 },
        { bucket: '30d+', count: 4 },
      ],
      snapshotAt: '2026-11-24T10:00:00.000Z',
    });
    mocks.fetchStockOverview.mockResolvedValue({
      summary: {
        totalParts: 6,
        totalOnHand: 40,
        totalReserved: 5,
        totalAvailable: 35,
        mismatchedRows: 0,
      },
      items: [],
      nextCursor: null,
      snapshotAt: '2026-11-24T10:00:00.000Z',
    });
    mocks.listRepairs.mockResolvedValue({
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
          branchId: 'b1',
          customerId: 'c2',
          deviceId: 'd2',
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
          <HomePage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders real summary numbers, status chips, stock stats and latest repairs', async () => {
    renderPage();
    // Total 12, open 9 (12 − delivered 2 − cancelled 1), needs attention 3
    // (awaiting approval 2 + awaiting parts 1), over 30 days 4.
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    // Status chips carry their counts and link to the filtered list.
    expect(screen.getByText('مستلم · 5')).toBeInTheDocument();
    expect(screen.getByText('قيد الإصلاح · 4')).toBeInTheDocument();
    // Stock stats come from the overview endpoint.
    expect(screen.getByText('40')).toBeInTheDocument();
    expect(screen.getByText('35')).toBeInTheDocument();
    // Latest repairs link to their detail pages.
    expect(screen.getByText('r1')).toBeInTheDocument();
    expect(screen.getByText('r2')).toBeInTheDocument();
    // The card shows the real problem description from the list
    // response; no customer/device name is invented.
    expect(screen.getByText('الشاشة لا تعمل')).toBeInTheDocument();
    // Quick actions link to real flows.
    expect(screen.getByRole('link', { name: /إصلاح جديد/ })).toHaveAttribute('href', '/repairs');
    expect(screen.getByRole('link', { name: /عميل جديد/ })).toHaveAttribute('href', '/customers');
    // No fabricated revenue or metrics anywhere on the page.
    expect(screen.queryByText(/إيراد|دخل|ربح|نمو/)).not.toBeInTheDocument();
    expect(mocks.fetchRepairsSummary).toHaveBeenCalledWith({});
    expect(mocks.fetchStockOverview).toHaveBeenCalledWith({ limit: 1 });
  });

  it('hides the report sections without report:read', async () => {
    mockAuth.tenantContext.permissions = ['inventory:read'];
    renderPage();
    expect(await screen.findByText('r1')).toBeInTheDocument();
    expect(screen.queryByText('ملخص الإصلاحات')).not.toBeInTheDocument();
    expect(mocks.fetchRepairsSummary).not.toHaveBeenCalled();
    expect(mocks.fetchStockOverview).not.toHaveBeenCalled();
  });

  it('shows an empty state when there are no repairs', async () => {
    mocks.listRepairs.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    expect(await screen.findByText('لا توجد إصلاحات بعد.')).toBeInTheDocument();
  });

  it('shows an error state when the repairs summary fails', async () => {
    mocks.fetchRepairsSummary.mockRejectedValue(new ApiError(500, 'Summary unavailable.'));
    renderPage();
    expect(await screen.findByText('Summary unavailable.')).toBeInTheDocument();
    // The rest of the dashboard still renders: latest repairs load.
    expect(await screen.findByText('r1')).toBeInTheDocument();
  });
});
