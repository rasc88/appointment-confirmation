import { z } from 'zod';
import { appointmentInclude, toAppointment } from './appointments.js';
import { getAtRiskReasons, isLateCancellation } from './at-risk.js';
import { prisma } from './db.js';
import { validationError } from './errors.js';
import type { Appointment, BusinessSettings } from './generated/prisma/client.js';
import { ensureBusinessSettings } from './settings.js';
import { isUuidShaped } from './validation.js';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
/** Covers every zone's UTC offset, so no offset maths is needed to bound the query. */
const maxZoneOffsetMs = 14 * hourMs;
const earliestQueryMs = Date.parse('0001-01-01T00:00:00Z');
const dateSchema = z.iso.date();

function dateInZone(instant: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(instant);
}

/** Prisma rejects a `DateTime` before year 1, which the window of `0000-01-01` or `0001-01-01` reaches. */
function toQueryDate(ms: number) {
  return new Date(Math.max(ms, earliestQueryMs));
}

function readDate(date: unknown) {
  if (date === undefined) {
    return undefined;
  }
  const result = dateSchema.safeParse(date);
  if (!result.success) {
    throw validationError('Enter the date as YYYY-MM-DD.', 'date');
  }
  return result.data;
}

function readStaffId(staffId: unknown) {
  if (staffId !== undefined && (typeof staffId !== 'string' || !isUuidShaped(staffId))) {
    throw validationError('Enter a valid staff id.', 'staffId');
  }
  return staffId;
}

/** One query for every client on the day, grouped by client. */
async function loadNoShowHistory(clientIds: string[], settings: BusinessSettings, now: Date) {
  const noShows = await prisma.appointment.findMany({
    where: {
      clientId: { in: clientIds },
      status: 'no_show',
      startsAt: { gte: new Date(now.getTime() - settings.noShowLookbackDays * dayMs) },
    },
  });
  const historyByClient = new Map<string, Appointment[]>();
  for (const noShow of noShows) {
    historyByClient.set(noShow.clientId, [...(historyByClient.get(noShow.clientId) ?? []), noShow]);
  }
  return historyByClient;
}

export async function getDayView(query: Record<string, unknown>, now: Date) {
  const date = readDate(query.date);
  const staffId = readStaffId(query.staffId);
  const settings = await ensureBusinessSettings(prisma);
  const { timeZone } = settings;
  const day = date ?? dateInZone(now, timeZone);
  const dayStartMs = Date.parse(`${day}T00:00:00Z`);
  const candidates = await prisma.appointment.findMany({
    where: {
      startsAt: { gte: toQueryDate(dayStartMs - maxZoneOffsetMs), lt: toQueryDate(dayStartMs + dayMs + maxZoneOffsetMs) },
      staffMemberId: staffId,
    },
    include: appointmentInclude,
    orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
  });
  const appointments = candidates.filter(({ startsAt }) => dateInZone(startsAt, timeZone) === day);
  const history = await loadNoShowHistory([...new Set(appointments.map(({ clientId }) => clientId))], settings, now);
  return {
    date: day,
    timeZone,
    appointments: appointments.map((appointment) => ({
      ...toAppointment(appointment),
      atRiskReasons: getAtRiskReasons(appointment, history.get(appointment.clientId) ?? [], settings, now),
      isLateCancellation: isLateCancellation(appointment, settings),
    })),
  };
}
