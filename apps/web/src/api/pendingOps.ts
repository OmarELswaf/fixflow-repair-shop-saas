/**
 * Durable pending stock operations — reload-safe retry keys.
 *
 * A record stores ONLY what is needed to reconcile an uncertain stock
 * write after a page reload: the idempotency key, the kind of write,
 * the repair it targeted (if any), when it was recorded, and the user
 * who recorded it. It never stores tokens, request bodies (no qty,
 * part id, branch id, prices or customer data) or anything else.
 *
 * Records are USER-scoped as well as tenant-scoped: one localStorage
 * key per pending operation,
 * `fixflow-pending-op:<userId>:<tenantId>:<operationKey>`. Per-op
 * keys mean concurrent writes from different tabs can never clobber
 * each other (each op is its own key; removal is a single delete),
 * and records owned by another user are never read, reconciled or
 * deleted by this user. Records expire after 7 days, are cleared on
 * logout (all of the current user's tenant keys) and on tenant switch
 * (that tenant's keys for the current user). Nothing here ever
 * re-submits an operation: reconciliation only checks whether a
 * movement with the operation key exists, and the user re-enters an
 * unconfirmed write themselves.
 *
 * Cross-tab notifications trigger read-only reconciliation. Reads may
 * overlap safely; there is no exclusive-lock claim. Ownerless legacy
 * records are left untouched, never assigned to a new login.
 */

export type PendingOpKind = 'reserve' | 'release' | 'consume' | 'adjust';

export interface PendingOp {
  operationKey: string;
  kind: PendingOpKind;
  repairOrderId: string | null;
  createdAt: string;
  /** Owner of the record. Records are never read for another user. */
  userId: string;
}

const OP_PREFIX = 'fixflow-pending-op:';
const BROADCAST_PREFIX = 'fixflow-stock-changed:';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** The only keys a serialized record may ever contain. */
export const PENDING_OP_KEYS = [
  'operationKey',
  'kind',
  'repairOrderId',
  'createdAt',
  'userId',
] as const;

/** Current user + tenant; set by AuthContext. */
let currentUserId: string | null = null;
let currentTenantId: string | null = null;

export function setPendingUser(userId: string | null): void {
  currentUserId = userId;
}

export function getPendingUser(): string | null {
  return currentUserId;
}

export function setPendingTenant(tenantId: string | null): void {
  currentTenantId = tenantId;
}

export function getPendingTenant(): string | null {
  return currentTenantId;
}

function opKey(userId: string, tenantId: string, operationKey: string): string {
  return `${OP_PREFIX}${userId}:${tenantId}:${operationKey}`;
}

export function broadcastKey(tenantId: string): string {
  return `${BROADCAST_PREFIX}${tenantId}`;
}

function scanKeys(prefix: string): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key && key.startsWith(prefix)) out.push(key);
    }
  } catch {
    // Storage may be unavailable; treat as empty.
  }
  return out;
}

const KINDS: PendingOpKind[] = ['reserve', 'release', 'consume', 'adjust'];

function isRecordShape(item: unknown): item is Record<string, unknown> {
  return !!item && typeof item === 'object';
}

/** Project parsed JSON back to the allowed field shape; null when invalid. */
function projectOp(item: unknown): PendingOp | null {
  if (!isRecordShape(item)) return null;
  if (typeof item.operationKey !== 'string' || !item.operationKey) return null;
  if (typeof item.kind !== 'string' || !(KINDS as string[]).includes(item.kind)) return null;
  if (typeof item.createdAt !== 'string') return null;
  if (!(item.repairOrderId === null || typeof item.repairOrderId === 'string')) return null;
  if (typeof item.userId !== 'string' || !item.userId) return null;
  return {
    operationKey: item.operationKey,
    kind: item.kind as PendingOpKind,
    repairOrderId: item.repairOrderId,
    createdAt: item.createdAt,
    userId: item.userId,
  };
}

function isExpired(op: { createdAt: string }, now: number): boolean {
  const created = Date.parse(op.createdAt);
  return Number.isNaN(created) || now - created > TTL_MS;
}

/** Do not infer ownership for older ownerless records. */
export function migrateLegacyPendingOps(_userId: string, _tenantId: string): number {
  // Legacy records have no authenticated owner. Leave them untouched and
  // never attribute them to whichever account happens to sign in next.
  return 0;
}

/** Load this user's pending ops for a tenant, dropping expired ones. */
export function loadPendingOps(
  tenantId: string,
  userId: string | null = currentUserId,
): PendingOp[] {
  if (!userId) return [];
  migrateLegacyPendingOps(userId, tenantId);
  const prefix = `${OP_PREFIX}${userId}:${tenantId}:`;
  const now = Date.now();
  const ops: PendingOp[] = [];
  for (const key of scanKeys(prefix)) {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      continue;
    }
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed record: drop the key so it can never be read again.
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore storage failures.
      }
      continue;
    }
    const op = projectOp(parsed);
    const keyOp = key.slice(prefix.length);
    if (!op || op.operationKey !== keyOp || op.userId !== userId) {
      // Tampered or mis-keyed record: drop it.
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore storage failures.
      }
      continue;
    }
    if (isExpired(op, now)) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore storage failures.
      }
      continue;
    }
    ops.push(op);
  }
  return ops.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Record a pending op for the current user+tenant, before its request is sent. */
export function recordPendingOp(op: {
  operationKey: string;
  kind: PendingOpKind;
  repairOrderId: string | null;
}): void {
  if (!currentUserId || !currentTenantId) return;
  const key = opKey(currentUserId, currentTenantId, op.operationKey);
  try {
    if (window.localStorage.getItem(key)) return; // already recorded; keep the original time
    window.localStorage.setItem(
      key,
      JSON.stringify({ ...op, createdAt: new Date().toISOString(), userId: currentUserId }),
    );
  } catch {
    // Storage may be unavailable (private mode, quota). Pending ops are
    // a durability nicety; never fail the app for them.
  }
}

export function removePendingOp(
  tenantId: string,
  operationKey: string,
  userId: string | null = currentUserId,
): void {
  if (!userId) return;
  try {
    window.localStorage.removeItem(opKey(userId, tenantId, operationKey));
  } catch {
    // Ignore storage failures; see recordPendingOp.
  }
}

/** Clear one user's pending ops for one tenant. */
export function clearPendingOps(tenantId: string, userId: string | null = currentUserId): void {
  if (!userId) return;
  for (const key of scanKeys(`${OP_PREFIX}${userId}:${tenantId}:`)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }
}

/** Clear one user's pending ops across ALL tenants (logout). */
export function clearPendingOpsForUser(userId: string): void {
  for (const key of scanKeys(`${OP_PREFIX}${userId}:`)) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Ignore storage failures.
    }
  }
}

/**
 * Clear the current user's pending ops (all tenants) and forget the
 * user+tenant (logout). Tenant switch uses clearPendingOps(previous)
 * instead — it drops only that tenant's records for the current user.
 */
export function clearCurrentPendingOps(): void {
  if (currentUserId) clearPendingOpsForUser(currentUserId);
  currentUserId = null;
  currentTenantId = null;
}

/**
 * Tell other tabs a stock write completed for this tenant. The value
 * is a timestamp only — no business payload. Other tabs invalidate
 * their stock/repair queries on receipt.
 */
export function broadcastStockChanged(tenantId: string): void {
  try {
    window.localStorage.setItem(broadcastKey(tenantId), JSON.stringify({ at: Date.now() }));
  } catch {
    // Ignore storage failures.
  }
}

export type PendingOpsEvent = { type: 'pending-changed' } | { type: 'stock-changed' };

/**
 * Subscribe to pending-op changes made by OTHER tabs (storage events
 * fire only in other tabs). A pending-op change for this user+tenant
 * means re-read; a stock-changed broadcast means invalidate queries.
 * Returns an unsubscribe function.
 */
export function subscribePendingOps(
  userId: string,
  tenantId: string,
  onEvent: (event: PendingOpsEvent) => void,
): () => void {
  const opPrefix = `${OP_PREFIX}${userId}:${tenantId}:`;
  const bKey = broadcastKey(tenantId);
  const handler = (e: StorageEvent) => {
    if (e.key === null) {
      // storage.clear() in another tab: re-read everything.
      onEvent({ type: 'pending-changed' });
      onEvent({ type: 'stock-changed' });
      return;
    }
    if (e.key === bKey) {
      onEvent({ type: 'stock-changed' });
      return;
    }
    if (e.key.startsWith(opPrefix)) {
      onEvent({ type: 'pending-changed' });
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}

export interface ReconcileResult {
  completed: PendingOp[];
  unknown: PendingOp[];
}

/**
 * Reconcile this user's pending ops for a tenant against the movements
 * ledger: a movement with the operation key means the write completed.
 * Concurrent tabs may duplicate these read-only lookups.
 * Completed records are removed; unknown ones are kept. Never
 * re-submits anything.
 */
export async function reconcilePendingOps(
  tenantId: string,
  userId: string | null,
  fetchByKey: (operationKey: string) => Promise<{ items: unknown[] }>,
  isActive: () => boolean = () => true,
): Promise<ReconcileResult> {
  const ops = loadPendingOps(tenantId, userId);
  const completed: PendingOp[] = [];
  const unknown: PendingOp[] = [];
  for (const op of ops) {
    if (!isActive()) break;
    // Lookups are read-only. Duplicate lookups across tabs are safe;
    // localStorage read/write is not an atomic lock, so there is no
    // claim or mutex here — and none is added.
    let found = false;
    try {
      const page = await fetchByKey(op.operationKey);
      found = page.items.length > 0;
    } catch {
      // A failed lookup leaves the outcome unknown; keep the record.
      found = false;
    }
    if (!isActive()) break;
    if (found) {
      completed.push(op);
      removePendingOp(tenantId, op.operationKey, userId);
    } else {
      unknown.push(op);
    }
  }
  return { completed, unknown };
}
