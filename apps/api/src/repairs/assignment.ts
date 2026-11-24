/**
 * Pure technician-assignment rule, unit-tested in assignment.spec.ts.
 * A technician may be assigned only when they hold a membership in the
 * order's tenant with role 'technician' and the order's branch is in
 * that membership's branch scope. The service enforces the same rule
 * against the database; this helper is the testable core of it.
 */
export interface TechnicianMembership {
  tenantId: string;
  role: string;
  branchIds: string[];
}

export function canAssignTechnician(
  technicianMemberships: TechnicianMembership[],
  tenantId: string,
  branchId: string,
): boolean {
  return technicianMemberships.some(
    (m) => m.tenantId === tenantId && m.role === 'technician' && m.branchIds.includes(branchId),
  );
}
