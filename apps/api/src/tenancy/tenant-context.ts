export interface Entitlement {
  feature: string;
  limitValue: number | null;
  planVersionId: string;
}

export interface TenantContext {
  userId: string;
  tenantId: string;
  branchIds: string[];
  role: string;
  permissions: string[];
  entitlements: Entitlement[];
  /** Display name only; the guard-built context leaves it undefined. */
  tenantName?: string | null;
}

export interface Membership {
  tenantId: string;
  branchIds: string[];
  role: string;
  permissions: string[];
  entitlements: Entitlement[];
}

export interface AuthenticatedUser {
  id: string;
  memberships: Membership[];
}

/**
 * Resolve TenantContext from authenticated memberships only.
 * There is deliberately NO client-supplied tenant_id parameter:
 * any tenant id sent by a client is ignored by construction.
 */
export function resolveTenantContext(
  user: AuthenticatedUser,
  requestedTenantId?: string,
): TenantContext {
  const requested =
    requestedTenantId !== undefined
      ? user.memberships.find((m) => m.tenantId === requestedTenantId)
      : undefined;
  // A requested tenant the user is not a member of is IGNORED:
  // fall back to the user's actual first membership, never to the
  // client-supplied value.
  const chosen = requested ?? user.memberships[0];
  if (!chosen) {
    throw new Error('No membership for the authenticated user.');
  }
  return {
    userId: user.id,
    tenantId: chosen.tenantId,
    branchIds: chosen.branchIds,
    role: chosen.role,
    permissions: chosen.permissions,
    entitlements: chosen.entitlements,
  };
}
