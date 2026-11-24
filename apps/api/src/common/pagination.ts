import type { TenantContext } from '../tenancy/tenant-context';

export interface CursorPaginationInput {
  cursor?: string;
  limit?: number;
}

export interface CursorPagination {
  take: number;
  cursor?: { id: string };
  skip?: number;
  orderBy: Array<{ createdAt: 'desc' } | { id: 'desc' }>;
}

/**
 * Indexed, tenant-scoped cursor pagination.
 * Ordered by (created_at DESC, id DESC) — a unique indexed key.
 * Limit is capped at 100. Callers must also filter by tenant_id.
 */
export function buildCursorPagination(input: CursorPaginationInput): CursorPagination {
  const take = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const orderBy = [{ createdAt: 'desc' } as const, { id: 'desc' } as const];
  if (!input.cursor) return { take, orderBy };
  return { take, cursor: { id: input.cursor }, skip: 1, orderBy };
}

export function requireTenant(ctx: TenantContext): string {
  return ctx.tenantId;
}
