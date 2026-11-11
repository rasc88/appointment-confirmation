import { ApiError } from './api-error';
import type { ApiService } from './api-service';
import { buildDemoData, type DemoAppointment, type DemoData, type DemoStaffMember } from './demo-data';
import type { AppointmentStatus, DayAppointment, DayView, PublicAppointment, StaffMember } from './types';

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

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidDate(date: string): boolean {
  const parsed = Date.parse(`${date}T00:00:00Z`);
  return datePattern.test(date) && !Number.isNaN(parsed) && new Date(parsed).toISOString().startsWith(date);
}

/** `en-CA` formats as `YYYY-MM-DD`, so 23- and 25-hour days need no offset maths. */
function dateInZone(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));
}

/** Keeps the stored reasons only where the contract allows them (decision 19). */
function toDayAppointment(store: DemoData, appointment: DemoAppointment, now: Date): DayAppointment {
  const { id, service, startsAt, durationMinutes, status, confirmedBy, cancelledBy, statusChangedAt, createdAt, updatedAt } =
    appointment;
  const client = store.clients.find((entry) => entry.id === appointment.clientId)!;
  const staffMember = store.staff.find((entry) => entry.id === appointment.staffMemberId)!;
  const canBeAtRisk = (status === 'pending' || status === 'confirmed') && !hasStarted(appointment, now);
  return structuredClone({
    id,
    client: { id: client.id, name: client.name, phone: client.phone },
    staffMember: { id: staffMember.id, name: staffMember.name },
    service,
    startsAt,
    durationMinutes,
    status,
    confirmedBy,
    cancelledBy,
    statusChangedAt,
    createdAt,
    updatedAt,
    atRiskReasons: canBeAtRisk
      ? appointment.atRiskReasons.filter((reason) => reason.code !== 'no_reply' || status === 'pending')
      : [],
    isLateCancellation: status === 'cancelled' && appointment.isLateCancellation,
  });
}

function getDayView(store: DemoData, params: { date?: string; staffId?: string }, now: Date): DayView {
  const { date, staffId } = params;
  if (date !== undefined && !isValidDate(date)) {
    throw new ApiError(422, 'validation_error', 'Enter the date as YYYY-MM-DD.', 'date');
  }
  if (staffId !== undefined && !uuidPattern.test(staffId)) {
    throw new ApiError(422, 'validation_error', 'Enter a valid staff id.', 'staffId');
  }
  const { timeZone } = store.settings;
  const day = date ?? dateInZone(now, timeZone);
  const appointments = store.appointments
    .filter((appointment) => dateInZone(appointment.startsAt, timeZone) === day)
    .filter((appointment) => staffId === undefined || appointment.staffMemberId === staffId)
    .sort((first, second) => Date.parse(first.startsAt) - Date.parse(second.startsAt))
    .map((appointment) => toDayAppointment(store, appointment, now));
  return { date: day, timeZone, appointments };
}

function notImplemented(operationId: string): Promise<never> {
  return Promise.reject(new Error(`Not implemented in mock: ${operationId}`));
}

/** In memory only: every instance starts from fresh demo data, and a reload resets it. */
export function createMockApi(options?: { now?: Date }): ApiService {
  const store = buildDemoData(options?.now ?? new Date());
  let signedInStaffId: string | null = null;
  const currentTime = () => options?.now ?? new Date();

  function assertSignedIn(): DemoStaffMember {
    const staffMember = store.staff.find((entry) => entry.id === signedInStaffId);
    if (!staffMember || !staffMember.isActive) {
      throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    }
    return staffMember;
  }

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
      return toStaffMember(assertSignedIn());
    },
    async listStaff() {
      assertSignedIn();
      return store.staff.map(toStaffMember);
    },
    createStaffMember: () => notImplemented('createStaffMember'),
    updateStaffMember: () => notImplemented('updateStaffMember'),
    searchClients: () => notImplemented('searchClients'),
    createClient: () => notImplemented('createClient'),
    getClient: () => notImplemented('getClient'),
    async getDayView(params) {
      assertSignedIn();
      return getDayView(store, params, currentTime());
    },
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
