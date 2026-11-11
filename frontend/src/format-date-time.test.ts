import { describe, expect, it } from 'vitest';
import { formatDate, formatTime } from './format-date-time';

describe('formatDate and formatTime', () => {
  it('formats in the business time zone', () => {
    expect(formatDate('2026-11-10T12:00:00Z', 'Europe/Madrid')).toBe('Tuesday, 10 November 2026');
    expect(formatTime('2026-11-10T12:00:00Z', 'Europe/Madrid')).toBe('13:00');
  });

  it('applies summer time after the DST change', () => {
    expect(formatTime('2026-03-29T09:30:00Z', 'Europe/Madrid')).toBe('11:30');
  });

  it('uses the business date, not the UTC date', () => {
    expect(formatDate('2026-11-10T23:30:00Z', 'Europe/Madrid')).toBe('Wednesday, 11 November 2026');
    expect(formatTime('2026-11-10T23:30:00Z', 'Europe/Madrid')).toBe('00:30');
  });
});
