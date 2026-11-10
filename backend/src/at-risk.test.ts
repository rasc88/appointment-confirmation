import { describe, expect, it } from 'vitest';
import type { AppointmentStatus } from './generated/prisma/client.js';
import { getAtRiskReasons, isLateCancellation } from './at-risk.js';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const now = new Date('2026-11-10T09:00:00Z');
const settings = { noReplyWindowHours: 24, noShowThreshold: 1, noShowLookbackDays: 180 };

function appointmentAt(startsInMs: number, status: AppointmentStatus = 'pending', id = 'appointment') {
  return { id, status, startsAt: new Date(now.getTime() + startsInMs) };
}

function noShowAt(startsInMs: number, id = `no-show-${startsInMs}`) {
  return appointmentAt(startsInMs, 'no_show', id);
}

describe('getAtRiskReasons: which appointments can be at risk', () => {
  it.each<AppointmentStatus>(['cancelled', 'attended', 'no_show'])(
    'returns [] for %s even when both conditions hold',
    (status) => {
      expect(getAtRiskReasons(appointmentAt(hourMs, status), [noShowAt(-dayMs)], settings, now)).toEqual([]);
    },
  );

  it.each<AppointmentStatus>(['pending', 'confirmed'])('returns [] for %s once startsAt <= now', (status) => {
    const history = [noShowAt(-dayMs)];
    expect(getAtRiskReasons(appointmentAt(0, status), history, settings, now)).toEqual([]);
    expect(getAtRiskReasons(appointmentAt(-hourMs, status), history, settings, now)).toEqual([]);
  });

  it('evaluates reasons when startsAt is 1 ms after now', () => {
    expect(getAtRiskReasons(appointmentAt(1), [], settings, now)).toEqual([{ code: 'no_reply' }]);
  });

  it('puts no_reply before no_show_history', () => {
    expect(getAtRiskReasons(appointmentAt(hourMs), [noShowAt(-dayMs)], settings, now)).toEqual([
      { code: 'no_reply' },
      { code: 'no_show_history', noShowCount: 1 },
    ]);
  });
});

describe('getAtRiskReasons: no reply', () => {
  it('includes no_reply at exactly noReplyWindowHours before the start', () => {
    expect(getAtRiskReasons(appointmentAt(24 * hourMs), [], settings, now)).toEqual([{ code: 'no_reply' }]);
  });

  it('omits no_reply 1 ms further out', () => {
    expect(getAtRiskReasons(appointmentAt(24 * hourMs + 1), [], settings, now)).toEqual([]);
  });

  it('omits no_reply for a confirmed appointment inside the window', () => {
    expect(getAtRiskReasons(appointmentAt(hourMs, 'confirmed'), [], settings, now)).toEqual([]);
  });

  it('follows a change to noReplyWindowHours alone', () => {
    const appointment = appointmentAt(30 * hourMs);
    expect(getAtRiskReasons(appointment, [], settings, now)).toEqual([]);
    expect(getAtRiskReasons(appointment, [], { ...settings, noReplyWindowHours: 48 }, now)).toEqual([
      { code: 'no_reply' },
    ]);
  });
});

describe('getAtRiskReasons: no-show history', () => {
  const confirmed = appointmentAt(7 * dayMs, 'confirmed');

  it('counts only no_show entries', () => {
    const history = (['attended', 'cancelled', 'pending', 'confirmed'] as const).map((status) =>
      appointmentAt(-dayMs, status, status),
    );
    expect(getAtRiskReasons(confirmed, history, settings, now)).toEqual([]);
    expect(getAtRiskReasons(confirmed, [...history, noShowAt(-dayMs)], settings, now)).toEqual([
      { code: 'no_show_history', noShowCount: 1 },
    ]);
  });

  it('ignores an entry with the same id as the appointment', () => {
    const history = [{ ...confirmed, status: 'no_show' as const, startsAt: new Date(now.getTime() - dayMs) }];
    expect(getAtRiskReasons(confirmed, history, settings, now)).toEqual([]);
  });

  it('counts a no_show exactly at the lookback boundary but not 1 ms earlier', () => {
    expect(getAtRiskReasons(confirmed, [noShowAt(-180 * dayMs)], settings, now)).toEqual([
      { code: 'no_show_history', noShowCount: 1 },
    ]);
    expect(getAtRiskReasons(confirmed, [noShowAt(-180 * dayMs - 1)], settings, now)).toEqual([]);
  });

  it('flags a count at the threshold and not one below it or zero', () => {
    const atThreshold = { ...settings, noShowThreshold: 3 };
    const history = [noShowAt(-dayMs), noShowAt(-2 * dayMs), noShowAt(-3 * dayMs)];
    expect(getAtRiskReasons(confirmed, history, atThreshold, now)).toEqual([
      { code: 'no_show_history', noShowCount: 3 },
    ]);
    expect(getAtRiskReasons(confirmed, history.slice(0, 2), atThreshold, now)).toEqual([]);
    expect(getAtRiskReasons(confirmed, [], settings, now)).toEqual([]);
  });

  it('reports the count inside the lookback window, not the all-time count', () => {
    const history = [noShowAt(-20 * dayMs), noShowAt(-60 * dayMs), noShowAt(-200 * dayMs)];
    expect(getAtRiskReasons(confirmed, history, settings, now)).toEqual([
      { code: 'no_show_history', noShowCount: 2 },
    ]);
  });

  it('gives a confirmed appointment with enough no-shows only the history reason', () => {
    expect(getAtRiskReasons(appointmentAt(hourMs, 'confirmed'), [noShowAt(-dayMs)], settings, now)).toEqual([
      { code: 'no_show_history', noShowCount: 1 },
    ]);
  });
});

describe('isLateCancellation', () => {
  const startsAt = new Date('2026-11-11T09:00:00Z');
  const lateSettings = { lateCancellationHours: 12 };

  function cancelledAt(msBeforeStart: number, status: AppointmentStatus = 'cancelled') {
    return { status, startsAt, statusChangedAt: new Date(startsAt.getTime() - msBeforeStart) };
  }

  it.each<AppointmentStatus>(['pending', 'confirmed', 'attended', 'no_show'])('returns false for %s', (status) => {
    expect(isLateCancellation(cancelledAt(hourMs, status), lateSettings)).toBe(false);
  });

  it('returns false for every appointment when lateCancellationHours is 0', () => {
    const off = { lateCancellationHours: 0 };
    expect(isLateCancellation(cancelledAt(hourMs), off)).toBe(false);
    expect(isLateCancellation(cancelledAt(0), off)).toBe(false);
    expect(isLateCancellation(cancelledAt(-hourMs), off)).toBe(false);
  });

  it('returns false at exactly lateCancellationHours before the start and true 1 ms later', () => {
    expect(isLateCancellation(cancelledAt(12 * hourMs), lateSettings)).toBe(false);
    expect(isLateCancellation(cancelledAt(12 * hourMs - 1), lateSettings)).toBe(true);
  });

  it('returns true for a cancellation at or after the start', () => {
    expect(isLateCancellation(cancelledAt(0), lateSettings)).toBe(true);
    expect(isLateCancellation(cancelledAt(-hourMs), lateSettings)).toBe(true);
  });

  it('takes no current time, so the result never changes', () => {
    expect(isLateCancellation.length).toBe(2);
  });
});

describe('time zones: every window is elapsed time', () => {
  it('counts 24 elapsed hours for no_reply across the Madrid spring-forward change', () => {
    const springNow = new Date('2026-03-28T10:00:00Z');
    const appointment = { id: 'a', status: 'pending' as const, startsAt: new Date('2026-03-29T10:00:00Z') };
    expect(getAtRiskReasons(appointment, [], settings, springNow)).toEqual([{ code: 'no_reply' }]);
  });

  it('counts the no-show lookback in elapsed days across spring forward', () => {
    const lookbackNow = new Date('2026-04-01T10:00:00Z');
    const appointment = { id: 'a', status: 'confirmed' as const, startsAt: new Date('2026-04-02T10:00:00Z') };
    const lookback7 = { ...settings, noShowLookbackDays: 7 };
    const inside = { id: 'in', status: 'no_show' as const, startsAt: new Date('2026-03-25T10:00:00Z') };
    const outside = { id: 'out', status: 'no_show' as const, startsAt: new Date('2026-03-25T09:59:59.999Z') };
    expect(getAtRiskReasons(appointment, [inside], lookback7, lookbackNow)).toEqual([
      { code: 'no_show_history', noShowCount: 1 },
    ]);
    expect(getAtRiskReasons(appointment, [outside], lookback7, lookbackNow)).toEqual([]);
  });

  it('measures late cancellation in elapsed hours across the Madrid fall-back change', () => {
    const appointment = {
      status: 'cancelled' as const,
      startsAt: new Date('2026-10-25T10:00:00Z'),
      statusChangedAt: new Date('2026-10-24T22:00:00Z'),
    };
    expect(isLateCancellation(appointment, { lateCancellationHours: 12 })).toBe(false);
  });
});
