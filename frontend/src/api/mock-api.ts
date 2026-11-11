import { ApiError } from './api-error';
import type { ApiService } from './api-service';
import { buildDemoData, type DemoStaffMember } from './demo-data';
import type { StaffMember } from './types';

function toStaffMember({ id, name, email, isActive, createdAt }: DemoStaffMember): StaffMember {
  return structuredClone({ id, name, email, isActive, createdAt });
}

function notImplemented(operationId: string): Promise<never> {
  return Promise.reject(new Error(`Not implemented in mock: ${operationId}`));
}

/** In memory only: every instance starts from fresh demo data, and a reload resets it. */
export function createMockApi(options?: { now?: Date }): ApiService {
  const store = buildDemoData(options?.now ?? new Date());
  let signedInStaffId: string | null = null;

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
    getPublicAppointment: () => notImplemented('getPublicAppointment'),
    confirmPublicAppointment: () => notImplemented('confirmPublicAppointment'),
    cancelPublicAppointment: () => notImplemented('cancelPublicAppointment'),
  };
}
