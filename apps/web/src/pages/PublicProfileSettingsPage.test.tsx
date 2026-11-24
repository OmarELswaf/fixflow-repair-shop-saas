import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import PublicProfileSettingsPage from './PublicProfileSettingsPage';

const mocks = vi.hoisted(() => ({
  fetchOwnPublicProfile: vi.fn(),
  saveOwnPublicProfile: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchOwnPublicProfile: (...args: unknown[]) => mocks.fetchOwnPublicProfile(...args),
    saveOwnPublicProfile: (...args: unknown[]) => mocks.saveOwnPublicProfile(...args),
  };
});

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

const savedProfile = {
  slug: 'my-shop',
  displayName: 'ورشتي',
  description: null,
  logoUrl: null,
  theme: 'green',
  services: [],
  contact: null,
  hours: null,
  published: false,
  updatedAt: '2026-11-24T00:00:00.000Z',
};

describe('PublicProfileSettingsPage', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mocks.fetchOwnPublicProfile.mockReset();
    mocks.saveOwnPublicProfile.mockReset();
    mockAuth.tenantContext.permissions = ['admin', 'report:read', 'inventory:read'];
  });

  function renderPage() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <PublicProfileSettingsPage />
      </QueryClientProvider>,
    );
  }

  it('shows a loading state while the profile loads', () => {
    mocks.fetchOwnPublicProfile.mockReturnValue(new Promise(() => undefined));
    renderPage();
    expect(screen.getByLabelText('loading')).toBeInTheDocument();
  });

  it('shows a no-access message for a non-owner and no form', () => {
    mockAuth.tenantContext.permissions = ['report:read'];
    mocks.fetchOwnPublicProfile.mockResolvedValue(savedProfile);
    renderPage();
    expect(screen.getByText('ليس لديك صلاحية لعرض هذه الصفحة.')).toBeInTheDocument();
    expect(screen.queryByLabelText(/العنوان/)).toBeNull();
    expect(mocks.fetchOwnPublicProfile).not.toHaveBeenCalled();
  });

  it('defaults to unpublished when no profile exists yet', async () => {
    mocks.fetchOwnPublicProfile.mockRejectedValue(new ApiError(404, 'Not found'));
    renderPage();
    const slug = await screen.findByLabelText(/العنوان \(slug\)/);
    expect(slug).toHaveValue('');
    expect(screen.getByRole('switch', { name: 'منشورة' })).not.toBeChecked();
    expect(
      screen.getByText('لم تُنشئ صفحة عامة بعد. املأ الحقول واحفظ لترى المعاينة.'),
    ).toBeInTheDocument();
  });

  it('publishes and unpublishes through the toggle and shows the matching preview banner', async () => {
    mocks.fetchOwnPublicProfile.mockResolvedValue({ ...savedProfile, published: false });
    mocks.saveOwnPublicProfile.mockImplementation(async (input: unknown) => ({
      ...savedProfile,
      ...(input as Record<string, unknown>),
    }));
    renderPage();
    await screen.findByLabelText(/العنوان \(slug\)/);
    expect(screen.getByRole('switch', { name: 'منشورة' })).not.toBeChecked();
    expect(
      screen.getByText('معاينة — الصفحة غير منشورة بعد، ولن يراها الزوار حتى تنشرها.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('switch', { name: 'منشورة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصفحة العامة' }));
    await screen.findByText('تم حفظ الصفحة العامة.');
    // TanStack Query v5 calls the mutation function with
    // (variables, context); only the first argument is the payload.
    expect(mocks.saveOwnPublicProfile.mock.calls[0][0]).toEqual(
      expect.objectContaining({ slug: 'my-shop', displayName: 'ورشتي', published: true }),
    );
  });

  it('shows the published preview banner and view link for a published profile', async () => {
    mocks.fetchOwnPublicProfile.mockResolvedValue({ ...savedProfile, published: true });
    renderPage();
    await screen.findByLabelText(/العنوان \(slug\)/);
    expect(screen.getByRole('switch', { name: 'منشورة' })).toBeChecked();
    expect(screen.getByText('معاينة — هذه هي الصفحة المنشورة حالياً.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'عرض الصفحة العامة' })).toHaveAttribute(
      'href',
      '/s/my-shop',
    );
  });

  it('rejects an invalid slug inline, focuses the field, and does not save', async () => {
    mocks.fetchOwnPublicProfile.mockRejectedValue(new ApiError(404, 'Not found'));
    renderPage();
    const slug = await screen.findByLabelText(/العنوان \(slug\)/);
    fireEvent.change(slug, { target: { value: 'Bad Slug!' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصفحة العامة' }));
    expect(
      await screen.findByText(
        'العنوان يجب أن يكون من 3 إلى 64 حرفاً: أحرف إنجليزية صغيرة وأرقام وشرطات فقط، ولا يبدأ أو ينتهي بشرطة.',
      ),
    ).toBeInTheDocument();
    expect(slug).toHaveAttribute('aria-invalid', 'true');
    expect(document.activeElement).toBe(slug);
    expect(mocks.saveOwnPublicProfile).not.toHaveBeenCalled();
  });

  it('requires a display name to publish, inline on the name field', async () => {
    mocks.fetchOwnPublicProfile.mockRejectedValue(new ApiError(404, 'Not found'));
    renderPage();
    const slug = await screen.findByLabelText(/العنوان \(slug\)/);
    fireEvent.change(slug, { target: { value: 'my-shop' } });
    fireEvent.click(screen.getByRole('switch', { name: 'منشورة' }));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصفحة العامة' }));
    expect(await screen.findByText('اسم الورشة المعروض مطلوب لنشر الصفحة.')).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('اسم الورشة المعروض'));
    expect(mocks.saveOwnPublicProfile).not.toHaveBeenCalled();
  });

  it('rejects a closing time before the opening time', async () => {
    mocks.fetchOwnPublicProfile.mockRejectedValue(new ApiError(404, 'Not found'));
    renderPage();
    await screen.findByLabelText(/العنوان \(slug\)/);
    // Saturday mode select: open the menu and pick "opens".
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'السبت' }));
    fireEvent.click(await screen.findByRole('option', { name: 'يفتح' }));
    const closeInput = screen.getByLabelText('يغلق', { selector: 'input' });
    fireEvent.change(closeInput, { target: { value: '08:00' } });
    fireEvent.change(screen.getByLabelText(/العنوان \(slug\)/), { target: { value: 'my-shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصفحة العامة' }));
    expect(await screen.findByText('وقت الإغلاق يجب أن يكون بعد وقت الفتح.')).toBeInTheDocument();
    expect(mocks.saveOwnPublicProfile).not.toHaveBeenCalled();
  });

  it('renders contact inputs left-to-right for international values', async () => {
    mocks.fetchOwnPublicProfile.mockRejectedValue(new ApiError(404, 'Not found'));
    renderPage();
    await screen.findByLabelText(/العنوان \(slug\)/);
    for (const label of ['الهاتف', 'واتساب', 'البريد الإلكتروني', 'الموقع الإلكتروني']) {
      expect(screen.getByLabelText(label)).toHaveAttribute('dir', 'ltr');
    }
    expect(screen.getByLabelText(/العنوان \(slug\)/)).toHaveAttribute('dir', 'ltr');
  });

  it('shows a save error without losing the form', async () => {
    mocks.fetchOwnPublicProfile.mockRejectedValue(new ApiError(404, 'Not found'));
    mocks.saveOwnPublicProfile.mockRejectedValue(new ApiError(400, 'Slug already taken.'));
    renderPage();
    const slug = await screen.findByLabelText(/العنوان \(slug\)/);
    fireEvent.change(slug, { target: { value: 'my-shop' } });
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الصفحة العامة' }));
    expect(await screen.findByText('Slug already taken.')).toBeInTheDocument();
    expect(screen.getByLabelText(/العنوان \(slug\)/)).toHaveValue('my-shop');
  });
});
