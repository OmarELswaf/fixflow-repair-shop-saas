import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { adjustStock, clearTenantCaches } from '../api/client';
import { loadPendingOps, setPendingTenant, setPendingUser } from '../api/pendingOps';

const TENANT_ID = 't1';
const USER_ID = 'u1';

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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Real lost-response / reload tests (not seeded fixtures). The flow is:
 * submit a real stock write through stockWrite -> the fake server
 * applies it (or not) and the response is lost -> the pending record
 * exists -> simulate a reload with a fresh module state -> the banner
 * reconciles against the fake ledger. No re-POST is ever sent.
 */
describe('lost response then reload', () => {
  // Fake server state: movements recorded by operation key.
  const serverMovements = new Map<string, Array<{ id: string }>>();
  let adjustPosts = 0;
  let serverApplies = true;

  beforeEach(() => {
    window.localStorage.clear();
    serverMovements.clear();
    adjustPosts = 0;
    serverApplies = true;
    clearTenantCaches();
    setPendingUser(USER_ID);
    setPendingTenant(TENANT_ID);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/api/stock/adjust') && init?.method === 'POST') {
          adjustPosts += 1;
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            idempotencyKey?: string;
          };
          if (serverApplies && body.idempotencyKey) {
            const list = serverMovements.get(body.idempotencyKey) ?? [];
            list.push({ id: `m-${body.idempotencyKey}` });
            serverMovements.set(body.idempotencyKey, list);
          }
          // The response is lost after the server processed it.
          throw new TypeError('network down');
        }
        if (u.includes('/api/stock/movements')) {
          const key = new URL(u, 'http://localhost').searchParams.get('operationKey') ?? '';
          return jsonResponse(200, {
            items: serverMovements.get(key) ?? [],
            nextCursor: null,
          });
        }
        return jsonResponse(404, { message: 'not found' });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function reloadAndRenderBanner() {
    // Simulate a page reload: fresh module state (in-memory retry keys
    // and tab id are gone); localStorage and the fake server survive.
    vi.resetModules();
    const freshPendingOps = await import('../api/pendingOps');
    const { default: FreshBanner } = await import('./PendingOpsBanner');
    freshPendingOps.setPendingUser(USER_ID);
    freshPendingOps.setPendingTenant(TENANT_ID);
    render(
      <MemoryRouter>
        <FreshBanner />
      </MemoryRouter>,
    );
  }

  it('server applied the write but the response was lost: completed notice, no re-POST', async () => {
    await expect(
      adjustStock({ branchId: 'b1', partId: 'p1', delta: 2, idempotencyKey: 'lost-key-1' }),
    ).rejects.toThrow('network down');
    expect(adjustPosts).toBe(1);
    // The pending record survived the lost response.
    expect(loadPendingOps(TENANT_ID).map((op) => op.operationKey)).toEqual(['lost-key-1']);

    await reloadAndRenderBanner();
    // Generous timeout: the reload path re-imports modules and
    // reconciles asynchronously; under full-suite parallel load the
    // default 1 s findByText timeout flakes (seen once in four runs).
    expect(
      await screen.findByText(/اكتمل تغيير مخزون من قبل إعادة التحميل/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // No re-POST: the banner only reads the ledger.
    expect(adjustPosts).toBe(1);
    // The completed record is removed.
    expect(
      window.localStorage.getItem(`fixflow-pending-op:${USER_ID}:${TENANT_ID}:lost-key-1`),
    ).toBeNull();
  });

  it('server never saw the write: unknown notice, no re-POST, record kept', async () => {
    serverApplies = false;
    await expect(
      // A distinct delta from the first test: the in-memory retry key
      // is retained per request fingerprint, so the same body would
      // reuse the first test's key by design.
      adjustStock({ branchId: 'b1', partId: 'p1', delta: 3, idempotencyKey: 'lost-key-2' }),
    ).rejects.toThrow('network down');
    expect(adjustPosts).toBe(1);
    expect(loadPendingOps(TENANT_ID).map((op) => op.operationKey)).toEqual(['lost-key-2']);

    await reloadAndRenderBanner();
    expect(
      await screen.findByText(/تعذر تأكيد تغيير مخزون من قبل إعادة التحميل/, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(adjustPosts).toBe(1);
    // The outcome is unknown: the record is kept until the user checks.
    expect(
      window.localStorage.getItem(`fixflow-pending-op:${USER_ID}:${TENANT_ID}:lost-key-2`),
    ).not.toBeNull();
  });
});
