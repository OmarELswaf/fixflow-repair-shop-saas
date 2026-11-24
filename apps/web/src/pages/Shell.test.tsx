import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Shell from './Shell';

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'owner@example.test', name: 'Owner' },
  memberships: [
    {
      tenantId: 't1',
      branchIds: ['b1'],
      role: 'owner',
      permissions: ['admin', 'report:read', 'inventory:read'],
      tenantName: 'ورشة الاختبار',
      branches: [{ id: 'b1', name: 'الفرع الرئيسي' }],
    },
  ],
  tenantContext: {
    userId: 'u1',
    tenantId: 't1',
    branchIds: ['b1'],
    role: 'owner',
    permissions: ['admin', 'report:read', 'inventory:read'],
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

function renderShell() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Shell lang="ar" onLanguage={() => undefined} />}>
          <Route index element={<div>home</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('Shell tenant switch', () => {
  afterEach(() => {
    cleanup();
  });

  it('hides the switch button for a single-tenant user', () => {
    renderShell();
    expect(screen.queryByRole('link', { name: 'تبديل الورشة' })).toBeNull();
  });

  it('shows the switch button linking to /select-tenant for a multi-tenant user', () => {
    mockAuth.memberships.push({
      tenantId: 't2',
      branchIds: ['b2'],
      role: 'manager',
      permissions: ['inventory:read'],
      tenantName: 'ورشة ثانية',
      branches: [{ id: 'b2', name: 'الفرع الثاني' }],
    });
    try {
      renderShell();
      // The switch control lives in the navigation drawer now (Phase 10
      // redesign): open the menu first, then the link is present.
      fireEvent.click(screen.getByRole('button', { name: 'القائمة' }));
      const link = screen.getByRole('link', { name: 'تبديل الورشة' });
      expect(link).toHaveAttribute('href', '/select-tenant');
    } finally {
      mockAuth.memberships.pop();
    }
  });

  it('shows the primary destinations in the bottom navigation', () => {
    renderShell();
    expect(screen.getByRole('button', { name: 'الرئيسية' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'الإصلاحات' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'العملاء' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'المخزون' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'التقارير' })).toBeInTheDocument();
  });

  it('hides the public-page nav item for a non-owner', () => {
    // The settings route is owner-only (admin permission); the nav
    // item must not appear for anyone who cannot use it.
    const savedPermissions = mockAuth.tenantContext.permissions;
    mockAuth.tenantContext.permissions = ['report:read', 'inventory:read'];
    mockAuth.memberships[0].permissions = ['report:read', 'inventory:read'];
    try {
      renderShell();
      fireEvent.click(screen.getByRole('button', { name: 'القائمة' }));
      expect(screen.queryByRole('link', { name: 'الصفحة العامة' })).toBeNull();
      // The team item is owner-only too; other destinations stay.
      expect(screen.queryByRole('link', { name: 'الفريق' })).toBeNull();
      expect(screen.getByRole('link', { name: 'الإصلاحات' })).toBeInTheDocument();
    } finally {
      mockAuth.tenantContext.permissions = savedPermissions;
      mockAuth.memberships[0].permissions = savedPermissions;
    }
  });

  it('shows the public-page nav item for an owner', () => {
    renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'القائمة' }));
    const link = screen.getByRole('link', { name: 'الصفحة العامة' });
    expect(link).toHaveAttribute('href', '/settings/public-profile');
  });

  it('remounts routed form state when the tenant changes', () => {
    // Regression for the reviewed Phase 10 fix: the Shell keys the
    // Outlet on the tenant id, so one tenant's unsaved form values
    // cannot carry into another tenant's form. The child below holds
    // local state the way a form does; changing the tenant must
    // reset it.
    function StatefulChild() {
      const [value, setValue] = useState('');
      return <input aria-label="draft" value={value} onChange={(e) => setValue(e.target.value)} />;
    }
    const savedContext = mockAuth.tenantContext;
    const { rerender } = render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Shell lang="ar" onLanguage={() => undefined} />}>
            <Route index element={<StatefulChild />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    try {
      const input = screen.getByLabelText('draft');
      fireEvent.change(input, { target: { value: 'tenant-a-draft' } });
      expect(input).toHaveValue('tenant-a-draft');
      mockAuth.tenantContext = { ...savedContext, tenantId: 't2' };
      rerender(
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<Shell lang="ar" onLanguage={() => undefined} />}>
              <Route index element={<StatefulChild />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
      expect(screen.getByLabelText('draft')).toHaveValue('');
    } finally {
      mockAuth.tenantContext = savedContext;
    }
  });
});
