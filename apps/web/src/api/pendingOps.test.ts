import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastKey,
  broadcastStockChanged,
  clearCurrentPendingOps,
  clearPendingOps,
  clearPendingOpsForUser,
  loadPendingOps,
  migrateLegacyPendingOps,
  PENDING_OP_KEYS,
  recordPendingOp,
  reconcilePendingOps,
  removePendingOp,
  setPendingTenant,
  setPendingUser,
  subscribePendingOps,
} from './pendingOps';

const USER_A = 'user-a';
const USER_B = 'user-b';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function opKey(userId: string, tenantId: string, operationKey: string): string {
  return `fixflow-pending-op:${userId}:${tenantId}:${operationKey}`;
}

describe('pendingOps durable store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPendingUser(USER_A);
    setPendingTenant(TENANT_A);
  });

  afterEach(() => {
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
  });

  it('stores only the five allowed fields — no tokens, bodies or business data', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'reserve', repairOrderId: 'repair-1' });
    const raw = window.localStorage.getItem(opKey(USER_A, TENANT_A, 'key-1'));
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([...PENDING_OP_KEYS].sort());
    expect(parsed.userId).toBe(USER_A);
    const serialized = raw as string;
    for (const forbidden of [
      'token',
      'qty',
      'partId',
      'branchId',
      'price',
      'customer',
      'password',
      'accessToken',
      'refreshToken',
      'delta',
      'sku',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('uses one key per op, so two tabs cannot clobber each other', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    recordPendingOp({ operationKey: 'key-2', kind: 'adjust', repairOrderId: null });
    expect(window.localStorage.getItem(opKey(USER_A, TENANT_A, 'key-1'))).not.toBeNull();
    expect(window.localStorage.getItem(opKey(USER_A, TENANT_A, 'key-2'))).not.toBeNull();
    // Removing one leaves the other intact.
    removePendingOp(TENANT_A, 'key-1');
    expect(loadPendingOps(TENANT_A).map((op) => op.operationKey)).toEqual(['key-2']);
    expect(window.localStorage.getItem(opKey(USER_A, TENANT_A, 'key-2'))).not.toBeNull();
  });

  it('is user-scoped: another user never reads, reconciles or deletes these records', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    expect(loadPendingOps(TENANT_A, USER_A)).toHaveLength(1);
    expect(loadPendingOps(TENANT_A, USER_B)).toHaveLength(0);
    // Reconciling as user B touches nothing.
    const fetchByKey = vi.fn(async () => ({ items: [{ id: 'm1' }] }));
    return reconcilePendingOps(TENANT_A, USER_B, fetchByKey).then((result) => {
      expect(result.completed).toHaveLength(0);
      expect(fetchByKey).not.toHaveBeenCalled();
      expect(loadPendingOps(TENANT_A, USER_A)).toHaveLength(1);
      expect(window.localStorage.getItem(opKey(USER_A, TENANT_A, 'key-1'))).not.toBeNull();
    });
  });

  it('is tenant-scoped: another tenant never reads these records', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    expect(loadPendingOps(TENANT_A)).toHaveLength(1);
    expect(loadPendingOps(TENANT_B)).toHaveLength(0);
    setPendingTenant(TENANT_B);
    recordPendingOp({ operationKey: 'key-2', kind: 'reserve', repairOrderId: 'repair-9' });
    expect(loadPendingOps(TENANT_A)).toHaveLength(1);
    expect(loadPendingOps(TENANT_B)).toHaveLength(1);
  });

  it('does not record when no user or tenant is set', () => {
    setPendingUser(null);
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    setPendingUser(USER_A);
    setPendingTenant(null);
    recordPendingOp({ operationKey: 'key-2', kind: 'adjust', repairOrderId: null });
    expect(loadPendingOps(TENANT_A)).toHaveLength(0);
  });

  it('drops records older than 7 days on load and keeps fresh ones', () => {
    const old = {
      operationKey: 'old-key',
      kind: 'adjust' as const,
      repairOrderId: null,
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      userId: USER_A,
    };
    const fresh = {
      operationKey: 'fresh-key',
      kind: 'adjust' as const,
      repairOrderId: null,
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      userId: USER_A,
    };
    window.localStorage.setItem(opKey(USER_A, TENANT_A, 'old-key'), JSON.stringify(old));
    window.localStorage.setItem(opKey(USER_A, TENANT_A, 'fresh-key'), JSON.stringify(fresh));
    const loaded = loadPendingOps(TENANT_A);
    expect(loaded.map((op) => op.operationKey)).toEqual(['fresh-key']);
    // The expired record is pruned from storage too.
    expect(window.localStorage.getItem(opKey(USER_A, TENANT_A, 'old-key'))).toBeNull();
  });

  it('does not duplicate the same operation key', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'reserve', repairOrderId: 'r1' });
    recordPendingOp({ operationKey: 'key-1', kind: 'reserve', repairOrderId: 'r1' });
    expect(loadPendingOps(TENANT_A)).toHaveLength(1);
  });

  it('clearCurrentPendingOps clears all of the current user’s tenant keys, not another user’s', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    setPendingTenant(TENANT_B);
    recordPendingOp({ operationKey: 'key-2', kind: 'adjust', repairOrderId: null });
    setPendingUser(USER_B);
    setPendingTenant(TENANT_A);
    recordPendingOp({ operationKey: 'key-3', kind: 'adjust', repairOrderId: null });
    clearCurrentPendingOps();
    expect(loadPendingOps(TENANT_A, USER_A)).toHaveLength(1);
    expect(loadPendingOps(TENANT_B, USER_A)).toHaveLength(1);
    expect(loadPendingOps(TENANT_A, USER_B)).toHaveLength(0);
  });

  it('clearPendingOpsForUser removes only that user’s records', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    setPendingUser(USER_B);
    recordPendingOp({ operationKey: 'key-2', kind: 'adjust', repairOrderId: null });
    clearPendingOpsForUser(USER_B);
    expect(loadPendingOps(TENANT_A, USER_A)).toHaveLength(1);
    expect(loadPendingOps(TENANT_A, USER_B)).toHaveLength(0);
  });

  it('clearPendingOps removes only the current tenant’s records for the current user', () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'adjust', repairOrderId: null });
    setPendingTenant(TENANT_B);
    recordPendingOp({ operationKey: 'key-2', kind: 'adjust', repairOrderId: null });
    clearPendingOps(TENANT_A);
    expect(loadPendingOps(TENANT_A)).toHaveLength(0);
    expect(loadPendingOps(TENANT_B)).toHaveLength(1);
  });
});

describe('legacy blob migration', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPendingUser(USER_A);
    setPendingTenant(TENANT_A);
  });

  afterEach(() => {
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
  });

  it('never assigns ownerless legacy records to the current user', () => {
    window.localStorage.setItem(
      `fixflow-pending-ops:${TENANT_A}`,
      JSON.stringify([
        {
          operationKey: 'legacy-1',
          kind: 'reserve',
          repairOrderId: 'r1',
          createdAt: new Date().toISOString(),
        },
        {
          operationKey: 'legacy-2',
          kind: 'bogus-kind',
          repairOrderId: null,
          createdAt: new Date().toISOString(),
        },
        {
          operationKey: 'legacy-3',
          kind: 'adjust',
          repairOrderId: null,
          createdAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
        },
      ]),
    );
    expect(migrateLegacyPendingOps(USER_A, TENANT_A)).toBe(0);
    expect(window.localStorage.getItem(`fixflow-pending-ops:${TENANT_A}`)).not.toBeNull();
    const loaded = loadPendingOps(TENANT_A);
    expect(loaded).toHaveLength(0);
    // Another user does not inherit the migrated record.
    expect(loadPendingOps(TENANT_A, USER_B)).toHaveLength(0);
  });

  it('migration happens automatically on load', () => {
    window.localStorage.setItem(
      `fixflow-pending-ops:${TENANT_A}`,
      JSON.stringify([
        {
          operationKey: 'legacy-1',
          kind: 'adjust',
          repairOrderId: null,
          createdAt: new Date().toISOString(),
        },
      ]),
    );
    expect(loadPendingOps(TENANT_A)).toHaveLength(0);
    expect(window.localStorage.getItem(`fixflow-pending-ops:${TENANT_A}`)).not.toBeNull();
  });
});

describe('reconcilePendingOps', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPendingUser(USER_A);
    setPendingTenant(TENANT_A);
  });

  afterEach(() => {
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
  });

  it('removes completed records and keeps unknown ones', async () => {
    recordPendingOp({ operationKey: 'done-key', kind: 'reserve', repairOrderId: 'r1' });
    recordPendingOp({ operationKey: 'missing-key', kind: 'adjust', repairOrderId: null });
    const result = await reconcilePendingOps(TENANT_A, USER_A, async (key) => ({
      items: key === 'done-key' ? [{ id: 'm1' }] : [],
    }));
    expect(result.completed.map((op) => op.operationKey)).toEqual(['done-key']);
    expect(result.unknown.map((op) => op.operationKey)).toEqual(['missing-key']);
    // Only the unknown record remains in the store.
    expect(loadPendingOps(TENANT_A).map((op) => op.operationKey)).toEqual(['missing-key']);
  });

  it('keeps the record when the lookup itself fails', async () => {
    recordPendingOp({ operationKey: 'key-1', kind: 'consume', repairOrderId: 'r1' });
    const result = await reconcilePendingOps(TENANT_A, USER_A, async () => {
      throw new Error('network down');
    });
    expect(result.completed).toHaveLength(0);
    expect(result.unknown.map((op) => op.operationKey)).toEqual(['key-1']);
    expect(loadPendingOps(TENANT_A)).toHaveLength(1);
  });

  it('ignores leftover claim keys from older builds (claims were removed)', async () => {
    // Phase 8 wrote `fixflow-pending-claim:<operationKey>` keys. The
    // runtime no longer reads them: a leftover key must not block,
    // skip or change reconciliation, and reconciliation must not
    // write claim keys of its own.
    window.localStorage.setItem(
      'fixflow-pending-claim:shared-key',
      JSON.stringify({ tabId: 'tab-A', claimedAt: Date.now() }),
    );
    recordPendingOp({ operationKey: 'shared-key', kind: 'adjust', repairOrderId: null });
    const fetchByKey = vi.fn(async () => ({ items: [{ id: 'm1' }] }));
    const result = await reconcilePendingOps(TENANT_A, USER_A, fetchByKey);
    expect(result.completed).toHaveLength(1);
    expect(fetchByKey).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem('fixflow-pending-claim:shared-key')).not.toBeNull();
  });
});

describe('storage sync', () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPendingUser(USER_A);
    setPendingTenant(TENANT_A);
  });

  afterEach(() => {
    window.localStorage.clear();
    setPendingUser(null);
    setPendingTenant(null);
  });

  it('dispatches pending-changed when another tab writes a pending-op key', () => {
    const seen: string[] = [];
    const unsubscribe = subscribePendingOps(USER_A, TENANT_A, (event) => seen.push(event.type));
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: opKey(USER_A, TENANT_A, 'key-9'),
        newValue: '{}',
      }),
    );
    // A key for another user or tenant is ignored.
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: opKey(USER_B, TENANT_A, 'key-9'),
        newValue: '{}',
      }),
    );
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: opKey(USER_A, TENANT_B, 'key-9'),
        newValue: '{}',
      }),
    );
    // A leftover claim key from an older build is ignored: claims
    // were removed, and no storage event for one may trigger a re-read.
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'fixflow-pending-claim:key-9', newValue: '{}' }),
    );
    // An unrelated key is ignored.
    window.dispatchEvent(new StorageEvent('storage', { key: 'fixflow-lang', newValue: 'en' }));
    expect(seen).toEqual(['pending-changed']);
    unsubscribe();
    window.dispatchEvent(
      new StorageEvent('storage', {
        key: opKey(USER_A, TENANT_A, 'key-9'),
        newValue: '{}',
      }),
    );
    expect(seen).toEqual(['pending-changed']);
  });

  it('dispatches stock-changed on the broadcast key, which carries no business payload', () => {
    const seen: string[] = [];
    const unsubscribe = subscribePendingOps(USER_A, TENANT_A, (event) => seen.push(event.type));
    broadcastStockChanged(TENANT_A);
    const raw = window.localStorage.getItem(broadcastKey(TENANT_A));
    expect(raw).not.toBeNull();
    expect(Object.keys(JSON.parse(raw as string))).toEqual(['at']);
    window.dispatchEvent(
      new StorageEvent('storage', { key: broadcastKey(TENANT_A), newValue: raw }),
    );
    // Another tenant's broadcast is ignored.
    window.dispatchEvent(
      new StorageEvent('storage', { key: broadcastKey(TENANT_B), newValue: raw }),
    );
    expect(seen).toEqual(['stock-changed']);
    unsubscribe();
  });
});
