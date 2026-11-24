import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DateTime from './DateTime';
import { LanguageContext } from '../i18n';

describe('DateTime', () => {
  it('formats Arabic dates without exposing raw ISO text and isolates bidi', () => {
    const { container } = render(
      <LanguageContext.Provider value="ar">
        <DateTime value="2026-11-24T07:39:43.976Z" />
      </LanguageContext.Provider>,
    );
    const time = container.querySelector('time');
    expect(time?.getAttribute('dir')).toBe('rtl');
    expect(time?.getAttribute('datetime')).toBe('2026-11-24T07:39:43.976Z');
    expect(time?.style.unicodeBidi).toBe('isolate');
    expect(time?.textContent).not.toContain('T07:');
    expect(time?.textContent).toContain('نوفمبر');
  });
  it('handles invalid values without throwing', () => {
    render(<DateTime value="invalid" />);
    expect(screen.getByText('—')).toBeTruthy();
  });
});
