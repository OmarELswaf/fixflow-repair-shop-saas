import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import PendingOpsBanner from './PendingOpsBanner';
import { setPendingTenant, setPendingUser } from '../api/pendingOps';

const TENANT_ID = 't1';
const USER_ID = 'u1';

function opKey(operationKey: string): string {
  return `fixflow-pending-op:${USER_ID}:${TENANT_ID}:${operationKey}`;
}

const mocks = vi.hoisted(() => ({
  fetchMovementsByOperationKey: vi.fn(),
}));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    fetchMovementsByOperationKey: (...args: unknown[]) =>
      mocks.fetchMovementsByOperationKey(...args),
  };
});

const mockAuth = vi.hoisted(() => ({
  user: { id: 'u1', email: 'u1@example.test', name: 'User One' },
  tenantContext: {
    userId: 'u1',
    tenantId: 't1',
    branchIds: ['b1'],
    role: 'manager',
    permissions: ['inventory:read'],
    entitlements: [],
  },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

function seedPending() {
  window.localStorage.setItem(
    opKey('done-key'),
    JSON.stringify({
      operationKey: 'done-key',
      kind: 'reserve',
      repairOrderId: 'repair-1',
      createdAt: new Date().toISOString(),
      userId: USER_ID,
    }),
  );
  window.localStorage.setItem(
    opKey('missing-key'),
    JSON.stringify({
      operationKey: 'missing-key',
      kind: 'adjust',
      repairOrderId: null,
      createdAt: new Date().toISOString(),
      userId: USER_ID,
    }),
  );
}

describe('PendingOpsBanner', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPendingUser(USER_ID);
    setPendingTenant(TENANT_ID);
    mocks.fetchMovementsByOperationKey.mockImplementation(async (key: string) => ({
      items: key === 'done-key' ? [{ id: 'm1' }] : [],
      nextCursor: null,
    }));
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
    mocks.fetchMovementsByOperationKey.mockReset();
  });

  it('shows a completed notice and removes the record, keeps the unknown one', async () => {
    seedPending();
    render(
      <MemoryRouter>
        <PendingOpsBanner />
      </MemoryRouter>,
    );
    // Completed: the movement exists, so the record is gone.
    expect(await screen.findByText(/اكتمل تغيير مخزون من قبل إعادة التحميل/)).toBeInTheDocument();
    // Unknown: no movement found, so the record is kept.
    expect(
      await screen.findByText(/تعذر تأكيد تغيير مخزون من قبل إعادة التحميل/),
    ).toBeInTheDocument();
    const stored = window.localStorage.getItem(opKey('missing-key'));
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).operationKey).toBe('missing-key');
    // The completed record is gone.
    expect(window.localStorage.getItem(opKey('done-key'))).toBeNull();
    // The unknown notice links to the Stock page (no repair targeted).
    expect(screen.getByRole('link', { name: /المخزون/ })).toHaveAttribute('href', '/stock');
    // The completed notice links to its repair.
    expect(screen.getByRole('link', { name: /الإصلاح/ })).toHaveAttribute(
      'href',
      '/repairs/repair-1',
    );
  });

  it('dismissing the unknown notice removes the record ("I have checked")', async () => {
    seedPending();
    render(
      <MemoryRouter>
        <PendingOpsBanner />
      </MemoryRouter>,
    );
    const dismiss = await screen.findByRole('button', { name: 'لقد تحققت' });
    fireEvent.click(dismiss);
    await waitFor(() => {
      expect(window.localStorage.getItem(opKey('missing-key'))).toBeNull();
    });
    expect(screen.queryByText(/تعذر تأكيد تغيير مخزون/)).not.toBeInTheDocument();
  });

  it('reconciles under StrictMode effect replay', async () => {
    seedPending();
    render(
      <StrictMode>
        <MemoryRouter>
          <PendingOpsBanner />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(await screen.findByText(/تعذر تأكيد تغيير مخزون/)).toBeInTheDocument();
    expect(await screen.findByText(/اكتمل تغيير مخزون/)).toBeInTheDocument();
  });

  it('renders nothing when there are no pending ops', async () => {
    render(
      <MemoryRouter>
        <PendingOpsBanner />
      </MemoryRouter>,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.fetchMovementsByOperationKey).not.toHaveBeenCalled();
  });

  it('never re-submits: reconciliation only reads the ledger', async () => {
    seedPending();
    const fetchSpy = vi.spyOn(window, 'fetch');
    render(
      <MemoryRouter>
        <PendingOpsBanner />
      </MemoryRouter>,
    );
    await screen.findByText(/تعذر تأكيد تغيير مخزون/);
    expect(mocks.fetchMovementsByOperationKey).toHaveBeenCalledTimes(2);
    // No direct POST anywhere from the banner.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
