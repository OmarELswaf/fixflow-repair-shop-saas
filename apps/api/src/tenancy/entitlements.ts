import type { TenantContext } from './tenant-context';

/** Versioned entitlement check: limit is tied to the ctx plan version. */
export function checkEntitlement(
  ctx: TenantContext,
  feature: string,
  usage: number,
): { allowed: boolean; limit: number | null } {
  const entitlement = ctx.entitlements.find((e) => e.feature === feature);
  if (!entitlement) return { allowed: false, limit: null };
  if (entitlement.limitValue === null) return { allowed: true, limit: null };
  return { allowed: usage < entitlement.limitValue, limit: entitlement.limitValue };
}

/**
 * Atomic quota helper (sketch, testable logic): the database must do
 * the check-and-increment in one conditional update, e.g.
 * UPDATE quota_counters SET used = used + 1
 * WHERE tenant_id = $1 AND feature = $2 AND used < $3
 * RETURNING used;
 * If no row is returned, the quota is exhausted. Never check-then-act
 * in application code alone.
 */
export function quotaUpdateWouldExceed(used: number, limit: number | null, increment = 1): boolean {
  if (limit === null) return false;
  return used + increment > limit;
}
