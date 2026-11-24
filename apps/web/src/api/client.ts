import { QueryClient } from '@tanstack/react-query';
import {
  broadcastStockChanged,
  getPendingTenant,
  getPendingUser,
  loadPendingOps,
  recordPendingOp,
  removePendingOp,
  type PendingOpKind,
} from './pendingOps';

export const queryClient = new QueryClient();

/** Clear all cached tenant data — used on logout / tenant switch. */
export function clearTenantCaches(): void {
  queryClient.clear();
  pendingStockKeys.clear();
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Unauthorized') {
    super(401, message);
    this.name = 'UnauthorizedError';
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const message = (body as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
    if (Array.isArray(message)) {
      const joined = message.filter((m): m is string => typeof m === 'string').join('; ');
      if (joined) return joined;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Tokens — memory only. NEVER localStorage / sessionStorage.
// The refresh token lives in the HttpOnly `ff_refresh` cookie and is
// sent by the browser automatically (credentials: 'include').
// ---------------------------------------------------------------------------

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Single-flight refresh: concurrent 401s share one /auth/refresh call. */
let refreshPromise: Promise<string | null> | null = null;

function doRefresh(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async (): Promise<string | null> => {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        accessToken = null;
        return null;
      }
      const data = (await res.json()) as { accessToken?: unknown };
      accessToken = typeof data.accessToken === 'string' ? data.accessToken : null;
      return accessToken;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** Attempt a cookie refresh (used on app start). Returns true on success. */
export async function tryRefresh(): Promise<boolean> {
  return (await doRefresh()) !== null;
}

// ---------------------------------------------------------------------------
// Core fetch
// ---------------------------------------------------------------------------

interface FetchOptions {
  method?: string;
  body?: unknown;
  /** Send the Authorization header. Defaults to true for /api calls. */
  auth?: boolean;
}

async function fetchOnce<T>(path: string, options: FetchOptions): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.auth !== false && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const res = await fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'include',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(body, `Request failed (${res.status}).`));
  }
  return body as T;
}

function tokenScope(token: string | null): string | null {
  if (!token) return null;
  try {
    const encoded = token.split('.')[1];
    const claims = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as {
      sub?: string;
      tenantId?: string;
    };
    return typeof claims.sub === 'string'
      ? JSON.stringify([claims.sub, claims.tenantId ?? null])
      : null;
  } catch {
    return null;
  }
}

export async function apiFetch<T>(path: string, options: FetchOptions = {}): Promise<T> {
  const originalScope = tokenScope(accessToken);
  try {
    return await fetchOnce<T>(path, options);
  } catch (err) {
    // One refresh + retry for authenticated calls that hit an expired token.
    if (err instanceof ApiError && err.status === 401 && options.auth !== false) {
      const refreshed = await doRefresh();
      if (!refreshed) throw new UnauthorizedError();
      if (originalScope && tokenScope(accessToken) !== originalScope) {
        accessToken = null;
        clearTenantCaches();
        throw new UnauthorizedError(
          'The active account or tenant changed in another tab. Reload before continuing.',
        );
      }
      try {
        return await fetchOnce<T>(path, options);
      } catch (retryErr) {
        if (retryErr instanceof ApiError && retryErr.status === 401) {
          throw new UnauthorizedError();
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Types (mirror the API contract)
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
}

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Membership {
  tenantId: string;
  branchIds: string[];
  role: string;
  permissions: string[];
  tenantName?: string | null;
  branches?: Array<{ id: string; name: string }>;
}

export interface TenantContext {
  userId: string;
  tenantId: string;
  branchIds: string[];
  role: string;
  permissions: string[];
  entitlements: unknown[];
  tenantName?: string | null;
}

export interface MeResponse {
  user: User;
  memberships: Membership[];
  tenantContext: TenantContext | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken?: string;
}

export interface RegisterResponse {
  user: User;
  tenant: { id: string; name: string };
  branch: { id: string; name: string };
  tokens: TokenPair;
}

export interface TenantChoice {
  tenantId: string;
  role: string;
  name?: string;
}

export interface LoginResponse {
  user: User;
  tenantId: string | null;
  tokens: TokenPair | null;
  requiresTenantSelection?: boolean;
  tenants?: TenantChoice[];
}

export interface SelectTenantResponse {
  tokens: TokenPair;
  tenantContext: TenantContext;
}

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  createdAt: string;
}

export interface Device {
  id: string;
  brand: string;
  model: string;
  serial: string | null;
  createdAt: string;
}

export interface CustomerDetail {
  customer: Customer;
  devices: Device[];
  repairs: RepairOrder[];
}

export interface RepairOrder {
  id: string;
  tenantId: string;
  branchId: string;
  customerId: string;
  deviceId: string;
  status: string;
  problemDescription?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RepairEvent {
  id: string;
  orderId: string;
  actorId: string;
  fromStatus: string | null;
  toStatus: string;
  note?: string | null;
  createdAt: string;
}

export interface RepairDetail {
  order: RepairOrder;
  customer: Customer;
  device: Device;
  branch: { id: string; name: string };
  events: RepairEvent[];
  assignedTechnician: { id: string; name?: string | null; email?: string | null } | null;
}

export interface Technician {
  id: string;
  name: string | null;
  email: string;
}

export interface Receipt {
  order: RepairOrder;
  customer: Customer;
  device: Device;
  branch: { id: string; name: string };
  tenant: { id: string; name: string };
  events: RepairEvent[];
  issuedAt: string;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Part {
  id: string;
  sku: string;
  name: string;
  createdAt: string;
}

export interface PartStock {
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  reservedQty: number;
  available: number;
}

export interface PartDetail extends Part {
  stock: PartStock[];
}

export interface StockRow {
  partId: string;
  partSku: string;
  partName: string;
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  reservedQty: number;
  available: number;
}

export interface StockMovement {
  id: string;
  partId: string;
  partSku: string;
  partName: string;
  branchId: string;
  branchName: string;
  qty: number;
  reason: string;
  createdAt: string;
  /** Traceability: direct references to the repair/line/operation that caused this movement. */
  repairOrderId?: string | null;
  repairPartId?: string | null;
  operationKey?: string | null;
  actorId?: string | null;
  actorName?: string | null;
}

export type RepairPartStatus = 'reserved' | 'consumed' | 'released';

export interface RepairPartLine {
  id: string;
  orderId: string;
  partId: string;
  partSku: string;
  partName: string;
  qty: number;
  status: RepairPartStatus;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Reports & team (read-only)
// ---------------------------------------------------------------------------

export type AgingBucket = '0-1d' | '2-7d' | '8-30d' | '30d+';

export interface RepairsSummary {
  total: number;
  byStatus: Array<{ status: string; count: number }>;
  aging: Array<{ bucket: AgingBucket; count: number }>;
  /** Server time the summary was read at — one snapshot, not wall-clock. */
  snapshotAt: string;
}

export interface StockReportRow {
  partId: string;
  partSku: string;
  partName: string;
  branchId: string;
  branchName: string;
  qtyOnHand: number;
  reservedQty: number;
  available: number;
  reservedLinesTotal: number;
  discrepancy: number;
  reconciled: boolean;
}

export interface StockSummary {
  totalParts: number;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  mismatchedRows: number;
}

/** Stock overview: summary + one page of rows from a single snapshot. */
export interface StockOverview {
  summary: StockSummary;
  items: StockReportRow[];
  nextCursor: string | null;
  snapshotAt: string;
}

export interface TeamMember {
  userId: string;
  name: string | null;
  email: string;
  role: string;
  branchIds: string[];
  branchNames: string[];
}

export interface TeamResponse {
  branches: Array<{ id: string; name: string }>;
  members: TeamMember[];
}

/**
 * Fresh idempotency key per reserve/release/consume/adjust submission.
 * Prefers crypto.randomUUID; falls back to a random token where the
 * Web Crypto API is unavailable (e.g. some test environments).
 */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `ff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function fetchHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/health', { auth: false });
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const res = await apiFetch<LoginResponse>('/auth/login', {
    method: 'POST',
    auth: false,
    body: { email, password },
  });
  if (res.tokens?.accessToken) setAccessToken(res.tokens.accessToken);
  return res;
}

export async function register(input: {
  email: string;
  password: string;
  name?: string;
  tenantName: string;
  branchName: string;
}): Promise<RegisterResponse> {
  const res = await apiFetch<RegisterResponse>('/auth/register', {
    method: 'POST',
    auth: false,
    body: input,
  });
  if (res.tokens?.accessToken) setAccessToken(res.tokens.accessToken);
  return res;
}

export async function selectTenant(tenantId: string): Promise<SelectTenantResponse> {
  const res = await apiFetch<SelectTenantResponse>('/auth/select-tenant', {
    method: 'POST',
    body: { tenantId },
  });
  if (res.tokens?.accessToken) setAccessToken(res.tokens.accessToken);
  return res;
}

export async function logout(): Promise<void> {
  try {
    await apiFetch<{ ok: boolean }>('/auth/logout', { method: 'POST', auth: false });
  } finally {
    setAccessToken(null);
    clearTenantCaches();
  }
}

export async function logoutAll(): Promise<void> {
  await apiFetch<{ ok: boolean }>('/auth/logout-all', { method: 'POST' });
  setAccessToken(null);
  clearTenantCaches();
}

export async function fetchMe(): Promise<MeResponse> {
  return apiFetch<MeResponse>('/auth/me');
}

// ---------------------------------------------------------------------------
// Customers & devices
// ---------------------------------------------------------------------------

export async function listCustomers(params: {
  search?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PageResult<Customer>> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return apiFetch<PageResult<Customer>>(`/customers${suffix ? `?${suffix}` : ''}`);
}

export async function createCustomer(input: { name: string; phone?: string }): Promise<Customer> {
  return apiFetch<Customer>('/customers', { method: 'POST', body: input });
}

export async function getCustomer(id: string): Promise<CustomerDetail> {
  const data = await apiFetch<Customer & { devices: Device[]; repairs: RepairOrder[] }>(
    `/customers/${id}`,
  );
  const { devices, repairs, ...customer } = data;
  return { customer, devices, repairs };
}

export async function createDevice(
  customerId: string,
  input: { brand: string; model: string; serial?: string },
): Promise<Device> {
  return apiFetch<Device>(`/customers/${customerId}/devices`, { method: 'POST', body: input });
}

// ---------------------------------------------------------------------------
// Repairs
// ---------------------------------------------------------------------------

export async function listRepairs(params: {
  status?: string;
  branchId?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PageResult<RepairOrder>> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.branchId) query.set('branchId', params.branchId);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return apiFetch<PageResult<RepairOrder>>(`/repairs${suffix ? `?${suffix}` : ''}`);
}

export async function createRepair(input: {
  customerId: string;
  deviceId: string;
  branchId: string;
  problemDescription: string;
}): Promise<RepairOrder> {
  return apiFetch<RepairOrder>('/repairs', { method: 'POST', body: input });
}

export async function getRepair(id: string): Promise<RepairDetail> {
  const data = await apiFetch<RepairOrder & Omit<RepairDetail, 'order'>>(`/repairs/${id}`);
  const { customer, device, branch, events, assignedTechnician, ...order } = data;
  return { order, customer, device, branch, events, assignedTechnician };
}

export async function assignRepair(
  id: string,
  input: { technicianUserId: string },
): Promise<RepairOrder> {
  return apiFetch<RepairOrder>(`/repairs/${id}/assign`, { method: 'POST', body: input });
}

export async function listTechnicians(branchId: string): Promise<Technician[]> {
  const query = new URLSearchParams({ branchId });
  return apiFetch<Technician[]>(`/repairs/technicians?${query.toString()}`);
}

export async function transitionRepair(
  id: string,
  input: { toStatus: string; expectedVersion: number; note?: string },
): Promise<RepairOrder> {
  return apiFetch<RepairOrder>(`/repairs/${id}/transition`, { method: 'POST', body: input });
}

export async function getReceipt(id: string): Promise<Receipt> {
  return apiFetch<Receipt>(`/repairs/${id}/receipt`);
}

// ---------------------------------------------------------------------------
// Parts & stock
// ---------------------------------------------------------------------------

export async function listParts(params: {
  search?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PageResult<Part>> {
  const query = new URLSearchParams();
  if (params.search) query.set('search', params.search);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return apiFetch<PageResult<Part>>(`/parts${suffix ? `?${suffix}` : ''}`);
}

export async function createPart(input: { sku: string; name: string }): Promise<Part> {
  return apiFetch<Part>('/parts', { method: 'POST', body: input });
}

export async function getPart(id: string): Promise<PartDetail> {
  return apiFetch<PartDetail>(`/parts/${id}`);
}

export async function listStock(params: {
  branchId?: string;
  partId?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PageResult<StockRow>> {
  const query = new URLSearchParams();
  if (params.branchId) query.set('branchId', params.branchId);
  if (params.partId) query.set('partId', params.partId);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return apiFetch<PageResult<StockRow>>(`/stock${suffix ? `?${suffix}` : ''}`);
}

/** Retain an operation key across an uncertain network failure. Clear only after
 * a confirmed response, never silently turn a retry into a second stock write.
 * Pending operations are in-memory only and are cleared on tenant/session exit.
 * A durable record (localStorage, tenant-scoped, no tokens or bodies) is also
 * written before the request so a page reload can reconcile the outcome
 * against the movements ledger; see pendingOps.ts. */
const pendingStockKeys = new Map<string, string>();
async function stockWrite<T>(
  path: string,
  input: Record<string, unknown> & { idempotencyKey: string },
  pending: { kind: PendingOpKind; repairOrderId: string | null },
): Promise<T> {
  const { idempotencyKey, ...request } = input;
  // Capture the originating user+tenant up front: cleanup must target
  // the scope that recorded the op, not whichever scope is selected
  // when the response arrives.
  const tenantId = getPendingTenant();
  const userId = getPendingUser();
  const fingerprint = `${userId ?? ''}:${tenantId ?? ''}:${path}:${JSON.stringify(request)}`;
  const retryKey = pendingStockKeys.get(fingerprint);
  if (tenantId && !retryKey && loadPendingOps(tenantId, userId).length > 0) {
    throw new ApiError(
      409,
      'An earlier stock change has an uncertain outcome. Reload and check the pending-operation notice before making another stock change.',
    );
  }
  const key = retryKey ?? idempotencyKey;
  pendingStockKeys.set(fingerprint, key);
  recordPendingOp({ operationKey: key, kind: pending.kind, repairOrderId: pending.repairOrderId });
  try {
    const result = await apiFetch<T>(path, {
      method: 'POST',
      body: { ...request, idempotencyKey: key },
    });
    pendingStockKeys.delete(fingerprint);
    if (tenantId) removePendingOp(tenantId, key, userId);
    // Tell other tabs a stock write completed (timestamp only, no
    // business payload) so they invalidate their stock/repair queries.
    if (tenantId) broadcastStockChanged(tenantId);
    return result;
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      // Definitive client error: the write did not happen; drop both records.
      pendingStockKeys.delete(fingerprint);
      if (tenantId) removePendingOp(tenantId, key, userId);
    }
    // Network errors and 5xx keep both records: the outcome is uncertain
    // and reconciliation must check the ledger before any re-entry.
    throw error;
  }
}

export async function adjustStock(input: {
  branchId: string;
  partId: string;
  delta: number;
  reason?: string;
  idempotencyKey: string;
}): Promise<StockRow> {
  return stockWrite<StockRow>('/stock/adjust', input, {
    kind: 'adjust',
    repairOrderId: null,
  });
}

export async function listMovements(params: {
  branchId?: string;
  partId?: string;
  operationKey?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<PageResult<StockMovement>> {
  const query = new URLSearchParams();
  if (params.branchId) query.set('branchId', params.branchId);
  if (params.partId) query.set('partId', params.partId);
  if (params.operationKey) query.set('operationKey', params.operationKey);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return apiFetch<PageResult<StockMovement>>(`/stock/movements${suffix ? `?${suffix}` : ''}`);
}

/** Movements for one operation key — used to reconcile a pending stock write. */
export async function fetchMovementsByOperationKey(
  operationKey: string,
): Promise<PageResult<StockMovement>> {
  return listMovements({ operationKey });
}

export async function listRepairParts(repairId: string): Promise<PageResult<RepairPartLine>> {
  const items = await apiFetch<RepairPartLine[]>(`/repairs/${repairId}/parts`);
  return { items, nextCursor: null };
}

export async function reservePart(
  repairId: string,
  input: { partId: string; qty: number; idempotencyKey: string },
): Promise<RepairPartLine> {
  return stockWrite<RepairPartLine>(`/repairs/${repairId}/parts`, input, {
    kind: 'reserve',
    repairOrderId: repairId,
  });
}

export async function releasePart(
  repairId: string,
  lineId: string,
  input: { idempotencyKey: string },
): Promise<RepairPartLine> {
  return stockWrite<RepairPartLine>(`/repairs/${repairId}/parts/${lineId}/release`, input, {
    kind: 'release',
    repairOrderId: repairId,
  });
}

export async function consumePart(
  repairId: string,
  lineId: string,
  input: { idempotencyKey: string },
): Promise<RepairPartLine> {
  return stockWrite<RepairPartLine>(`/repairs/${repairId}/parts/${lineId}/consume`, input, {
    kind: 'consume',
    repairOrderId: repairId,
  });
}

// ---------------------------------------------------------------------------
// Reports & team
// ---------------------------------------------------------------------------

export async function fetchRepairsSummary(params: {
  status?: string;
  branchId?: string;
  from?: string;
  to?: string;
}): Promise<RepairsSummary> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.branchId) query.set('branchId', params.branchId);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  const suffix = query.toString();
  return apiFetch<RepairsSummary>(`/reports/repairs/summary${suffix ? `?${suffix}` : ''}`);
}

export async function fetchStockOverview(params: {
  partId?: string;
  branchId?: string;
  cursor?: string | null;
  limit?: number;
}): Promise<StockOverview> {
  const query = new URLSearchParams();
  if (params.partId) query.set('partId', params.partId);
  if (params.branchId) query.set('branchId', params.branchId);
  if (params.cursor) query.set('cursor', params.cursor);
  if (params.limit) query.set('limit', String(params.limit));
  const suffix = query.toString();
  return apiFetch<StockOverview>(`/reports/stock/overview${suffix ? `?${suffix}` : ''}`);
}

export async function fetchTeam(): Promise<TeamResponse> {
  return apiFetch<TeamResponse>('/admin/team');
}

// ---------------------------------------------------------------------------
// Public profile (Phase 10) — per-tenant landing page.
// The settings endpoints are owner-only; the public read is
// unauthenticated (auth: false) and returns only the eight public
// fields. The client never invents profile content: empty fields
// stay empty and are omitted by the view.
// ---------------------------------------------------------------------------

export type PublicProfileTheme = 'green' | 'gold' | 'teal' | 'slate';

export interface PublicProfileServiceItem {
  name: string;
  description?: string | null;
}

export interface PublicProfileContact {
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  address?: string | null;
  website?: string | null;
}

export interface PublicProfileHoursDay {
  open: string;
  close: string;
}

export interface PublicProfileHours {
  sat?: PublicProfileHoursDay | null;
  sun?: PublicProfileHoursDay | null;
  mon?: PublicProfileHoursDay | null;
  tue?: PublicProfileHoursDay | null;
  wed?: PublicProfileHoursDay | null;
  thu?: PublicProfileHoursDay | null;
  fri?: PublicProfileHoursDay | null;
}

/** The eight fields the public endpoint may ever return. */
export interface PublicShop {
  slug: string;
  displayName: string | null;
  description: string | null;
  logoUrl: string | null;
  theme: PublicProfileTheme;
  services: PublicProfileServiceItem[] | null;
  contact: PublicProfileContact | null;
  hours: PublicProfileHours | null;
}

export interface PublicProfileSettings extends PublicShop {
  published: boolean;
  updatedAt: string;
}

export interface SavePublicProfileInput {
  slug: string;
  displayName?: string;
  description?: string;
  logoUrl?: string;
  theme?: PublicProfileTheme;
  services?: PublicProfileServiceItem[];
  contact?: PublicProfileContact;
  hours?: PublicProfileHours;
  published?: boolean;
}

export async function fetchOwnPublicProfile(): Promise<PublicProfileSettings> {
  return apiFetch<PublicProfileSettings>('/tenants/me/public-profile');
}

export async function saveOwnPublicProfile(
  input: SavePublicProfileInput,
): Promise<PublicProfileSettings> {
  return apiFetch<PublicProfileSettings>('/tenants/me/public-profile', {
    method: 'PUT',
    body: input,
  });
}

/** Unauthenticated public read — no token is sent (auth: false). */
export async function fetchPublicShop(slug: string): Promise<PublicShop> {
  return apiFetch<PublicShop>(`/public/shops/${encodeURIComponent(slug)}`, { auth: false });
}
