import { describe, expect, it } from 'vitest';
import { formatDate, formatTime, wallTimeToUtc } from './format-date-time';

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

describe('wallTimeToUtc', () => {
  it('reads the value in the given time zone', () => {
    expect(wallTimeToUtc('2026-11-11T10:30', 'Europe/Madrid')).toBe('2026-11-11T09:30:00.000Z');
    expect(wallTimeToUtc('2026-11-11T10:30', 'UTC')).toBe('2026-11-11T10:30:00.000Z');
  });

  it('applies summer time', () => {
    expect(wallTimeToUtc('2026-07-01T10:30', 'Europe/Madrid')).toBe('2026-07-01T08:30:00.000Z');
  });

  it('returns null for a time the DST change skips', () => {
    expect(wallTimeToUtc('2026-03-29T02:30', 'Europe/Madrid')).toBeNull();
  });

  it('takes the earlier instant for a time that happens twice', () => {
    expect(wallTimeToUtc('2026-10-25T02:30', 'Europe/Madrid')).toBe('2026-10-25T00:30:00.000Z');
  });

  it('returns null for a value that is not YYYY-MM-DDTHH:mm', () => {
    expect(wallTimeToUtc('', 'Europe/Madrid')).toBeNull();
    expect(wallTimeToUtc('2026-11-11', 'Europe/Madrid')).toBeNull();
  });
});
