import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { describe, expect, it, afterEach } from 'vitest';
import { RepairStatusChip, PartLineStatusChip } from './StatusChip';
import { LanguageContext } from '../i18n';

describe('StatusChip', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders every repair status as a text label, not colour alone', () => {
    const statuses: Array<[string, string]> = [
      ['received', 'مستلم'],
      ['diagnosing', 'قيد التشخيص'],
      ['awaiting_approval', 'بانتظار الموافقة'],
      ['awaiting_parts', 'بانتظار قطع الغيار'],
      ['in_repair', 'قيد الإصلاح'],
      ['quality_check', 'فحص الجودة'],
      ['ready', 'جاهز'],
      ['delivered', 'تم التسليم'],
      ['cancelled', 'ملغي'],
      ['unrepairable', 'غير قابل للإصلاح'],
    ];
    for (const [status, label] of statuses) {
      render(
        <LanguageContext.Provider value="ar">
          <RepairStatusChip status={status} />
        </LanguageContext.Provider>,
      );
      expect(screen.getByText(label)).toBeInTheDocument();
      cleanup();
    }
  });

  it('renders part-line statuses as text labels', () => {
    render(
      <LanguageContext.Provider value="ar">
        <PartLineStatusChip status="reserved" />
      </LanguageContext.Provider>,
    );
    expect(screen.getByText('محجوزة')).toBeInTheDocument();
    cleanup();
    render(
      <LanguageContext.Provider value="ar">
        <PartLineStatusChip status="consumed" />
      </LanguageContext.Provider>,
    );
    expect(screen.getByText('مستهلكة')).toBeInTheDocument();
  });
});
