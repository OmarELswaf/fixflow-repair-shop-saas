import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adjustStock, reservePart, clearTenantCaches } from './client';
import { loadPendingOps, setPendingTenant, setPendingUser } from './pendingOps';

const TENANT_ID = 't1';
const USER_ID = 'u1';

function opKey(operationKey: string): string {
  return `fixflow-pending-op:${USER_ID}:${TENANT_ID}:${operationKey}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('stockWrite durable pending records', () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearTenantCaches();
    setPendingUser(USER_ID);
    setPendingTenant(TENANT_ID);
  });

  afterEach(() => {
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
    vi.unstubAllGlobals();
  });

  it('records the op before the request is sent and removes it on success', async () => {
    let seenDuringRequest: unknown = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        seenDuringRequest = window.localStorage.getItem(opKey('test-key-1'));
        const body = JSON.parse(String(init?.body ?? '{}')) as { idempotencyKey?: string };
        expect(body.idempotencyKey).toBe('test-key-1');
        return jsonResponse(200, {
          partId: 'p1',
          partSku: 'SCR-1',
          partName: 'Screen',
          branchId: 'b1',
          branchName: 'Main',
          qtyOnHand: 12,
          reservedQty: 0,
          available: 12,
        });
      }),
    );
    await adjustStock({
      branchId: 'b1',
      partId: 'p1',
      delta: 2,
      idempotencyKey: 'test-key-1',
    });
    // The record existed while the request was in flight (before send).
    expect(seenDuringRequest).not.toBeNull();
    const recorded = JSON.parse(seenDuringRequest as string) as {
      operationKey: string;
      kind: string;
      repairOrderId: string | null;
      userId: string;
    };
    expect(recorded).toEqual({
      operationKey: 'test-key-1',
      kind: 'adjust',
      repairOrderId: null,
      createdAt: expect.any(String),
      userId: USER_ID,
    });
    // Success removes it.
    expect(loadPendingOps(TENANT_ID)).toHaveLength(0);
  });

  it('records repair ops with the repair id and removes them on a 422', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(422, { message: 'Not enough stock' })),
    );
    await expect(
      reservePart('repair-7', { partId: 'p1', qty: 5, idempotencyKey: 'test-key-2' }),
    ).rejects.toThrow('Not enough stock');
    // A definitive 4xx means the write did not happen: record removed.
    expect(loadPendingOps(TENANT_ID)).toHaveLength(0);
  });

  it('keeps the record when the request fails without a response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('network down');
      }),
    );
    await expect(
      adjustStock({ branchId: 'b1', partId: 'p1', delta: 2, idempotencyKey: 'test-key-3' }),
    ).rejects.toThrow('network down');
    // Uncertain outcome: the record stays for reconciliation after reload.
    expect(loadPendingOps(TENANT_ID).map((op) => op.operationKey)).toEqual(['test-key-3']);
  });

  it('blocks a fresh write after reload until an uncertain operation is checked', async () => {
    localStorage.setItem(
      opKey('old-key'),
      JSON.stringify({
        operationKey: 'old-key',
        kind: 'adjust',
        repairOrderId: null,
        createdAt: new Date().toISOString(),
        userId: USER_ID,
      }),
    );
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(
      adjustStock({ branchId: 'b1', partId: 'p1', delta: 2, idempotencyKey: 'fresh-key' }),
    ).rejects.toThrow('uncertain outcome');
    expect(fetcher).not.toHaveBeenCalled();
    expect(loadPendingOps(TENANT_ID)).toHaveLength(1);
  });

  it('keeps the record on a 5xx (the server may have applied the write)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(500, { message: 'boom' })),
    );
    // A different delta from the earlier tests: the in-memory retry key
    // is retained per request fingerprint, so the same body would reuse
    // the earlier test's key by design.
    await expect(
      adjustStock({ branchId: 'b1', partId: 'p1', delta: 3, idempotencyKey: 'test-key-4' }),
    ).rejects.toThrow('boom');
    expect(loadPendingOps(TENANT_ID).map((op) => op.operationKey)).toEqual(['test-key-4']);
  });
});
