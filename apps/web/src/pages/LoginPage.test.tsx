import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import LoginPage from './LoginPage';
import { ApiError } from '../api/client';

const loginMock = vi.fn();

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    login: loginMock,
    user: null,
    memberships: [],
    tenantContext: null,
    tenantChoices: [],
    needsTenantSelection: false,
    isAuthenticated: false,
    loading: false,
    register: vi.fn(),
    logout: vi.fn(),
    selectTenant: vi.fn(),
    refreshMe: vi.fn(),
  }),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    loginMock.mockReset();
  });

  // Vitest here runs without globals, so Testing Library does not
  // auto-cleanup between tests; unmount explicitly.
  afterEach(() => {
    cleanup();
  });

  function renderPage() {
    return render(
      <MemoryRouter initialEntries={['/login']}>
        <LoginPage />
      </MemoryRouter>,
    );
  }

  it('renders the login form', () => {
    renderPage();
    expect(screen.getByText('تسجيل الدخول إلى FixFlow')).toBeInTheDocument();
    // MUI appends a required asterisk to the label text, so match by regex.
    expect(screen.getByLabelText(/البريد الإلكتروني/)).toBeInTheDocument();
    expect(screen.getByLabelText(/كلمة المرور/)).toBeInTheDocument();
  });

  it('submits email and password to login', async () => {
    loginMock.mockResolvedValueOnce({
      user: { id: 'u1', email: 'a@example.test', name: null },
      tenantId: 't1',
      tokens: { accessToken: 'x', refreshToken: '' },
    });
    renderPage();
    fireEvent.change(screen.getByLabelText(/البريد الإلكتروني/), {
      target: { value: 'a@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/كلمة المرور/), {
      target: { value: 'twelve-chars-min' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    await waitFor(() => {
      expect(loginMock).toHaveBeenCalledWith('a@example.test', 'twelve-chars-min');
    });
  });

  it('shows the server 401 message', async () => {
    loginMock.mockRejectedValueOnce(new ApiError(401, 'Invalid email or password.'));
    renderPage();
    fireEvent.change(screen.getByLabelText(/البريد الإلكتروني/), {
      target: { value: 'a@example.test' },
    });
    fireEvent.change(screen.getByLabelText(/كلمة المرور/), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'دخول' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    );
  });
});
