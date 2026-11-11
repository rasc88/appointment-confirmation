import { prisma } from './db.js';
import { ApiError } from './errors.js';
import type { BusinessSettings, Prisma } from './generated/prisma/client.js';
import { renderMessage } from './message-template.js';
import { isUuidShaped } from './validation.js';

export const appointmentInclude = { client: true, staffMember: true } satisfies Prisma.AppointmentInclude;

export type AppointmentWithRelations = Prisma.AppointmentGetPayload<{ include: typeof appointmentInclude }>;

export function toAppointment(appointment: AppointmentWithRelations) {
  const { id, client, staffMember, service, startsAt, durationMinutes, status } = appointment;
  return {
    id,
    client: { id: client.id, name: client.name, phone: client.phone },
    staffMember: { id: staffMember.id, name: staffMember.name },
    service,
    startsAt: startsAt.toISOString(),
    durationMinutes,
    status,
    confirmedBy: appointment.confirmedBy,
    cancelledBy: appointment.cancelledBy,
    statusChangedAt: appointment.statusChangedAt.toISOString(),
    createdAt: appointment.createdAt.toISOString(),
    updatedAt: appointment.updatedAt.toISOString(),
  };
}

export async function loadAppointment(id: string) {
  const appointment = isUuidShaped(id)
    ? await prisma.appointment.findUnique({ where: { id }, include: appointmentInclude })
    : null;
  if (!appointment) {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  return appointment;
}

/** The link and message are returned only on create and regenerate (decision 5). */
export function toAppointmentWithLink(
  appointment: AppointmentWithRelations,
  token: string,
  settings: BusinessSettings,
  publicBaseUrl: string,
) {
  const confirmationLink = `${new URL(publicBaseUrl).origin}/c/${token}`;
  return {
    appointment: toAppointment(appointment),
    confirmationLink,
    message: renderMessage(settings, appointment, confirmationLink),
  };
}
