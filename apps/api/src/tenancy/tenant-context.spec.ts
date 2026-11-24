import { checkEntitlement, quotaUpdateWouldExceed } from './entitlements';
import { canAccessBranch, hasPermission, PERMISSIONS } from './permissions';
import { resolveTenantContext, type AuthenticatedUser, type TenantContext } from './tenant-context';

function makeUser(): AuthenticatedUser {
  return {
    id: 'user-1',
    memberships: [
      {
        tenantId: 'tenant-a',
        branchIds: ['branch-1'],
        role: 'technician',
        permissions: [PERMISSIONS.REPAIR_READ],
        entitlements: [{ feature: 'repairs', limitValue: 10, planVersionId: 'plan-v1' }],
      },
    ],
  };
}

describe('resolveTenantContext', () => {
  it('ignores a client-supplied tenant_id the user is not a member of', () => {
    const ctx = resolveTenantContext(makeUser(), 'tenant-b');
    // Falls back to the authenticated membership, never the spoofed one.
    expect(ctx.tenantId).toBe('tenant-a');
  });

  it('resolves the requested tenant only when the user is a member', () => {
    const user = makeUser();
    user.memberships.push({
      tenantId: 'tenant-b',
      branchIds: ['branch-9'],
      role: 'admin',
      permissions: [PERMISSIONS.ADMIN],
      entitlements: [],
    });
    const ctx = resolveTenantContext(user, 'tenant-b');
    expect(ctx.tenantId).toBe('tenant-b');
  });
});

describe('permissions and branches', () => {
  const ctx: TenantContext = {
    userId: 'user-1',
    tenantId: 'tenant-a',
    branchIds: ['branch-1'],
    role: 'technician',
    permissions: [PERMISSIONS.REPAIR_READ],
    entitlements: [],
  };
  it('denies a branch outside scope', () => {
    expect(canAccessBranch(ctx, 'branch-2')).toBe(false);
    expect(canAccessBranch(ctx, 'branch-1')).toBe(true);
  });
  it('denies a missing permission', () => {
    expect(hasPermission(ctx, PERMISSIONS.REPAIR_WRITE)).toBe(false);
    expect(hasPermission(ctx, PERMISSIONS.REPAIR_READ)).toBe(true);
  });
});

describe('entitlements', () => {
  const ctx: TenantContext = {
    userId: 'user-1',
    tenantId: 'tenant-a',
    branchIds: ['branch-1'],
    role: 'technician',
    permissions: [],
    entitlements: [{ feature: 'repairs', limitValue: 10, planVersionId: 'plan-v1' }],
  };
  it('enforces the limit', () => {
    expect(checkEntitlement(ctx, 'repairs', 9).allowed).toBe(true);
    expect(checkEntitlement(ctx, 'repairs', 10).allowed).toBe(false);
    expect(checkEntitlement(ctx, 'unknown', 0).allowed).toBe(false);
    expect(quotaUpdateWouldExceed(10, 10)).toBe(true);
    expect(quotaUpdateWouldExceed(9, 10)).toBe(false);
    expect(quotaUpdateWouldExceed(999, null)).toBe(false);
  });
});
