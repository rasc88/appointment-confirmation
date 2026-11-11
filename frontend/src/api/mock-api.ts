import { ApiError } from './api-error';
import type { ApiService } from './api-service';
import { buildDemoData, type DemoAppointment, type DemoData, type DemoStaffMember } from './demo-data';
import type { AppointmentStatus, PublicAppointment, StaffMember } from './types';

function toStaffMember({ id, name, email, isActive, createdAt }: DemoStaffMember): StaffMember {
  return structuredClone({ id, name, email, isActive, createdAt });
}

const closedStatuses = new Set<AppointmentStatus>(['cancelled', 'attended', 'no_show']);

function hasStarted(appointment: DemoAppointment, now: Date): boolean {
  return now.getTime() >= Date.parse(appointment.startsAt);
}

function toPublicAppointment(store: DemoData, appointment: DemoAppointment, now: Date): PublicAppointment {
  return {
    businessName: store.settings.businessName,
    timeZone: store.settings.timeZone,
    service: appointment.service,
    staffName: store.staff.find((entry) => entry.id === appointment.staffMemberId)?.name ?? '',
    startsAt: appointment.startsAt,
    durationMinutes: appointment.durationMinutes,
    status: appointment.status,
    hasStarted: hasStarted(appointment, now),
  };
}

function findByToken(store: DemoData, token: string): DemoAppointment {
  const appointment = store.appointments.find((entry) => entry.token === token);
  if (!appointment) {
    throw new ApiError(404, 'not_found', 'This link is not valid.');
  }
  return appointment;
}

function assertClientCanChange(appointment: DemoAppointment, now: Date) {
  if (closedStatuses.has(appointment.status)) {
    throw new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.');
  }
  if (hasStarted(appointment, now)) {
    throw new ApiError(409, 'appointment_started', 'This appointment has already started.');
  }
}

function notImplemented(operationId: string): Promise<never> {
  return Promise.reject(new Error(`Not implemented in mock: ${operationId}`));
}

/** In memory only: every instance starts from fresh demo data, and a reload resets it. */
export function createMockApi(options?: { now?: Date }): ApiService {
  const store = buildDemoData(options?.now ?? new Date());
  let signedInStaffId: string | null = null;
  const currentTime = () => options?.now ?? new Date();

  return {
    async login({ email, password }) {
      const staffMember = store.staff.find((entry) => entry.email.toLowerCase() === email.toLowerCase());
      if (!staffMember || staffMember.password !== password || !staffMember.isActive) {
        throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
      }
      signedInStaffId = staffMember.id;
      return toStaffMember(staffMember);
    },
    async logout() {
      signedInStaffId = null;
    },
    async getCurrentStaffMember() {
      const staffMember = store.staff.find((entry) => entry.id === signedInStaffId);
      if (!staffMember || !staffMember.isActive) {
        throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
      }
      return toStaffMember(staffMember);
    },
    listStaff: () => notImplemented('listStaff'),
    createStaffMember: () => notImplemented('createStaffMember'),
    updateStaffMember: () => notImplemented('updateStaffMember'),
    searchClients: () => notImplemented('searchClients'),
    createClient: () => notImplemented('createClient'),
    getClient: () => notImplemented('getClient'),
    getDayView: () => notImplemented('getDayView'),
    createAppointment: () => notImplemented('createAppointment'),
    updateAppointment: () => notImplemented('updateAppointment'),
    confirmAppointment: () => notImplemented('confirmAppointment'),
    cancelAppointment: () => notImplemented('cancelAppointment'),
    recordAppointmentOutcome: () => notImplemented('recordAppointmentOutcome'),
    undoAppointmentOutcome: () => notImplemented('undoAppointmentOutcome'),
    regenerateAppointmentLink: () => notImplemented('regenerateAppointmentLink'),
    getSettings: () => notImplemented('getSettings'),
    updateSettings: () => notImplemented('updateSettings'),
    async getPublicAppointment(token) {
      return toPublicAppointment(store, findByToken(store, token), currentTime());
    },
    async confirmPublicAppointment(token) {
      const appointment = findByToken(store, token);
      const now = currentTime();
      assertClientCanChange(appointment, now);
      if (appointment.status === 'pending') {
        appointment.status = 'confirmed';
        appointment.confirmedBy = 'client';
        appointment.statusChangedAt = now.toISOString();
        appointment.updatedAt = now.toISOString();
      }
      return toPublicAppointment(store, appointment, now);
    },
    async cancelPublicAppointment(token) {
      const appointment = findByToken(store, token);
      const now = currentTime();
      assertClientCanChange(appointment, now);
      appointment.status = 'cancelled';
      appointment.cancelledBy = 'client';
      appointment.statusChangedAt = now.toISOString();
      appointment.updatedAt = now.toISOString();
      return toPublicAppointment(store, appointment, now);
    },
  };
}
