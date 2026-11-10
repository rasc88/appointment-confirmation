import type { Appointment, BusinessSettings } from './generated/prisma/client.js';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

export type AtRiskReason =
  | { code: 'no_reply' }
  | { code: 'no_show_history'; noShowCount: number };

/** Every window is elapsed time, so no rule depends on the time zone (decision 19). */
export function getAtRiskReasons(
  appointment: Pick<Appointment, 'id' | 'status' | 'startsAt'>,
  clientHistory: Pick<Appointment, 'id' | 'status' | 'startsAt'>[],
  settings: Pick<BusinessSettings, 'noReplyWindowHours' | 'noShowThreshold' | 'noShowLookbackDays'>,
  now: Date,
): AtRiskReason[] {
  const isOpen = appointment.status === 'pending' || appointment.status === 'confirmed';
  const msUntilStart = appointment.startsAt.getTime() - now.getTime();
  if (!isOpen || msUntilStart <= 0) {
    return [];
  }
  const reasons: AtRiskReason[] = [];
  if (appointment.status === 'pending' && msUntilStart <= settings.noReplyWindowHours * hourMs) {
    reasons.push({ code: 'no_reply' });
  }
  const lookbackStartMs = now.getTime() - settings.noShowLookbackDays * dayMs;
  const noShowCount = clientHistory.filter(
    (entry) =>
      entry.id !== appointment.id && entry.status === 'no_show' && entry.startsAt.getTime() >= lookbackStartMs,
  ).length;
  if (noShowCount >= settings.noShowThreshold) {
    reasons.push({ code: 'no_show_history', noShowCount });
  }
  return reasons;
}

export function isLateCancellation(
  appointment: Pick<Appointment, 'status' | 'startsAt' | 'statusChangedAt'>,
  settings: Pick<BusinessSettings, 'lateCancellationHours'>,
): boolean {
  if (appointment.status !== 'cancelled' || settings.lateCancellationHours === 0) {
    return false;
  }
  const msBeforeStart = appointment.startsAt.getTime() - appointment.statusChangedAt.getTime();
  return msBeforeStart < settings.lateCancellationHours * hourMs;
}
