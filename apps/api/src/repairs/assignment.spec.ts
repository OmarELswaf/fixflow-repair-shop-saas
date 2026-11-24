import { canAssignTechnician } from './assignment';

describe('canAssignTechnician', () => {
  const memberships = [
    { tenantId: 'a', role: 'technician', branchIds: ['ba'] },
    { tenantId: 'a', role: 'manager', branchIds: ['ba', 'bb'] },
    { tenantId: 'b', role: 'technician', branchIds: ['bb'] },
  ];

  it('allows a technician in the tenant and branch', () => {
    expect(canAssignTechnician(memberships, 'a', 'ba')).toBe(true);
  });

  it('rejects a technician scoped to a different branch', () => {
    expect(canAssignTechnician(memberships, 'a', 'bb')).toBe(false);
  });

  it('rejects a technician from a different tenant', () => {
    expect(canAssignTechnician(memberships, 'b', 'ba')).toBe(false);
  });

  it('rejects a non-technician role even in the right tenant and branch', () => {
    expect(
      canAssignTechnician([{ tenantId: 'a', role: 'manager', branchIds: ['ba'] }], 'a', 'ba'),
    ).toBe(false);
  });

  it('rejects when there are no memberships', () => {
    expect(canAssignTechnician([], 'a', 'ba')).toBe(false);
  });
});
