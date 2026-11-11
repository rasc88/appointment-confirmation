import { ApiError } from './api-error';
import type { ApiService } from './api-service';
import { buildDemoData, type DemoAppointment, type DemoData, type DemoStaffMember } from './demo-data';
import type {
  Appointment,
  AppointmentStatus,
  AppointmentWithLink,
  BusinessSettings,
  Client,
  ClientDetail,
  CreateAppointmentRequest,
  CreateClientRequest,
  CreateStaffMemberRequest,
  DayAppointment,
  DayView,
  OutcomeRequest,
  PublicAppointment,
  StaffMember,
  UpdateSettingsRequest,
  UpdateStaffMemberRequest,
} from './types';

function toStaffMember({ id, name, email, isActive, createdAt }: DemoStaffMember): StaffMember {
  return structuredClone({ id, name, email, isActive, createdAt });
}

const closedStatuses = new Set<AppointmentStatus>(['cancelled', 'attended', 'no_show']);

const hourMs = 3_600_000;

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

function invalidTransition(): ApiError {
  return new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.');
}

function setStatus(appointment: DemoAppointment, status: AppointmentStatus, now: Date) {
  appointment.status = status;
  appointment.statusChangedAt = now.toISOString();
  appointment.updatedAt = now.toISOString();
}

/** The contract's rule: less than `lateCancellationHours` before the start, or after it, is late; 0 turns it off. */
function cancel(store: DemoData, appointment: DemoAppointment, actor: 'client' | 'staff', now: Date) {
  const { lateCancellationHours } = store.settings;
  setStatus(appointment, 'cancelled', now);
  appointment.cancelledBy = actor;
  appointment.isLateCancellation =
    lateCancellationHours > 0 && Date.parse(appointment.startsAt) - now.getTime() < lateCancellationHours * hourMs;
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

function toAppointment(store: DemoData, appointment: DemoAppointment): Appointment {
  const { id, service, startsAt, durationMinutes, status, confirmedBy, cancelledBy, statusChangedAt, createdAt, updatedAt } =
    appointment;
  const client = store.clients.find((entry) => entry.id === appointment.clientId)!;
  const staffMember = store.staff.find((entry) => entry.id === appointment.staffMemberId)!;
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
  });
}

/** Keeps the stored reasons only where the contract allows them (decision 19). */
function toDayAppointment(store: DemoData, appointment: DemoAppointment, now: Date): DayAppointment {
  const { status } = appointment;
  const canBeAtRisk = (status === 'pending' || status === 'confirmed') && !hasStarted(appointment, now);
  return {
    ...toAppointment(store, appointment),
    atRiskReasons: canBeAtRisk
      ? structuredClone(appointment.atRiskReasons.filter((reason) => reason.code !== 'no_reply' || status === 'pending'))
      : [],
    isLateCancellation: status === 'cancelled' && appointment.isLateCancellation,
  };
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

const maxSearchResults = 20;

function searchClients(store: DemoData, q: string | undefined): Client[] {
  if (q !== undefined && (q.length < 1 || q.length > 80)) {
    throw new ApiError(422, 'validation_error', 'Enter 1 to 80 characters to search.', 'q');
  }
  const needle = q?.toLowerCase();
  const matches = store.clients.filter(
    ({ name, phone }) =>
      needle === undefined || name.toLowerCase().includes(needle) || (phone?.includes(needle) ?? false),
  );
  return structuredClone(matches.sort((first, second) => first.name.localeCompare(second.name)).slice(0, maxSearchResults));
}

const phonePattern = /^[0-9+() -]+$/;

function createClient(store: DemoData, { name, phone }: CreateClientRequest, now: Date): Client {
  if (name.length < 1 || name.length > 80) {
    throw new ApiError(422, 'validation_error', "Enter the client's name, up to 80 characters.", 'name');
  }
  if (phone != null && (phone.length > 30 || !phonePattern.test(phone))) {
    throw new ApiError(422, 'validation_error', 'Use only digits, spaces, +, ( ) and -, up to 30 characters.', 'phone');
  }
  const client: Client = { id: crypto.randomUUID(), name, phone: phone ?? null, createdAt: now.toISOString() };
  store.clients.push(client);
  return structuredClone(client);
}

/** Same order and count as `GET /clients/{id}` in `backend/src/client-routes.ts`. */
function getClient(store: DemoData, id: string): ClientDetail {
  const client = store.clients.find((entry) => entry.id === id);
  if (!client) {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  const appointments = store.appointments
    .filter((appointment) => appointment.clientId === id)
    .sort((first, second) => {
      const byStart = Date.parse(second.startsAt) - Date.parse(first.startsAt);
      if (byStart !== 0) {
        return byStart;
      }
      return first.id < second.id ? -1 : 1;
    });
  return {
    ...structuredClone(client),
    noShowCount: appointments.filter(({ status }) => status === 'no_show').length,
    appointments: appointments.map((appointment) => toAppointment(store, appointment)),
  };
}

const dateTimePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i;

/** Checks in a fixed order and reports only the first failure. */
function assertValidNewAppointment(store: DemoData, body: CreateAppointmentRequest, now: Date) {
  const { clientId, staffMemberId, service, startsAt, durationMinutes } = body;
  if (!store.clients.some((client) => client.id === clientId)) {
    throw new ApiError(422, 'validation_error', 'Choose a client.', 'clientId');
  }
  if (!store.staff.some((staffMember) => staffMember.id === staffMemberId && staffMember.isActive)) {
    throw new ApiError(422, 'validation_error', 'Choose an active staff member.', 'staffMemberId');
  }
  if (service.length < 1 || service.length > 80) {
    throw new ApiError(422, 'validation_error', 'Enter the service, up to 80 characters.', 'service');
  }
  const startsAtMs = Date.parse(startsAt);
  if (!dateTimePattern.test(startsAt) || Number.isNaN(startsAtMs)) {
    throw new ApiError(422, 'validation_error', 'Enter a valid date and time.', 'startsAt');
  }
  if (startsAtMs <= now.getTime()) {
    throw new ApiError(422, 'validation_error', 'Choose a time in the future.', 'startsAt');
  }
  if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480)) {
    throw new ApiError(422, 'validation_error', 'Enter a duration from 5 to 480 minutes.', 'durationMinutes');
  }
}

/** The message is fixed rather than rendered from the settings template; the backend renders the real one (#11). */
function createAppointment(store: DemoData, body: CreateAppointmentRequest, now: Date): AppointmentWithLink {
  assertValidNewAppointment(store, body, now);
  const nowIso = now.toISOString();
  const appointment: DemoAppointment = {
    id: crypto.randomUUID(),
    clientId: body.clientId,
    staffMemberId: body.staffMemberId,
    service: body.service,
    startsAt: new Date(body.startsAt).toISOString(),
    durationMinutes: body.durationMinutes ?? store.settings.defaultDurationMinutes,
    status: 'pending',
    confirmedBy: null,
    cancelledBy: null,
    statusChangedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    atRiskReasons: [],
    isLateCancellation: false,
    token: crypto.randomUUID(),
  };
  store.appointments.push(appointment);
  const confirmationLink = `${window.location.origin}/c/${appointment.token}`;
  return {
    appointment: toAppointment(store, appointment),
    confirmationLink,
    message: `Please confirm your appointment: ${confirmationLink}`,
  };
}

function findAppointment(store: DemoData, id: string): DemoAppointment {
  const appointment = store.appointments.find((entry) => entry.id === id);
  if (!appointment) {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  return appointment;
}

function getAppointment(store: DemoData, id: string): Appointment {
  return toAppointment(store, findAppointment(store, id));
}

/** Same checks, order and messages as #39: state, then start time, then body (decision 28). */
function confirmAppointment(store: DemoData, id: string, now: Date): Appointment {
  const appointment = findAppointment(store, id);
  if (appointment.status === 'confirmed') {
    return toAppointment(store, appointment);
  }
  if (closedStatuses.has(appointment.status)) {
    throw invalidTransition();
  }
  if (hasStarted(appointment, now)) {
    throw new ApiError(409, 'appointment_started', 'This appointment has already started.');
  }
  setStatus(appointment, 'confirmed', now);
  appointment.confirmedBy = 'staff';
  return toAppointment(store, appointment);
}

function cancelAppointment(store: DemoData, id: string, now: Date): Appointment {
  const appointment = findAppointment(store, id);
  if (closedStatuses.has(appointment.status)) {
    throw invalidTransition();
  }
  cancel(store, appointment, 'staff', now);
  return toAppointment(store, appointment);
}

const outcomes: unknown[] = ['attended', 'no_show'];

function recordAppointmentOutcome(store: DemoData, id: string, body: OutcomeRequest, now: Date): Appointment {
  const appointment = findAppointment(store, id);
  if (closedStatuses.has(appointment.status)) {
    throw invalidTransition();
  }
  if (!hasStarted(appointment, now)) {
    throw new ApiError(409, 'appointment_not_started', 'This appointment has not started yet.');
  }
  if (!outcomes.includes(body.outcome)) {
    throw validationError('Choose attended or no-show.', 'outcome');
  }
  const unknownField = Object.keys(body).find((key) => key !== 'outcome');
  if (unknownField !== undefined) {
    throw validationError('Unknown field.', unknownField);
  }
  setStatus(appointment, body.outcome, now);
  return toAppointment(store, appointment);
}

function undoAppointmentOutcome(store: DemoData, id: string, now: Date): Appointment {
  const appointment = findAppointment(store, id);
  if (appointment.status !== 'attended' && appointment.status !== 'no_show') {
    throw invalidTransition();
  }
  setStatus(appointment, appointment.confirmedBy ? 'confirmed' : 'pending', now);
  return toAppointment(store, appointment);
}

function validationError(message: string, field?: string): ApiError {
  return new ApiError(422, 'validation_error', message, field);
}

function hasLength(value: string, min: number, max: number): boolean {
  const length = [...value].length;
  return length >= min && length <= max;
}

const settingRanges = {
  noReplyWindowHours: [1, 168],
  noShowThreshold: [1, 10],
  noShowLookbackDays: [7, 730],
  lateCancellationHours: [0, 168],
  defaultDurationMinutes: [5, 480],
} as const;

const placeholderPattern = /\{[^{}]*\}/g;
const allowedPlaceholders = ['{client}', '{business}', '{service}', '{staff}', '{date}', '{time}', '{link}'];

/** Same rules, order and messages as `validateMessageTemplate` in `backend/src/message-template.ts`. */
function messageTemplateError(template: string): string | null {
  if (!hasLength(template, 1, 500)) {
    return 'Must be between 1 and 500 characters.';
  }
  const placeholders: string[] = template.match(placeholderPattern) ?? [];
  const unknownPlaceholder = placeholders.find((placeholder) => !allowedPlaceholders.includes(placeholder));
  if (unknownPlaceholder !== undefined) {
    return `Unknown placeholder ${unknownPlaceholder}. Allowed: ${allowedPlaceholders.join(', ')}.`;
  }
  if (!placeholders.includes('{link}')) {
    return 'Must contain {link}.';
  }
  return null;
}

function isTimeZone(value: string): boolean {
  return value === 'UTC' || Intl.supportedValuesOf('timeZone').includes(value);
}

function assertValidSettings(body: UpdateSettingsRequest) {
  if (Object.values(body).every((value) => value === undefined)) {
    throw validationError('Change at least one setting.');
  }
  const { businessName, timeZone, messageTemplate } = body;
  if (businessName !== undefined && !hasLength(businessName, 1, 80)) {
    throw validationError('Must be between 1 and 80 characters.', 'businessName');
  }
  if (timeZone !== undefined && !isTimeZone(timeZone)) {
    throw validationError('Must be an IANA time zone, for example Europe/Madrid.', 'timeZone');
  }
  for (const [field, [min, max]] of Object.entries(settingRanges)) {
    const value = body[field as keyof typeof settingRanges];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
      throw validationError(`Must be a whole number between ${min} and ${max}.`, field);
    }
  }
  const templateError = messageTemplate === undefined ? null : messageTemplateError(messageTemplate);
  if (templateError) {
    throw validationError(templateError, 'messageTemplate');
  }
}

function updateSettings(store: DemoData, body: UpdateSettingsRequest, now: Date): BusinessSettings {
  assertValidSettings(body);
  const changes = Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
  store.settings = { ...store.settings, ...changes, updatedAt: now.toISOString() };
  return structuredClone(store.settings);
}

const emailPattern = /^[^\s@]+@[^\s@]+$/;

function createStaffMember(store: DemoData, { name, email, password }: CreateStaffMemberRequest, now: Date): StaffMember {
  if (!hasLength(name, 1, 80)) {
    throw validationError('Must be between 1 and 80 characters.', 'name');
  }
  if (email.length > 254 || !emailPattern.test(email)) {
    throw validationError('Enter a valid email address.', 'email');
  }
  if (!hasLength(password, 8, 72)) {
    throw validationError('Must be between 8 and 72 characters.', 'password');
  }
  const lowercaseEmail = email.toLowerCase();
  if (store.staff.some((entry) => entry.email.toLowerCase() === lowercaseEmail)) {
    throw new ApiError(409, 'email_taken', 'Another staff account already has this email.');
  }
  const staffMember: DemoStaffMember = {
    id: crypto.randomUUID(),
    name,
    email: lowercaseEmail,
    isActive: true,
    createdAt: now.toISOString(),
    password,
  };
  store.staff.push(staffMember);
  return toStaffMember(staffMember);
}

function updateStaffMember(store: DemoData, id: string, body: UpdateStaffMemberRequest, signedInId: string): StaffMember {
  const staffMember = store.staff.find((entry) => entry.id === id);
  if (!staffMember) {
    throw new ApiError(404, 'not_found', 'Not found.');
  }
  const { name, isActive } = body;
  if (name === undefined && isActive === undefined) {
    throw validationError('Change at least one field.');
  }
  if (name !== undefined && !hasLength(name, 1, 80)) {
    throw validationError('Must be between 1 and 80 characters.', 'name');
  }
  if (isActive === false && id === signedInId) {
    throw new ApiError(409, 'cannot_deactivate_self', 'You cannot deactivate your own account.');
  }
  if (name !== undefined) {
    staffMember.name = name;
  }
  if (isActive !== undefined) {
    staffMember.isActive = isActive;
  }
  return toStaffMember(staffMember);
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
    async createStaffMember(body) {
      assertSignedIn();
      return createStaffMember(store, body, currentTime());
    },
    async updateStaffMember(id, body) {
      const signedIn = assertSignedIn();
      return updateStaffMember(store, id, body, signedIn.id);
    },
    async searchClients(q) {
      assertSignedIn();
      return searchClients(store, q);
    },
    async createClient(body) {
      assertSignedIn();
      return createClient(store, body, currentTime());
    },
    async getClient(id) {
      assertSignedIn();
      return getClient(store, id);
    },
    async getDayView(params) {
      assertSignedIn();
      return getDayView(store, params, currentTime());
    },
    async createAppointment(body) {
      assertSignedIn();
      return createAppointment(store, body, currentTime());
    },
    async getAppointment(id) {
      assertSignedIn();
      return getAppointment(store, id);
    },
    updateAppointment: () => notImplemented('updateAppointment'),
    async confirmAppointment(id) {
      assertSignedIn();
      return confirmAppointment(store, id, currentTime());
    },
    async cancelAppointment(id) {
      assertSignedIn();
      return cancelAppointment(store, id, currentTime());
    },
    async recordAppointmentOutcome(id, body) {
      assertSignedIn();
      return recordAppointmentOutcome(store, id, body, currentTime());
    },
    async undoAppointmentOutcome(id) {
      assertSignedIn();
      return undoAppointmentOutcome(store, id, currentTime());
    },
    regenerateAppointmentLink: () => notImplemented('regenerateAppointmentLink'),
    async getSettings() {
      assertSignedIn();
      return structuredClone(store.settings);
    },
    async updateSettings(body) {
      assertSignedIn();
      return updateSettings(store, body, currentTime());
    },
    async getPublicAppointment(token) {
      return toPublicAppointment(store, findByToken(store, token), currentTime());
    },
    async confirmPublicAppointment(token) {
      const appointment = findByToken(store, token);
      const now = currentTime();
      assertClientCanChange(appointment, now);
      if (appointment.status === 'pending') {
        setStatus(appointment, 'confirmed', now);
        appointment.confirmedBy = 'client';
      }
      return toPublicAppointment(store, appointment, now);
    },
    async cancelPublicAppointment(token) {
      const appointment = findByToken(store, token);
      const now = currentTime();
      assertClientCanChange(appointment, now);
      cancel(store, appointment, 'client', now);
      return toPublicAppointment(store, appointment, now);
    },
  };
}
