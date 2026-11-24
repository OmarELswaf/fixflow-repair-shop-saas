import {
  ALLOWED_TRANSITIONS,
  REPAIR_STATUSES,
  canTransition,
  isTerminal,
  type RepairStatusValue,
} from './repair-status';

const EXPECTED: Record<RepairStatusValue, RepairStatusValue[]> = {
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

describe('repair state machine', () => {
  it('matches the specified transition table exactly', () => {
    expect(ALLOWED_TRANSITIONS).toEqual(EXPECTED);
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...REPAIR_STATUSES].sort());
  });

  it('allows the full happy path', () => {
    const path: RepairStatusValue[] = [
      'received',
      'diagnosing',
      'in_repair',
      'quality_check',
      'ready',
      'delivered',
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i], path[i + 1])).toBe(true);
    }
  });

  it('allows quality_check to loop back to in_repair and to unrepairable', () => {
    expect(canTransition('quality_check', 'in_repair')).toBe(true);
    expect(canTransition('quality_check', 'unrepairable')).toBe(true);
    expect(canTransition('quality_check', 'ready')).toBe(true);
  });

  it('allows unrepairable from diagnosing and in_repair', () => {
    expect(canTransition('diagnosing', 'unrepairable')).toBe(true);
    expect(canTransition('in_repair', 'unrepairable')).toBe(true);
  });

  it('rejects illegal transitions', () => {
    expect(canTransition('received', 'ready')).toBe(false);
    expect(canTransition('received', 'delivered')).toBe(false);
    expect(canTransition('received', 'in_repair')).toBe(false);
    expect(canTransition('quality_check', 'delivered')).toBe(false);
    expect(canTransition('quality_check', 'diagnosing')).toBe(false);
    expect(canTransition('ready', 'in_repair')).toBe(false);
    expect(canTransition('awaiting_approval', 'quality_check')).toBe(false);
    expect(canTransition('diagnosing', 'ready')).toBe(false);
  });

  it('rejects every transition out of a terminal status', () => {
    for (const from of ['delivered', 'cancelled', 'unrepairable'] as RepairStatusValue[]) {
      for (const to of REPAIR_STATUSES) {
        expect(canTransition(from, to)).toBe(false);
      }
      expect(isTerminal(from)).toBe(true);
    }
    expect(isTerminal('received')).toBe(false);
    expect(isTerminal('quality_check')).toBe(false);
    expect(isTerminal('ready')).toBe(false);
  });
});
