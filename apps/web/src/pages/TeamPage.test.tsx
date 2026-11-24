import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import TeamPage from './TeamPage';

const mocks = vi.hoisted(() => ({
  fetchTeam: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchTeam: (...args: unknown[]) => mocks.fetchTeam(...args),
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'owner@example.test', name: 'Owner' },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1', 'b2'],
      role: 'owner',
      permissions: ['admin', 'report:read'],
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
    role: 'owner',
    permissions: ['admin', 'report:read'],
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

describe('TeamPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.fetchTeam.mockReset();
    mockAuth.tenantContext.permissions = ['admin', 'report:read'];
    mockAuth.tenantContext.role = 'owner';
    mocks.fetchTeam.mockResolvedValue({
      branches: [
        { id: 'b1', name: 'Main' },
        { id: 'b2', name: 'North' },
      ],
      members: [
        {
          userId: 'u1',
          name: 'Owner',
          email: 'owner@example.test',
          role: 'owner',
          branchIds: ['b1', 'b2'],
          branchNames: ['Main', 'North'],
        },
        {
          userId: 'u2',
          name: 'Tech',
          email: 'tech@example.test',
          role: 'technician',
          branchIds: ['b1'],
          branchNames: ['Main'],
        },
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
          <TeamPage />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  it('renders branches and members with localized roles, and no admin controls', async () => {
    renderPage();
    expect(await screen.findByText('الفريق والفروع')).toBeInTheDocument();
    // Wait for the team data before asserting on it. 'Main' appears
    // twice: the branches list and the technician's branch cell.
    expect((await screen.findAllByText('Main')).length).toBe(2);
    expect(screen.getByText('North')).toBeInTheDocument();
    expect(screen.getAllByText('owner@example.test')[0]).toBeInTheDocument();
    expect(screen.getAllByText('tech@example.test')[0]).toBeInTheDocument();
    expect(screen.getByText('مالك')).toBeInTheDocument();
    expect(screen.getByText('فني')).toBeInTheDocument();
    // Read-only: no invitation, role change or branch creation controls.
    expect(screen.queryByText(/دعوة/)).not.toBeInTheDocument();
    expect(mocks.fetchTeam).toHaveBeenCalledTimes(1);
  });

  it('is hidden without the admin permission', async () => {
    mockAuth.tenantContext.permissions = ['report:read'];
    mockAuth.tenantContext.role = 'manager';
    renderPage();
    expect(await screen.findByText('ليس لديك صلاحية لعرض هذه الصفحة.')).toBeInTheDocument();
    expect(mocks.fetchTeam).not.toHaveBeenCalled();
  });
});
