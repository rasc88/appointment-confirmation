import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import type { ApiService } from './api-service';
import { createHttpApi } from './http-api';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface ErrorBody {
  code: string;
  message: string;
  field?: string;
}

function errorResponse(status: number, error: ErrorBody) {
  return jsonResponse({ error }, status);
}

function lastRequest() {
  const [url, init] = fetchMock.mock.lastCall!;
  return { url: String(url), init: init! };
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => jsonResponse({ ok: true }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const login = { email: 'alex@demo.test', password: 'demo1234' };
const staffBody = { name: 'Kim', email: 'kim@demo.test', password: 'secret123' };
const appointmentBody = { clientId: 'c1', staffMemberId: 's1', service: 'Haircut', startsAt: '2026-11-12T10:00:00.000Z' };

const operations: [keyof ApiService, (api: ApiService) => Promise<unknown>, string, string, unknown][] = [
  ['login', (api) => api.login(login), 'POST', '/v1/auth/login', login],
  ['logout', (api) => api.logout(), 'POST', '/v1/auth/logout', undefined],
  ['getCurrentStaffMember', (api) => api.getCurrentStaffMember(), 'GET', '/v1/auth/me', undefined],
  ['listStaff', (api) => api.listStaff(), 'GET', '/v1/staff', undefined],
  ['createStaffMember', (api) => api.createStaffMember(staffBody), 'POST', '/v1/staff', staffBody],
  ['updateStaffMember', (api) => api.updateStaffMember('s1', { isActive: false }), 'PATCH', '/v1/staff/s1', { isActive: false }],
  ['searchClients', (api) => api.searchClients('ana'), 'GET', '/v1/clients?q=ana', undefined],
  ['createClient', (api) => api.createClient({ name: 'Ana', phone: null }), 'POST', '/v1/clients', { name: 'Ana', phone: null }],
  ['getClient', (api) => api.getClient('c1'), 'GET', '/v1/clients/c1', undefined],
  ['getDayView', (api) => api.getDayView({ date: '2026-11-12' }), 'GET', '/v1/appointments?date=2026-11-12', undefined],
  ['createAppointment', (api) => api.createAppointment(appointmentBody), 'POST', '/v1/appointments', appointmentBody],
  ['getAppointment', (api) => api.getAppointment('a1'), 'GET', '/v1/appointments/a1', undefined],
  ['updateAppointment', (api) => api.updateAppointment('a1', { service: 'Color' }), 'PATCH', '/v1/appointments/a1', { service: 'Color' }],
  ['confirmAppointment', (api) => api.confirmAppointment('a1'), 'POST', '/v1/appointments/a1/confirm', undefined],
  ['cancelAppointment', (api) => api.cancelAppointment('a1'), 'POST', '/v1/appointments/a1/cancel', undefined],
  [
    'recordAppointmentOutcome',
    (api) => api.recordAppointmentOutcome('a1', { outcome: 'no_show' }),
    'POST',
    '/v1/appointments/a1/outcome',
    { outcome: 'no_show' },
  ],
  ['undoAppointmentOutcome', (api) => api.undoAppointmentOutcome('a1'), 'POST', '/v1/appointments/a1/undo-outcome', undefined],
  ['regenerateAppointmentLink', (api) => api.regenerateAppointmentLink('a1'), 'POST', '/v1/appointments/a1/link', undefined],
  ['getSettings', (api) => api.getSettings(), 'GET', '/v1/settings', undefined],
  ['updateSettings', (api) => api.updateSettings({ noShowThreshold: 2 }), 'PATCH', '/v1/settings', { noShowThreshold: 2 }],
  ['getPublicAppointment', (api) => api.getPublicAppointment('tok'), 'GET', '/v1/public/appointments/tok', undefined],
  ['confirmPublicAppointment', (api) => api.confirmPublicAppointment('tok'), 'POST', '/v1/public/appointments/tok/confirm', undefined],
  ['cancelPublicAppointment', (api) => api.cancelPublicAppointment('tok'), 'POST', '/v1/public/appointments/tok/cancel', undefined],
];

describe('createHttpApi requests', () => {
  it('covers every ApiService method', () => {
    expect(operations.map(([name]) => name).sort()).toEqual(Object.keys(createHttpApi()).sort());
    expect(operations).toHaveLength(23);
  });

  it.each(operations)('%s sends its method and path', async (_name, call, method, url, body) => {
    await call(createHttpApi());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url: sentUrl, init } = lastRequest();
    expect(init.method).toBe(method);
    expect(sentUrl).toBe(url);
    expect(init.credentials).toBe('same-origin');
    if (body === undefined) {
      expect(init.body).toBeUndefined();
      expect(new Headers(init.headers).has('Content-Type')).toBe(false);
    } else {
      expect(init.body).toBe(JSON.stringify(body));
      expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    }
  });

  it('encodes ids and tokens as one path segment', async () => {
    const api = createHttpApi();

    await api.confirmAppointment('a/b?c=d#e');
    expect(lastRequest().url).toBe('/v1/appointments/a%2Fb%3Fc%3Dd%23e/confirm');
    await api.getPublicAppointment('../x?y');
    expect(lastRequest().url).toBe('/v1/public/appointments/..%2Fx%3Fy');
  });

  it.each([
    [undefined, '/v1/clients'],
    ['an a', '/v1/clients?q=an+a'],
    ['', '/v1/clients?q='],
    ['a&b=c', '/v1/clients?q=a%26b%3Dc'],
  ])('searchClients(%j) sends %s', async (q, url) => {
    await createHttpApi().searchClients(q);

    expect(lastRequest().url).toBe(url);
  });

  it.each([
    [{}, '/v1/appointments'],
    [{ date: '2026-11-12' }, '/v1/appointments?date=2026-11-12'],
    [{ staffId: 's1' }, '/v1/appointments?staffId=s1'],
    [{ date: undefined, staffId: 's1' }, '/v1/appointments?staffId=s1'],
    [{ date: '2026-11-12', staffId: 's1' }, '/v1/appointments?date=2026-11-12&staffId=s1'],
  ])('getDayView(%j) sends %s', async (params, url) => {
    await createHttpApi().getDayView(params);

    expect(lastRequest().url).toBe(url);
  });

  it('works when a method is called detached from the object', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ service: 'Haircut' }));
    const { getPublicAppointment } = createHttpApi();

    await expect(getPublicAppointment('tok')).resolves.toEqual({ service: 'Haircut' });
  });
});

describe('createHttpApi responses', () => {
  it('resolves a 2xx with the parsed JSON body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'a1', status: 'confirmed' }));

    await expect(createHttpApi().confirmAppointment('a1')).resolves.toEqual({ id: 'a1', status: 'confirmed' });
  });

  it('resolves a 204 with undefined without reading the body', async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    fetchMock.mockResolvedValue(response);

    await expect(createHttpApi().logout()).resolves.toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    [401, { code: 'unauthenticated', message: 'Sign in to continue.' }],
    [404, { code: 'not_found', message: 'Not found.' }],
    [409, { code: 'email_taken', message: 'Another staff account already has this email.' }],
    [422, { code: 'validation_error', message: 'Enter a valid date and time.', field: 'startsAt' }],
    [429, { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' }],
  ] as [number, ErrorBody][])('rejects a %i error envelope with ApiError', async (status, error) => {
    fetchMock.mockResolvedValue(errorResponse(status, error));

    const caught = await createHttpApi().listStaff().catch((reason: unknown) => reason);

    expect(caught).toBeInstanceOf(ApiError);
    expect(caught).toMatchObject({ status, code: error.code, message: error.message, field: error.field });
    expect((caught as ApiError).field).toBe(error.field);
  });

  it.each([
    ['a 502 with an HTML body', () => new Response('<html>Bad gateway</html>', { status: 502 }), 502],
    ['a 404 with an empty body', () => new Response(null, { status: 404 }), 404],
    ['a 500 with invalid JSON', () => new Response('{"error":', { status: 500 }), 500],
    ['a 404 with JSON that is not the envelope', () => jsonResponse({ message: 'nope' }, 404), 404],
    ['a 422 with a non-string field', () => jsonResponse({ error: { code: 'validation_error', message: 'x', field: 3 } }, 422), 422],
    ['a 200 that is not JSON', () => new Response('<html></html>', { status: 200 }), 200],
  ])('rejects %s with a plain Error naming the status', async (_case, response, status) => {
    fetchMock.mockResolvedValue(response());

    const caught = await createHttpApi().getSettings().catch((reason: unknown) => reason);

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ApiError);
    expect((caught as Error).message).toContain(String(status));
  });

  it('passes a fetch rejection through unchanged', async () => {
    const networkError = new TypeError('Failed to fetch');
    fetchMock.mockRejectedValue(networkError);

    await expect(createHttpApi().getSettings()).rejects.toBe(networkError);
  });
});
