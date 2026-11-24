import type { TenantContext } from './tenant-context';

export const PERMISSIONS = {
  REPAIR_READ: 'repair:read',
  REPAIR_WRITE: 'repair:write',
  REPAIR_APPROVE: 'repair:approve',
  REPAIR_ASSIGN: 'repair:assign',
  REPAIR_TRANSITION: 'repair:transition',
  CUSTOMER_READ: 'customer:read',
  CUSTOMER_WRITE: 'customer:write',
  DEVICE_READ: 'device:read',
  DEVICE_WRITE: 'device:write',
  INVENTORY_READ: 'inventory:read',
  INVENTORY_WRITE: 'inventory:write',
  STOCK_RESERVE: 'stock:reserve',
  STOCK_RELEASE: 'stock:release',
  STOCK_CONSUME: 'stock:consume',
  PAYMENT_CREATE: 'payment:create',
  PAYMENT_REFUND: 'payment:refund',
  REPORT_READ: 'report:read',
  ADMIN: 'admin',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * Permissions granted by membership role. Owner gets everything;
 * other roles get the subset they need. This map is the Phase 3
 * source of truth for permissions — RolePermission rows (docs) are
 * the future per-role override store, not the live check.
 */
export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: Object.values(PERMISSIONS),
  admin: [
    PERMISSIONS.REPAIR_READ,
    PERMISSIONS.REPAIR_WRITE,
    PERMISSIONS.REPAIR_APPROVE,
    PERMISSIONS.REPAIR_ASSIGN,
    PERMISSIONS.REPAIR_TRANSITION,
    PERMISSIONS.CUSTOMER_READ,
    PERMISSIONS.CUSTOMER_WRITE,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_WRITE,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_WRITE,
    PERMISSIONS.STOCK_RESERVE,
    PERMISSIONS.STOCK_RELEASE,
    PERMISSIONS.STOCK_CONSUME,
    PERMISSIONS.PAYMENT_CREATE,
    PERMISSIONS.PAYMENT_REFUND,
    PERMISSIONS.REPORT_READ,
  ],
  manager: [
    PERMISSIONS.REPAIR_READ,
    PERMISSIONS.REPAIR_WRITE,
    PERMISSIONS.REPAIR_ASSIGN,
    PERMISSIONS.REPAIR_TRANSITION,
    PERMISSIONS.REPAIR_APPROVE,
    PERMISSIONS.CUSTOMER_READ,
    PERMISSIONS.CUSTOMER_WRITE,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_WRITE,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_WRITE,
    PERMISSIONS.STOCK_RESERVE,
    PERMISSIONS.STOCK_RELEASE,
    PERMISSIONS.STOCK_CONSUME,
    PERMISSIONS.PAYMENT_CREATE,
    PERMISSIONS.REPORT_READ,
  ],
  technician: [
    PERMISSIONS.REPAIR_READ,
    PERMISSIONS.REPAIR_WRITE,
    PERMISSIONS.REPAIR_TRANSITION,
    PERMISSIONS.STOCK_CONSUME,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.CUSTOMER_READ,
    PERMISSIONS.DEVICE_READ,
  ],
  cashier: [PERMISSIONS.REPAIR_READ, PERMISSIONS.PAYMENT_CREATE, PERMISSIONS.PAYMENT_REFUND],
  receptionist: [
    PERMISSIONS.CUSTOMER_READ,
    PERMISSIONS.CUSTOMER_WRITE,
    PERMISSIONS.DEVICE_READ,
    PERMISSIONS.DEVICE_WRITE,
    PERMISSIONS.REPAIR_READ,
    PERMISSIONS.REPAIR_WRITE,
    PERMISSIONS.INVENTORY_READ,
  ],
  accountant: [
    PERMISSIONS.REPORT_READ,
    PERMISSIONS.PAYMENT_CREATE,
    PERMISSIONS.PAYMENT_REFUND,
    PERMISSIONS.REPAIR_READ,
    PERMISSIONS.CUSTOMER_READ,
    PERMISSIONS.INVENTORY_READ,
  ],
};

export function permissionsForRole(role: string): string[] {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

export function hasPermission(ctx: TenantContext, perm: string): boolean {
  return ctx.permissions.includes(perm);
}

export function canAccessBranch(ctx: TenantContext, branchId: string): boolean {
  return ctx.branchIds.includes(branchId);
}
