/**
 * Repair state machine — pure logic, unit-tested in repair-status.spec.ts.
 * The database enum (RepairStatus) carries the same values; this module
 * is the single source of truth for which transitions are legal.
 * History is append-only: every transition writes a RepairEvent, and
 * transitions never delete or rewrite earlier events.
 */
export const REPAIR_STATUSES = [
  'received',
  'diagnosing',
  'awaiting_approval',
  'awaiting_parts',
  'in_repair',
  'quality_check',
  'ready',
  'delivered',
  'cancelled',
  'unrepairable',
] as const;

export type RepairStatusValue = (typeof REPAIR_STATUSES)[number];

export const ALLOWED_TRANSITIONS: Record<RepairStatusValue, RepairStatusValue[]> = {
  received: ['diagnosing', 'cancelled'],
  diagnosing: ['awaiting_approval', 'awaiting_parts', 'in_repair', 'unrepairable', 'cancelled'],
  awaiting_approval: ['in_repair', 'cancelled'],
  awaiting_parts: ['in_repair', 'cancelled'],
  in_repair: ['quality_check', 'unrepairable', 'cancelled'],
  quality_check: ['ready', 'in_repair', 'unrepairable'],
  ready: ['delivered'],
  delivered: [],
  cancelled: [],
  unrepairable: [],
};

export function canTransition(from: RepairStatusValue, to: RepairStatusValue): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isTerminal(status: RepairStatusValue): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}
