import { add, formatMoney, mul, sub } from './money';

describe('money (decimal-safe)', () => {
  it('0.1 + 0.2 = 0.3, not 0.30000000000000004', () => {
    expect(add('0.1', '0.2')).toBe('0.3');
    expect(sub('0.3', '0.1')).toBe('0.2');
    expect(mul('0.1', '3')).toBe('0.3');
    expect(formatMoney('12.5', 'SAR')).toBe('12.50 SAR');
  });
});
