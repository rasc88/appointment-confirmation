/** Hand-written to match the schemas in `openapi.yaml` (decision 21). Timestamps are ISO 8601 strings. */

export type ErrorCode =
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'cross_site_request'
  | 'not_found'
  | 'invalid_transition'
  | 'appointment_started'
  | 'appointment_not_started'
  | 'email_taken'
  | 'cannot_deactivate_self'
  | 'validation_error'
  | 'rate_limited'
  | 'internal_error';

export type Actor = 'client' | 'staff' | null;

export type AppointmentStatus = 'pending' | 'confirmed' | 'cancelled' | 'attended' | 'no_show';

export interface StaffMember {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  createdAt: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface CreateStaffMemberRequest {
  name: string;
  email: string;
  password: string;
}

export interface UpdateStaffMemberRequest {
  name?: string;
  isActive?: boolean;
}

export interface Client {
  id: string;
  name: string;
  phone: string | null;
  createdAt: string;
}

export interface CreateClientRequest {
  name: string;
  phone?: string | null;
}

export interface ClientDetail extends Client {
  noShowCount: number;
  appointments: Appointment[];
}

export interface Appointment {
  id: string;
  client: {
    id: string;
    name: string;
    phone: string | null;
  };
  staffMember: {
    id: string;
    name: string;
  };
  service: string;
  startsAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  confirmedBy: Actor;
  cancelledBy: Actor;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DayView {
  date: string;
  timeZone: string;
  appointments: DayAppointment[];
}

export interface DayAppointment extends Appointment {
  atRiskReasons: AtRiskReason[];
  isLateCancellation: boolean;
}

export type AtRiskReason = { code: 'no_reply' } | { code: 'no_show_history'; noShowCount: number };

export interface CreateAppointmentRequest {
  clientId: string;
  staffMemberId: string;
  service: string;
  startsAt: string;
  durationMinutes?: number;
}

export interface UpdateAppointmentRequest {
  staffMemberId?: string;
  service?: string;
  startsAt?: string;
  durationMinutes?: number;
}

export interface OutcomeRequest {
  outcome: 'attended' | 'no_show';
}

export interface AppointmentWithLink {
  appointment: Appointment;
  confirmationLink: string;
  message: string;
}

export interface PublicAppointment {
  businessName: string;
  timeZone: string;
  service: string;
  staffName: string;
  startsAt: string;
  durationMinutes: number;
  status: AppointmentStatus;
  hasStarted: boolean;
}

export interface BusinessSettings {
  businessName: string;
  timeZone: string;
  noReplyWindowHours: number;
  noShowThreshold: number;
  noShowLookbackDays: number;
  lateCancellationHours: number;
  defaultDurationMinutes: number;
  messageTemplate: string;
  updatedAt: string;
}

export interface UpdateSettingsRequest {
  businessName?: string;
  timeZone?: string;
  noReplyWindowHours?: number;
  noShowThreshold?: number;
  noShowLookbackDays?: number;
  lateCancellationHours?: number;
  defaultDurationMinutes?: number;
  messageTemplate?: string;
}
