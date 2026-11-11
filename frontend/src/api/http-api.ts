import { ApiError } from './api-error';
import type { ApiService } from './api-service';
import type { ErrorCode } from './types';

interface ErrorEnvelope {
  error: { code: string; message: string; field?: string };
}

function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  const error = (value as Partial<ErrorEnvelope> | null)?.error;
  return (
    typeof error?.code === 'string' &&
    typeof error.message === 'string' &&
    (error.field === undefined || typeof error.field === 'string')
  );
}

function unexpectedResponse(response: Response): Error {
  return new Error(`Unexpected response from the server (HTTP ${response.status}).`);
}

/** Anything but the documented error envelope is a plain `Error`, so pages show their generic retry message. */
async function toError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null);
  if (!isErrorEnvelope(body)) {
    return unexpectedResponse(response);
  }
  const { code, message, field } = body.error;
  return new ApiError(response.status, code as ErrorCode, message, field);
}

/** Same-origin `fetch` under `/v1`; every method is an arrow function, so it works detached from the object. */
export function createHttpApi(): ApiService {
  async function request<Result>(
    method: string,
    path: string,
    options: { body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<Result> {
    const { body, query = {} } = options;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, value);
      }
    }
    const search = params.size > 0 ? `?${params}` : '';
    const hasBody = body !== undefined;
    const response = await fetch(`/v1${path}${search}`, {
      method,
      credentials: 'same-origin',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw await toError(response);
    }
    if (response.status === 204) {
      return undefined as Result;
    }
    try {
      return (await response.json()) as Result;
    } catch {
      throw unexpectedResponse(response);
    }
  }

  return {
    login: (body) => request('POST', '/auth/login', { body }),
    logout: () => request('POST', '/auth/logout'),
    getCurrentStaffMember: () => request('GET', '/auth/me'),
    listStaff: () => request('GET', '/staff'),
    createStaffMember: (body) => request('POST', '/staff', { body }),
    updateStaffMember: (id, body) => request('PATCH', `/staff/${encodeURIComponent(id)}`, { body }),
    searchClients: (q) => request('GET', '/clients', { query: { q } }),
    createClient: (body) => request('POST', '/clients', { body }),
    getClient: (id) => request('GET', `/clients/${encodeURIComponent(id)}`),
    getDayView: ({ date, staffId }) => request('GET', '/appointments', { query: { date, staffId } }),
    createAppointment: (body) => request('POST', '/appointments', { body }),
    getAppointment: (id) => request('GET', `/appointments/${encodeURIComponent(id)}`),
    updateAppointment: (id, body) => request('PATCH', `/appointments/${encodeURIComponent(id)}`, { body }),
    confirmAppointment: (id) => request('POST', `/appointments/${encodeURIComponent(id)}/confirm`),
    cancelAppointment: (id) => request('POST', `/appointments/${encodeURIComponent(id)}/cancel`),
    recordAppointmentOutcome: (id, body) =>
      request('POST', `/appointments/${encodeURIComponent(id)}/outcome`, { body }),
    undoAppointmentOutcome: (id) => request('POST', `/appointments/${encodeURIComponent(id)}/undo-outcome`),
    regenerateAppointmentLink: (id) => request('POST', `/appointments/${encodeURIComponent(id)}/link`),
    getSettings: () => request('GET', '/settings'),
    updateSettings: (body) => request('PATCH', '/settings', { body }),
    getPublicAppointment: (token) => request('GET', `/public/appointments/${encodeURIComponent(token)}`),
    confirmPublicAppointment: (token) => request('POST', `/public/appointments/${encodeURIComponent(token)}/confirm`),
    cancelPublicAppointment: (token) => request('POST', `/public/appointments/${encodeURIComponent(token)}/cancel`),
  };
}
