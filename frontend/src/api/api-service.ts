import type {
  Appointment,
  AppointmentWithLink,
  BusinessSettings,
  Client,
  ClientDetail,
  CreateAppointmentRequest,
  CreateClientRequest,
  CreateStaffMemberRequest,
  DayView,
  LoginRequest,
  OutcomeRequest,
  PublicAppointment,
  StaffMember,
  UpdateAppointmentRequest,
  UpdateSettingsRequest,
  UpdateStaffMemberRequest,
} from './types';

/** One method per `operationId` in `openapi.yaml`. Every implementation rejects with `ApiError` for documented errors. */
export interface ApiService {
  login(body: LoginRequest): Promise<StaffMember>;
  logout(): Promise<void>;
  getCurrentStaffMember(): Promise<StaffMember>;
  listStaff(): Promise<StaffMember[]>;
  createStaffMember(body: CreateStaffMemberRequest): Promise<StaffMember>;
  updateStaffMember(id: string, body: UpdateStaffMemberRequest): Promise<StaffMember>;
  searchClients(q?: string): Promise<Client[]>;
  createClient(body: CreateClientRequest): Promise<Client>;
  getClient(id: string): Promise<ClientDetail>;
  getDayView(params: { date?: string; staffId?: string }): Promise<DayView>;
  createAppointment(body: CreateAppointmentRequest): Promise<AppointmentWithLink>;
  updateAppointment(id: string, body: UpdateAppointmentRequest): Promise<Appointment>;
  confirmAppointment(id: string): Promise<Appointment>;
  cancelAppointment(id: string): Promise<Appointment>;
  recordAppointmentOutcome(id: string, body: OutcomeRequest): Promise<Appointment>;
  undoAppointmentOutcome(id: string): Promise<Appointment>;
  regenerateAppointmentLink(id: string): Promise<AppointmentWithLink>;
  getSettings(): Promise<BusinessSettings>;
  updateSettings(body: UpdateSettingsRequest): Promise<BusinessSettings>;
  getPublicAppointment(token: string): Promise<PublicAppointment>;
  confirmPublicAppointment(token: string): Promise<PublicAppointment>;
  cancelPublicAppointment(token: string): Promise<PublicAppointment>;
}
