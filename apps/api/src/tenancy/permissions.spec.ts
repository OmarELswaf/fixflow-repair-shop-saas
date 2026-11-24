import { PERMISSIONS, permissionsForRole } from './permissions';

describe('permissionsForRole (least privilege)', () => {
  it('owner has every permission', () => {
    const perms = permissionsForRole('owner');
    expect(perms).toHaveLength(Object.values(PERMISSIONS).length);
    for (const p of Object.values(PERMISSIONS)) expect(perms).toContain(p);
  });

  it('admin has everything except admin, including all stock permissions', () => {
    const perms = permissionsForRole('admin');
    expect(perms).not.toContain(PERMISSIONS.ADMIN);
    for (const p of [
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
    ]) {
      expect(perms).toContain(p);
    }
  });

  it('manager has all stock permissions but cannot refund or administer', () => {
    const perms = permissionsForRole('manager');
    expect(perms).toContain(PERMISSIONS.STOCK_RESERVE);
    expect(perms).toContain(PERMISSIONS.STOCK_RELEASE);
    expect(perms).toContain(PERMISSIONS.STOCK_CONSUME);
    expect(perms).not.toContain(PERMISSIONS.PAYMENT_REFUND);
    expect(perms).not.toContain(PERMISSIONS.ADMIN);
  });

  it('technician can consume stock only, never reserve or release', () => {
    const perms = permissionsForRole('technician');
    expect(perms).toContain(PERMISSIONS.STOCK_CONSUME);
    expect(perms).toContain(PERMISSIONS.INVENTORY_READ);
    expect(perms).not.toContain(PERMISSIONS.STOCK_RESERVE);
    expect(perms).not.toContain(PERMISSIONS.STOCK_RELEASE);
    expect(perms).not.toContain(PERMISSIONS.INVENTORY_WRITE);
  });

  it('receptionist and accountant can read inventory but hold no stock permissions', () => {
    for (const role of ['receptionist', 'accountant']) {
      const perms = permissionsForRole(role);
      expect(perms).toContain(PERMISSIONS.INVENTORY_READ);
      expect(perms).not.toContain(PERMISSIONS.STOCK_RESERVE);
      expect(perms).not.toContain(PERMISSIONS.STOCK_RELEASE);
      expect(perms).not.toContain(PERMISSIONS.STOCK_CONSUME);
      expect(perms).not.toContain(PERMISSIONS.INVENTORY_WRITE);
    }
  });

  it('manager can assign and transition but cannot refund or administer', () => {
    const perms = permissionsForRole('manager');
    expect(perms).toContain(PERMISSIONS.REPAIR_ASSIGN);
    expect(perms).toContain(PERMISSIONS.REPAIR_TRANSITION);
    expect(perms).toContain(PERMISSIONS.CUSTOMER_WRITE);
    expect(perms).toContain(PERMISSIONS.DEVICE_WRITE);
    expect(perms).not.toContain(PERMISSIONS.PAYMENT_REFUND);
    expect(perms).not.toContain(PERMISSIONS.ADMIN);
  });

  it('technician can transition only assigned work and cannot assign or approve', () => {
    const perms = permissionsForRole('technician');
    expect(perms).toContain(PERMISSIONS.REPAIR_TRANSITION);
    expect(perms).toContain(PERMISSIONS.CUSTOMER_READ);
    expect(perms).toContain(PERMISSIONS.DEVICE_READ);
    expect(perms).not.toContain(PERMISSIONS.REPAIR_ASSIGN);
    expect(perms).not.toContain(PERMISSIONS.REPAIR_APPROVE);
    expect(perms).not.toContain(PERMISSIONS.CUSTOMER_WRITE);
    expect(perms).not.toContain(PERMISSIONS.DEVICE_WRITE);
    expect(perms).not.toContain(PERMISSIONS.PAYMENT_CREATE);
  });

  it('receptionist can create customers, devices and repairs but cannot transition or assign', () => {
    const perms = permissionsForRole('receptionist');
    expect(perms).toContain(PERMISSIONS.CUSTOMER_WRITE);
    expect(perms).toContain(PERMISSIONS.DEVICE_WRITE);
    expect(perms).toContain(PERMISSIONS.REPAIR_WRITE);
    expect(perms).not.toContain(PERMISSIONS.REPAIR_TRANSITION);
    expect(perms).not.toContain(PERMISSIONS.REPAIR_ASSIGN);
    expect(perms).not.toContain(PERMISSIONS.PAYMENT_CREATE);
    expect(perms).not.toContain(PERMISSIONS.REPORT_READ);
  });

  it('accountant can read reports and take payments but cannot write repairs or customers', () => {
    const perms = permissionsForRole('accountant');
    expect(perms).toContain(PERMISSIONS.REPORT_READ);
    expect(perms).toContain(PERMISSIONS.PAYMENT_CREATE);
    expect(perms).toContain(PERMISSIONS.PAYMENT_REFUND);
    expect(perms).toContain(PERMISSIONS.REPAIR_READ);
    expect(perms).toContain(PERMISSIONS.CUSTOMER_READ);
    expect(perms).not.toContain(PERMISSIONS.REPAIR_WRITE);
    expect(perms).not.toContain(PERMISSIONS.REPAIR_TRANSITION);
    expect(perms).not.toContain(PERMISSIONS.CUSTOMER_WRITE);
    expect(perms).not.toContain(PERMISSIONS.DEVICE_WRITE);
  });

  it('cashier keeps its narrow scope and unknown roles get nothing', () => {
    const perms = permissionsForRole('cashier');
    expect(perms).toEqual([
      PERMISSIONS.REPAIR_READ,
      PERMISSIONS.PAYMENT_CREATE,
      PERMISSIONS.PAYMENT_REFUND,
    ]);
    expect(permissionsForRole('nobody')).toEqual([]);
  });
});
