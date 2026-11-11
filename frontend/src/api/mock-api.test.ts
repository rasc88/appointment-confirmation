import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { buildDemoData, type DemoData } from './demo-data';
import type { ApiService } from './api-service';
import type { CreateAppointmentRequest, DayAppointment, UpdateSettingsRequest } from './types';
import { createMockApi } from './mock-api';

vi.mock('./demo-data', { spy: true });

const now = new Date('2026-11-10T10:07:00Z');

/** The store the mock was built from, so tests can check fields `PublicAppointment` leaves out. */
function createMockApiWithStore() {
  const api = createMockApi({ now });
  const store = vi.mocked(buildDemoData).mock.results.at(-1)?.value as DemoData;
  const byToken = (token: string) => store.appointments.find((appointment) => appointment.token === token)!;
  return { api, byToken, store };
}

describe('createMockApi', () => {
  it('signs in with the email in any case', async () => {
    const api = createMockApi();

    const staffMember = await api.login({ email: 'ALEX@demo.test', password: 'demo1234' });

    expect(staffMember.name).toBe('Alex');
    expect(staffMember).not.toHaveProperty('password');
  });

  it('rejects a wrong password with 401 invalid_credentials', async () => {
    const api = createMockApi();

    const error = await api.login({ email: 'alex@demo.test', password: 'wrong' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_credentials', message: 'Email or password is incorrect.' });
  });

  it('returns the current staff member only after sign-in', async () => {
    const api = createMockApi();

    await expect(api.getCurrentStaffMember()).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
      message: 'Sign in to continue.',
    });
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });

    await expect(api.getCurrentStaffMember()).resolves.toMatchObject({ name: 'Alex', email: 'alex@demo.test' });
  });

  it('resolves logout when nobody is signed in', async () => {
    await expect(createMockApi().logout()).resolves.toBeUndefined();
  });

  it('forgets the staff member on logout', async () => {
    const api = createMockApi();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });

    await api.logout();

    await expect(api.getCurrentStaffMember()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('does not share the signed-in staff member between instances', async () => {
    const first = createMockApi();
    const second = createMockApi();

    await first.login({ email: 'alex@demo.test', password: 'demo1234' });

    await expect(second.getCurrentStaffMember()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects operations later issues implement', async () => {
    await expect(createMockApi().updateAppointment('unknown', {})).rejects.toThrow('Not implemented in mock: updateAppointment');
  });
});

describe('createMockApi public operations', () => {
  it('returns exactly the PublicAppointment fields', async () => {
    const appointment = await createMockApi({ now }).getPublicAppointment('demo-1');

    expect(Object.keys(appointment).sort()).toEqual(
      ['businessName', 'durationMinutes', 'hasStarted', 'service', 'staffName', 'startsAt', 'status', 'timeZone'],
    );
    expect(appointment).toEqual({
      businessName: 'Demo Studio',
      timeZone: 'Europe/Madrid',
      service: 'Haircut',
      staffName: 'Alex',
      startsAt: '2026-11-10T12:00:00.000Z',
      durationMinutes: 30,
      status: 'pending',
      hasStarted: false,
    });
  });

  it.each(['demo-99', '', 'DEMO-1'])('rejects the unknown token %j with 404 for every operation', async (token) => {
    const api = createMockApi({ now });

    for (const operation of [api.getPublicAppointment, api.confirmPublicAppointment, api.cancelPublicAppointment]) {
      const error = await operation(token).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 404, code: 'not_found', message: 'This link is not valid.' });
    }
  });

  it('sets hasStarted from now against the start time', async () => {
    const api = createMockApi({ now });

    await expect(api.getPublicAppointment('demo-1')).resolves.toMatchObject({ hasStarted: false });
    await expect(api.getPublicAppointment('demo-9')).resolves.toMatchObject({ hasStarted: true });
  });

  it('reads the clock on each call when no now is given', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const api = createMockApi();
      await expect(api.getPublicAppointment('demo-1')).resolves.toMatchObject({ hasStarted: false });

      vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));

      await expect(api.getPublicAppointment('demo-1')).resolves.toMatchObject({ hasStarted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirms a pending appointment as the client, and the next read shows it', async () => {
    const { api, byToken } = createMockApiWithStore();

    const confirmed = await api.confirmPublicAppointment('demo-1');

    expect(confirmed).toMatchObject({ status: 'confirmed', hasStarted: false });
    expect(byToken('demo-1')).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'client',
      statusChangedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await expect(api.getPublicAppointment('demo-1')).resolves.toMatchObject({ status: 'confirmed' });
  });

  it('leaves an already confirmed appointment unchanged on confirm', async () => {
    const { api, byToken } = createMockApiWithStore();
    const before = structuredClone(byToken('demo-4'));

    await expect(api.confirmPublicAppointment('demo-4')).resolves.toMatchObject({ status: 'confirmed' });

    expect(byToken('demo-4')).toEqual(before);
  });

  it.each([
    ['confirmPublicAppointment', 'demo-5', 'invalid_transition', 'This appointment can no longer be changed.'],
    ['confirmPublicAppointment', 'demo-7', 'invalid_transition', 'This appointment can no longer be changed.'],
    ['confirmPublicAppointment', 'demo-9', 'appointment_started', 'This appointment has already started.'],
    ['cancelPublicAppointment', 'demo-5', 'invalid_transition', 'This appointment can no longer be changed.'],
    ['cancelPublicAppointment', 'demo-9', 'appointment_started', 'This appointment has already started.'],
  ] as const)('%s on %s rejects with 409 %s', async (operation, token, code, message) => {
    const { api, byToken } = createMockApiWithStore();
    const before = structuredClone(byToken(token));

    const error = await api[operation](token).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code, message });
    expect(byToken(token)).toEqual(before);
  });

  it.each([
    ['pending', 'demo-1', null],
    ['confirmed', 'demo-3', 'client'],
  ])('cancels a %s appointment as the client and keeps confirmedBy', async (_status, token, confirmedBy) => {
    const { api, byToken } = createMockApiWithStore();

    await expect(api.cancelPublicAppointment(token)).resolves.toMatchObject({ status: 'cancelled' });

    expect(byToken(token)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'client',
      confirmedBy,
      statusChangedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  });
});

async function signedInMockApi(options?: { now?: Date }) {
  const api = createMockApi({ now, ...options });
  await api.login({ email: 'alex@demo.test', password: 'demo1234' });
  return api;
}

function summary(appointments: DayAppointment[]) {
  return appointments.map(({ startsAt, client, status }) => [startsAt, client.name, status]);
}

describe('createMockApi staff list and day view', () => {
  it.each(['listStaff', 'getDayView'] as const)('rejects %s with 401 when nobody is signed in', async (operation) => {
    const api = createMockApi({ now });

    const error = await api[operation]({}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it.each(['listStaff', 'getDayView'] as const)('rejects %s with 401 when the signed-in staff member is inactive', async (operation) => {
    const api = createMockApi({ now });
    const store = vi.mocked(buildDemoData).mock.results.at(-1)?.value as DemoData;
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    store.staff[0].isActive = false;

    await expect(api[operation]({})).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('lists every staff account, active and inactive, without passwords', async () => {
    const api = createMockApi({ now });
    const store = vi.mocked(buildDemoData).mock.results.at(-1)?.value as DemoData;
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    store.staff[1].isActive = false;

    const staff = await api.listStaff();

    expect(staff.map(({ name, isActive }) => [name, isActive])).toEqual([
      ['Alex', true],
      ['Sam', false],
    ]);
    for (const staffMember of staff) {
      expect(Object.keys(staffMember).sort()).toEqual(['createdAt', 'email', 'id', 'isActive', 'name']);
    }
  });

  it('returns today in the business time zone, sorted by start time', async () => {
    const api = await signedInMockApi();

    const dayView = await api.getDayView({});

    expect(dayView.date).toBe('2026-11-10');
    expect(dayView.timeZone).toBe('Europe/Madrid');
    expect(summary(dayView.appointments)).toEqual([
      ['2026-11-10T07:00:00.000Z', 'Grace Lee', 'attended'],
      ['2026-11-10T08:00:00.000Z', 'Elena Sousa', 'no_show'],
      ['2026-11-10T09:00:00.000Z', 'Ben Carter', 'pending'],
      ['2026-11-10T12:00:00.000Z', 'Ana Torres', 'pending'],
      ['2026-11-10T13:00:00.000Z', 'Chloe Martin', 'confirmed'],
      ['2026-11-10T14:00:00.000Z', 'Grace Lee', 'cancelled'],
      ['2026-11-10T15:00:00.000Z', 'Felix Novak', 'pending'],
    ]);
  });

  it('decides the day in the business time zone on the DST change day', async () => {
    const api = await signedInMockApi({ now: new Date('2026-10-24T23:30:00Z') });

    const dayView = await api.getDayView({});

    expect(dayView.date).toBe('2026-10-25');
    const starts = dayView.appointments.map((appointment) => appointment.startsAt);
    expect(starts).toContain('2026-10-24T22:30:00.000Z');
    expect(starts).not.toContain('2026-10-24T21:30:00.000Z');
  });

  it('returns the requested day, or an empty list for a day without appointments', async () => {
    const api = await signedInMockApi();

    const tomorrow = await api.getDayView({ date: '2026-11-11' });

    expect(tomorrow.date).toBe('2026-11-11');
    expect(summary(tomorrow.appointments)).toEqual([
      ['2026-11-11T11:00:00.000Z', 'Elena Sousa', 'confirmed'],
      ['2026-11-11T12:00:00.000Z', 'Ben Carter', 'pending'],
      ['2026-11-11T13:00:00.000Z', 'David Ruiz', 'confirmed'],
      ['2026-11-11T14:00:00.000Z', 'Hugo Blanc', 'cancelled'],
    ]);
    await expect(api.getDayView({ date: '2026-11-12' })).resolves.toEqual({
      date: '2026-11-12',
      timeZone: 'Europe/Madrid',
      appointments: [],
    });
  });

  it('filters by staff member, and an unknown staff id returns an empty list', async () => {
    const api = await signedInMockApi();
    const sam = (await api.listStaff()).find((staffMember) => staffMember.name === 'Sam')!;

    const samDay = await api.getDayView({ staffId: sam.id });

    expect(summary(samDay.appointments)).toEqual([['2026-11-10T07:00:00.000Z', 'Grace Lee', 'attended']]);
    const unknown = await api.getDayView({ staffId: '00000000-0000-4000-8000-000000000000' });
    expect(unknown.appointments).toEqual([]);
  });

  it.each(['10/11/2026', '2026-13-01', '2026-02-30'])('rejects the malformed date %j with 422', async (date) => {
    const api = await signedInMockApi();

    const error = await api.getDayView({ date }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'validation_error', field: 'date' });
  });

  it('rejects a malformed staffId with 422', async () => {
    const api = await signedInMockApi();

    await expect(api.getDayView({ staffId: 'abc' })).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
      field: 'staffId',
    });
  });

  it('returns exactly the DayAppointment fields with the client and staff member embedded', async () => {
    const api = await signedInMockApi();

    const { appointments } = await api.getDayView({});
    const ana = appointments.find((appointment) => appointment.client.name === 'Ana Torres')!;

    expect(Object.keys(ana).sort()).toEqual([
      'atRiskReasons',
      'cancelledBy',
      'client',
      'confirmedBy',
      'createdAt',
      'durationMinutes',
      'id',
      'isLateCancellation',
      'service',
      'staffMember',
      'startsAt',
      'status',
      'statusChangedAt',
      'updatedAt',
    ]);
    expect(Object.keys(ana.client).sort()).toEqual(['id', 'name', 'phone']);
    expect(Object.keys(ana.staffMember).sort()).toEqual(['id', 'name']);
    expect(ana).toMatchObject({ client: { name: 'Ana Torres', phone: '+34 600 000 000' }, staffMember: { name: 'Alex' } });
  });

  it('carries the fixed at-risk reasons and late-cancellation flag from the demo data', () => {
    const data = buildDemoData(now);
    const byToken = (token: string) => data.appointments.find((appointment) => appointment.token === token)!;

    expect(byToken('demo-1').atRiskReasons).toEqual([{ code: 'no_reply' }]);
    expect(byToken('demo-10').atRiskReasons).toEqual([{ code: 'no_show_history', noShowCount: 1 }]);
    expect(byToken('demo-13').atRiskReasons).toEqual([{ code: 'no_reply' }, { code: 'no_show_history', noShowCount: 2 }]);
    expect(byToken('demo-5').isLateCancellation).toBe(true);
    for (const appointment of data.appointments) {
      if (!['demo-1', 'demo-10', 'demo-13'].includes(appointment.token)) {
        expect(appointment.atRiskReasons).toEqual([]);
      }
      if (appointment.token !== 'demo-5') {
        expect(appointment.isLateCancellation).toBe(false);
      }
    }
  });

  it('returns the reasons and flag at the test now', async () => {
    const api = await signedInMockApi();

    const today = await api.getDayView({});
    const tomorrow = await api.getDayView({ date: '2026-11-11' });

    expect(
      [...today.appointments, ...tomorrow.appointments]
        .filter((appointment) => appointment.atRiskReasons.length > 0 || appointment.isLateCancellation)
        .map(({ client, atRiskReasons, isLateCancellation }) => [client.name, atRiskReasons, isLateCancellation]),
    ).toEqual([
      ['Ana Torres', [{ code: 'no_reply' }], false],
      ['Grace Lee', [], true],
      ['Felix Novak', [{ code: 'no_reply' }, { code: 'no_show_history', noShowCount: 2 }], false],
      ['Elena Sousa', [{ code: 'no_show_history', noShowCount: 1 }], false],
    ]);
  });

  it('drops no_reply once the client confirms', async () => {
    const api = await signedInMockApi();

    await api.confirmPublicAppointment('demo-1');

    const { appointments } = await api.getDayView({});
    expect(appointments.find((appointment) => appointment.client.name === 'Ana Torres')).toMatchObject({
      status: 'confirmed',
      atRiskReasons: [],
    });
  });

  it('keeps no_show_history on a confirmed appointment, and drops every reason once the appointment has started', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    try {
      const api = createMockApi();
      await api.login({ email: 'alex@demo.test', password: 'demo1234' });

      vi.setSystemTime(new Date('2026-11-10T15:00:00Z'));

      const today = await api.getDayView({});
      expect(today.appointments.find((appointment) => appointment.client.name === 'Felix Novak')).toMatchObject({
        status: 'pending',
        atRiskReasons: [],
      });
      const tomorrow = await api.getDayView({ date: '2026-11-11' });
      expect(tomorrow.appointments[0]).toMatchObject({
        client: { name: 'Elena Sousa' },
        status: 'confirmed',
        atRiskReasons: [{ code: 'no_show_history', noShowCount: 1 }],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the late-cancellation flag from a row that is not cancelled', async () => {
    const { api, byToken } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    byToken('demo-3').isLateCancellation = true;

    const { appointments } = await api.getDayView({});

    expect(appointments.find((appointment) => appointment.client.name === 'Chloe Martin')?.isLateCancellation).toBe(false);
  });

  it('does not let a change to a returned object reach the next response', async () => {
    const api = await signedInMockApi();
    const first = await api.getDayView({});

    first.appointments[3].client.name = 'Changed';
    first.appointments[3].atRiskReasons.push({ code: 'no_show_history', noShowCount: 9 });
    first.appointments.pop();

    const second = await api.getDayView({});
    expect(second.appointments).toHaveLength(7);
    expect(second.appointments[3]).toMatchObject({ client: { name: 'Ana Torres' }, atRiskReasons: [{ code: 'no_reply' }] });
  });
});

function validationField(field: string) {
  return { status: 422, code: 'validation_error', field };
}

describe('createMockApi settings, clients and appointments', () => {
  it.each([
    ['getSettings', (api: ApiService) => api.getSettings()],
    ['searchClients', (api: ApiService) => api.searchClients('')],
    ['createClient', (api: ApiService) => api.createClient({ name: '' })],
    ['createAppointment', (api: ApiService) => api.createAppointment({ clientId: '', staffMemberId: '', service: '', startsAt: '' })],
    ['getAppointment', (api: ApiService) => api.getAppointment('unknown')],
    ['getClient', (api: ApiService) => api.getClient('unknown')],
  ])('rejects %s with 401 before any other check when nobody is signed in', async (_operation, call) => {
    const error = await call(createMockApi({ now })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('returns the demo settings as a copy', async () => {
    const api = await signedInMockApi();

    const settings = await api.getSettings();
    settings.businessName = 'Changed';

    await expect(api.getSettings()).resolves.toMatchObject({
      businessName: 'Demo Studio',
      timeZone: 'Europe/Madrid',
      defaultDurationMinutes: 30,
      noReplyWindowHours: 24,
    });
  });

  it.each([
    ['ana', ['Ana Torres']],
    ['000 020', ['Chloe Martin']],
    ['RUIZ', ['David Ruiz']],
  ])('finds clients matching %j by name or phone', async (q, names) => {
    const api = await signedInMockApi();

    const clients = await api.searchClients(q);

    expect(clients.map((client) => client.name)).toEqual(names);
  });

  it('does not match a null phone', async () => {
    const api = await signedInMockApi();

    const clients = await api.searchClients('+34');

    expect(clients.map((client) => client.name)).not.toContain('David Ruiz');
    expect(clients).toHaveLength(7);
  });

  it('returns at most 20 clients sorted by name without q', async () => {
    const api = await signedInMockApi();
    for (let index = 0; index < 17; index += 1) {
      await api.createClient({ name: `Zed ${String(index).padStart(2, '0')}` });
    }

    const clients = await api.searchClients();

    const names = clients.map((client) => client.name);
    expect(names).toHaveLength(20);
    expect(names.slice(0, 8)).toEqual([
      'Ana Torres',
      'Ben Carter',
      'Chloe Martin',
      'David Ruiz',
      'Elena Sousa',
      'Felix Novak',
      'Grace Lee',
      'Hugo Blanc',
    ]);
    expect(names.slice(8)).toEqual(Array.from({ length: 12 }, (_, index) => `Zed ${String(index).padStart(2, '0')}`));
  });

  it.each(['', 'x'.repeat(81)])('rejects the search %j with 422 on q', async (q) => {
    const api = await signedInMockApi();

    await expect(api.searchClients(q)).rejects.toMatchObject(validationField('q'));
  });

  it('creates a client that search finds afterwards', async () => {
    const api = await signedInMockApi();

    const client = await api.createClient({ name: 'Iris Moreau', phone: '+33 (0) 6-12' });

    expect(client).toEqual({ id: expect.any(String), name: 'Iris Moreau', phone: '+33 (0) 6-12', createdAt: now.toISOString() });
    await expect(api.searchClients('iris')).resolves.toEqual([client]);
  });

  it.each([undefined, null])('stores a phone of %j as null', async (phone) => {
    const api = await signedInMockApi();

    await expect(api.createClient({ name: 'Iris Moreau', phone })).resolves.toMatchObject({ phone: null });
  });

  it.each([
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(81) }, 'name'],
    [{ name: 'Iris', phone: 'abc' }, 'phone'],
    [{ name: 'Iris', phone: '' }, 'phone'],
    [{ name: 'Iris', phone: '1'.repeat(31) }, 'phone'],
  ])('rejects the client %j with 422 on %s', async (body, field) => {
    const api = await signedInMockApi();

    await expect(api.createClient(body)).rejects.toMatchObject(validationField(field));
  });
});

async function validAppointmentRequest(api: ApiService): Promise<CreateAppointmentRequest> {
  const [ana] = await api.searchClients('Ana Torres');
  const alex = (await api.listStaff()).find((staffMember) => staffMember.name === 'Alex')!;
  return { clientId: ana.id, staffMemberId: alex.id, service: 'Haircut', startsAt: '2026-11-10T17:00:00.000Z', durationMinutes: 45 };
}

describe('createMockApi createAppointment and getAppointment', () => {
  it('creates a pending appointment and returns it with its link and message', async () => {
    const { api, store } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    const body = await validAppointmentRequest(api);

    const created = await api.createAppointment(body);

    const stored = store.appointments.at(-1)!;
    expect(stored).toMatchObject({
      clientId: body.clientId,
      staffMemberId: body.staffMemberId,
      status: 'pending',
      atRiskReasons: [],
      isLateCancellation: false,
    });
    expect(stored.token).not.toMatch(/^demo-/);
    expect(Object.keys(created.appointment).sort()).toEqual([
      'cancelledBy',
      'client',
      'confirmedBy',
      'createdAt',
      'durationMinutes',
      'id',
      'service',
      'staffMember',
      'startsAt',
      'status',
      'statusChangedAt',
      'updatedAt',
    ]);
    expect(created.appointment).toEqual({
      id: stored.id,
      client: { id: body.clientId, name: 'Ana Torres', phone: '+34 600 000 000' },
      staffMember: { id: body.staffMemberId, name: 'Alex' },
      service: 'Haircut',
      startsAt: '2026-11-10T17:00:00.000Z',
      durationMinutes: 45,
      status: 'pending',
      confirmedBy: null,
      cancelledBy: null,
      statusChangedAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(created.confirmationLink).toBe(`${window.location.origin}/c/${stored.token}`);
    expect(created.message).toBe(`Please confirm your appointment: ${created.confirmationLink}`);
  });

  it('gives each appointment a new token', async () => {
    const api = await signedInMockApi();
    const body = await validAppointmentRequest(api);

    const first = await api.createAppointment(body);
    const second = await api.createAppointment(body);

    expect(first.confirmationLink).not.toBe(second.confirmationLink);
  });

  it('defaults the duration to the settings value', async () => {
    const api = await signedInMockApi();
    const body = await validAppointmentRequest(api);
    delete body.durationMinutes;

    const created = await api.createAppointment(body);

    expect(created.appointment.durationMinutes).toBe(30);
  });

  it('shows the new appointment in the day view, on the client page and by id', async () => {
    const api = await signedInMockApi();

    const { appointment, confirmationLink } = await api.createAppointment(await validAppointmentRequest(api));

    const { appointments } = await api.getDayView({ date: '2026-11-10' });
    expect(appointments.find((entry) => entry.id === appointment.id)).toMatchObject({
      status: 'pending',
      atRiskReasons: [],
      isLateCancellation: false,
    });
    const token = confirmationLink.split('/c/')[1];
    await expect(api.getPublicAppointment(token)).resolves.toMatchObject({ service: 'Haircut', status: 'pending' });
    await expect(api.getAppointment(appointment.id)).resolves.toEqual(appointment);
  });

  it.each([
    ['an unknown clientId', { clientId: 'unknown' }, 'clientId'],
    ['an unknown staffMemberId', { staffMemberId: '00000000-0000-4000-8000-000000000000' }, 'staffMemberId'],
    ['an empty service', { service: '' }, 'service'],
    ['a service over 80 characters', { service: 'x'.repeat(81) }, 'service'],
    ['a malformed startsAt', { startsAt: '2026-11-10 18:00' }, 'startsAt'],
    ['a startsAt equal to now', { startsAt: now.toISOString() }, 'startsAt'],
    ['a startsAt in the past', { startsAt: '2026-11-10T09:00:00.000Z' }, 'startsAt'],
    ['a duration under 5', { durationMinutes: 4 }, 'durationMinutes'],
    ['a duration over 480', { durationMinutes: 481 }, 'durationMinutes'],
    ['a fractional duration', { durationMinutes: 30.5 }, 'durationMinutes'],
    ['an unknown clientId and an empty service', { clientId: 'unknown', service: '' }, 'clientId'],
    ['an empty service and a past startsAt', { service: '', startsAt: '2026-11-10T09:00:00.000Z' }, 'service'],
    ['a past startsAt and a bad duration', { startsAt: '2026-11-10T09:00:00.000Z', durationMinutes: 1 }, 'startsAt'],
  ])('rejects %s with 422 on the first failing field', async (_case, change, field) => {
    const { api, store } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    const count = store.appointments.length;

    const error = await api
      .createAppointment({ ...(await validAppointmentRequest(api)), ...change })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject(validationField(field));
    expect(store.appointments).toHaveLength(count);
  });

  it('rejects an inactive staff member with 422 on staffMemberId', async () => {
    const { api, store } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    const body = await validAppointmentRequest(api);
    store.staff[1].isActive = false;

    await expect(api.createAppointment({ ...body, staffMemberId: store.staff[1].id })).rejects.toMatchObject(
      validationField('staffMemberId'),
    );
  });

  it.each([
    ['pending', 'demo-1'],
    ['cancelled', 'demo-5'],
  ])('returns a %s appointment by id in the Appointment shape', async (status, token) => {
    const { api, byToken } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });

    const appointment = await api.getAppointment(byToken(token).id);

    expect(appointment).toMatchObject({ id: byToken(token).id, status });
    expect(appointment).not.toHaveProperty('atRiskReasons');
    expect(appointment).not.toHaveProperty('isLateCancellation');
    expect(appointment).not.toHaveProperty('token');
    expect(appointment).not.toHaveProperty('clientId');
  });

  it.each(['unknown', '', '00000000-0000-4000-8000-000000000000'])('rejects the unknown id %j with 404', async (id) => {
    const api = await signedInMockApi();

    const error = await api.getAppointment(id).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found' });
  });
});

describe('createMockApi getClient', () => {
  async function signedInWithStore() {
    const { api, byToken, store } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    const clientId = (name: string) => store.clients.find((client) => client.name === name)!.id;
    return { api, byToken, clientId };
  }

  it.each(['unknown', '', '00000000-0000-4000-8000-000000000000'])('rejects the unknown id %j with 404', async (id) => {
    const api = await signedInMockApi();

    const error = await api.getClient(id).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, code: 'not_found', message: 'Not found.' });
  });

  it('returns exactly the ClientDetail and Appointment keys', async () => {
    const { api, clientId } = await signedInWithStore();

    const detail = await api.getClient(clientId('Felix Novak'));

    expect(Object.keys(detail).sort()).toEqual(['appointments', 'createdAt', 'id', 'name', 'noShowCount', 'phone']);
    expect(detail).toMatchObject({ id: clientId('Felix Novak'), name: 'Felix Novak', phone: '+34 600 000 050', createdAt: now.toISOString() });
    for (const appointment of detail.appointments) {
      expect(Object.keys(appointment).sort()).toEqual([
        'cancelledBy',
        'client',
        'confirmedBy',
        'createdAt',
        'durationMinutes',
        'id',
        'service',
        'staffMember',
        'startsAt',
        'status',
        'statusChangedAt',
        'updatedAt',
      ]);
      await expect(api.getAppointment(appointment.id)).resolves.toEqual(appointment);
    }
  });

  it('returns a copy', async () => {
    const { api, clientId } = await signedInWithStore();
    const first = await api.getClient(clientId('Felix Novak'));
    const expected = structuredClone(first);

    first.name = 'Changed';
    first.noShowCount = 9;
    first.appointments[0].service = 'Changed';
    first.appointments[0].client.name = 'Changed';
    first.appointments.pop();

    await expect(api.getClient(clientId('Felix Novak'))).resolves.toEqual(expected);
  });

  it('lists every appointment of the client newest first', async () => {
    const { api, byToken, clientId } = await signedInWithStore();

    const { appointments } = await api.getClient(clientId('Felix Novak'));

    expect(appointments.map((appointment) => appointment.id)).toEqual(['demo-13', 'demo-11', 'demo-12'].map((token) => byToken(token).id));
  });

  it('orders appointments that start at the same instant by id', async () => {
    const api = await signedInMockApi();
    const client = await api.createClient({ name: 'Iris Moreau' });
    const body = { ...(await validAppointmentRequest(api)), clientId: client.id };
    const created = [await api.createAppointment(body), await api.createAppointment(body), await api.createAppointment(body)];

    const { appointments } = await api.getClient(client.id);

    expect(appointments.map((appointment) => appointment.id)).toEqual(
      created.map(({ appointment }) => appointment.id).sort((first, second) => (first < second ? -1 : 1)),
    );
  });

  it.each([
    ['Felix Novak', 2],
    ['Elena Sousa', 1],
    ['Ana Torres', 0],
  ])('counts every no-show of %s, however old', async (name, count) => {
    const { api, clientId } = await signedInWithStore();

    await expect(api.getClient(clientId(name))).resolves.toMatchObject({ noShowCount: count });
  });

  it('includes appointments with an inactive staff member', async () => {
    const { api, byToken, clientId } = await signedInWithStore();
    const sam = (await api.listStaff()).find((staffMember) => staffMember.name === 'Sam')!;
    await api.updateStaffMember(sam.id, { isActive: false });

    const { appointments } = await api.getClient(clientId('Ben Carter'));

    expect(appointments.find((appointment) => appointment.id === byToken('demo-2').id)).toMatchObject({
      staffMember: { id: sam.id, name: 'Sam' },
    });
  });

  it('returns a new client with no appointments, then the one created for them', async () => {
    const api = await signedInMockApi();
    const client = await api.createClient({ name: 'Iris Moreau' });

    await expect(api.getClient(client.id)).resolves.toEqual({ ...client, noShowCount: 0, appointments: [] });

    const { appointment } = await api.createAppointment({ ...(await validAppointmentRequest(api)), clientId: client.id });

    await expect(api.getClient(client.id)).resolves.toEqual({ ...client, noShowCount: 0, appointments: [appointment] });
  });
});

describe('buildDemoData', () => {
  it('has the seed counts, with exactly two clients who missed a past appointment', () => {
    const now = new Date('2026-11-10T10:07:00Z');
    const data = buildDemoData(now);

    const clientsWithPastNoShow = new Set(
      data.appointments
        .filter((appointment) => appointment.status === 'no_show' && Date.parse(appointment.startsAt) < now.getTime())
        .map((appointment) => appointment.clientId),
    );

    expect(data.staff).toHaveLength(2);
    expect(data.clients).toHaveLength(8);
    expect(data.appointments).toHaveLength(13);
    expect(clientsWithPastNoShow.size).toBe(2);
  });

  it('starts offsets from now rounded down to a 15-minute mark and numbers the tokens in seed order', () => {
    const data = buildDemoData(new Date('2026-11-10T10:07:00Z'));

    expect(data.appointments[0].startsAt).toBe('2026-11-10T12:00:00.000Z');
    expect(data.appointments.map((appointment) => appointment.token)).toEqual(
      Array.from({ length: 13 }, (_, index) => `demo-${index + 1}`),
    );
  });
});

function validationMessage(field: string, message: string) {
  return { status: 422, code: 'validation_error', field, message };
}

describe('createMockApi updateSettings', () => {
  it.each([
    ['updateSettings', (api: ApiService) => api.updateSettings({})],
    ['createStaffMember', (api: ApiService) => api.createStaffMember({ name: '', email: '', password: '' })],
    ['updateStaffMember', (api: ApiService) => api.updateStaffMember('unknown', {})],
  ])('rejects %s with 401 before any other check when nobody is signed in', async (_operation, call) => {
    const error = await call(createMockApi({ now })).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('rejects an empty body with no field', async () => {
    const api = await signedInMockApi();

    const error = await api.updateSettings({}).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 422, code: 'validation_error', message: 'Change at least one setting.', field: undefined });
  });

  it.each([
    ['noReplyWindowHours', 1, 168],
    ['noShowThreshold', 1, 10],
    ['noShowLookbackDays', 7, 730],
    ['lateCancellationHours', 0, 168],
    ['defaultDurationMinutes', 5, 480],
  ] as const)('accepts %s from %i to %i only, as whole numbers', async (field, min, max) => {
    const api = await signedInMockApi();
    const message = `Must be a whole number between ${min} and ${max}.`;

    await expect(api.updateSettings({ [field]: min })).resolves.toMatchObject({ [field]: min });
    await expect(api.updateSettings({ [field]: max })).resolves.toMatchObject({ [field]: max });
    for (const value of [min - 1, max + 1, 1.5]) {
      await expect(api.updateSettings({ [field]: value })).rejects.toMatchObject(validationMessage(field, message));
    }
  });

  it.each(['', 'x'.repeat(81)])('rejects the business name %j', async (businessName) => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ businessName })).rejects.toMatchObject(
      validationMessage('businessName', 'Must be between 1 and 80 characters.'),
    );
  });

  it('counts the business name in code points', async () => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ businessName: '😀'.repeat(80) })).resolves.toMatchObject({ businessName: '😀'.repeat(80) });
  });

  it.each(['Mars/Base', 'europe/madrid', '+01:00'])('rejects the time zone %j', async (timeZone) => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ timeZone })).rejects.toMatchObject(
      validationMessage('timeZone', 'Must be an IANA time zone, for example Europe/Madrid.'),
    );
  });

  it.each(['UTC', 'America/New_York'])('accepts the time zone %j', async (timeZone) => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ timeZone })).resolves.toMatchObject({ timeZone });
  });

  it('accepts a 500-code-point template with emoji and rejects 501', async () => {
    const api = await signedInMockApi();
    const template = `{link}${'😀'.repeat(494)}`;

    await expect(api.updateSettings({ messageTemplate: template })).resolves.toMatchObject({ messageTemplate: template });
    await expect(api.updateSettings({ messageTemplate: `${template}😀` })).rejects.toMatchObject(
      validationMessage('messageTemplate', 'Must be between 1 and 500 characters.'),
    );
    await expect(api.updateSettings({ messageTemplate: '' })).rejects.toMatchObject(
      validationMessage('messageTemplate', 'Must be between 1 and 500 characters.'),
    );
  });

  it.each(['{Link}', '{ link }'])('rejects %j as an unknown placeholder', async (placeholder) => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ messageTemplate: `Hi ${placeholder} {link}` })).rejects.toMatchObject(
      validationMessage(
        'messageTemplate',
        `Unknown placeholder ${placeholder}. Allowed: {client}, {business}, {service}, {staff}, {date}, {time}, {link}.`,
      ),
    );
  });

  it('accepts a lone { as text and rejects a template without {link}', async () => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ messageTemplate: 'Reply { here: {link}' })).resolves.toMatchObject({
      messageTemplate: 'Reply { here: {link}',
    });
    await expect(api.updateSettings({ messageTemplate: 'Hi {client}' })).rejects.toMatchObject(
      validationMessage('messageTemplate', 'Must contain {link}.'),
    );
  });

  it('checks the fields in order and reports the first failure', async () => {
    const api = await signedInMockApi();
    const body: UpdateSettingsRequest = { businessName: '', timeZone: 'Mars/Base', noShowThreshold: 0, messageTemplate: '' };

    await expect(api.updateSettings(body)).rejects.toMatchObject({ field: 'businessName' });
    await expect(api.updateSettings({ ...body, businessName: 'Ok' })).rejects.toMatchObject({ field: 'timeZone' });
    await expect(api.updateSettings({ ...body, businessName: 'Ok', timeZone: 'UTC' })).rejects.toMatchObject({
      field: 'noShowThreshold',
    });
  });

  it('writes nothing when any field fails', async () => {
    const api = await signedInMockApi();

    await expect(api.updateSettings({ businessName: 'New Name', noShowThreshold: 0 })).rejects.toMatchObject({
      field: 'noShowThreshold',
    });

    await expect(api.getSettings()).resolves.toMatchObject({ businessName: 'Demo Studio', noShowThreshold: 1 });
  });

  it('writes only the fields sent and returns a copy of the full settings', async () => {
    const api = await signedInMockApi();
    const before = await api.getSettings();

    const updated = await api.updateSettings({ noReplyWindowHours: 48 });

    expect(updated).toEqual({ ...before, noReplyWindowHours: 48 });
    updated.businessName = 'Changed';
    await expect(api.getSettings()).resolves.toEqual({ ...before, noReplyWindowHours: 48 });
  });

  it('sets updatedAt to now', async () => {
    const { api, store } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    store.settings.updatedAt = '2026-01-01T00:00:00.000Z';

    await expect(api.updateSettings({ noShowThreshold: 2 })).resolves.toMatchObject({ updatedAt: now.toISOString() });
  });

  it('decides today and the day boundaries in the new time zone', async () => {
    const api = await signedInMockApi({ now: new Date('2026-11-10T03:00:00Z') });
    const body = await validAppointmentRequest(api);
    await api.createAppointment({ ...body, startsAt: '2026-11-11T02:00:00.000Z' });

    expect((await api.getDayView({ date: '2026-11-10' })).appointments.map(({ startsAt }) => startsAt)).not.toContain(
      '2026-11-11T02:00:00.000Z',
    );
    await api.updateSettings({ timeZone: 'America/New_York' });

    const today = await api.getDayView({});
    expect(today).toMatchObject({ date: '2026-11-09', timeZone: 'America/New_York' });
    expect((await api.getDayView({ date: '2026-11-10' })).appointments.map(({ startsAt }) => startsAt)).toContain(
      '2026-11-11T02:00:00.000Z',
    );
  });

  it('shows the new business name on the client page', async () => {
    const api = await signedInMockApi();

    await api.updateSettings({ businessName: 'New Studio' });

    await expect(api.getPublicAppointment('demo-1')).resolves.toMatchObject({ businessName: 'New Studio' });
  });

  it('uses the new default duration for a new appointment', async () => {
    const api = await signedInMockApi();
    const body = await validAppointmentRequest(api);
    delete body.durationMinutes;

    await api.updateSettings({ defaultDurationMinutes: 45 });

    const created = await api.createAppointment(body);
    expect(created.appointment.durationMinutes).toBe(45);
  });
});

async function staffByName(api: ApiService, name: string) {
  return (await api.listStaff()).find((staffMember) => staffMember.name === name)!;
}

describe('createMockApi createStaffMember', () => {
  const jordan = { name: 'Jordan', email: 'Jordan@Demo.test', password: 'secret123' };

  it.each([
    [{ ...jordan, name: '' }, 'name', 'Must be between 1 and 80 characters.'],
    [{ ...jordan, name: 'x'.repeat(81) }, 'name', 'Must be between 1 and 80 characters.'],
    [{ ...jordan, email: 'jordan' }, 'email', 'Enter a valid email address.'],
    [{ ...jordan, email: 'jor dan@demo.test' }, 'email', 'Enter a valid email address.'],
    [{ ...jordan, email: `${'x'.repeat(245)}@demo.test` }, 'email', 'Enter a valid email address.'],
    [{ ...jordan, password: '1234567' }, 'password', 'Must be between 8 and 72 characters.'],
    [{ ...jordan, password: 'x'.repeat(73) }, 'password', 'Must be between 8 and 72 characters.'],
    [{ name: '', email: 'bad', password: '' }, 'name', 'Must be between 1 and 80 characters.'],
    [{ ...jordan, email: 'bad', password: '' }, 'email', 'Enter a valid email address.'],
    [{ ...jordan, email: 'alex@demo.test', password: '' }, 'password', 'Must be between 8 and 72 characters.'],
  ])('rejects %j with 422 on %s', async (body, field, message) => {
    const api = await signedInMockApi();

    await expect(api.createStaffMember(body)).rejects.toMatchObject(validationMessage(field, message));
    expect(await api.listStaff()).toHaveLength(2);
  });

  it('accepts lengths at the limits, counted in code points', async () => {
    const api = await signedInMockApi();

    await expect(
      api.createStaffMember({ name: '😀'.repeat(80), email: `${'x'.repeat(244)}@demo.test`, password: '😀'.repeat(72) }),
    ).resolves.toMatchObject({ name: '😀'.repeat(80) });
    await expect(api.createStaffMember({ name: 'Kim', email: 'kim@demo.test', password: '12345678' })).resolves.toMatchObject({
      name: 'Kim',
    });
  });

  it.each(['SAM@demo.test', 'sam@demo.test'])('rejects the email %j already used, with 409 email_taken', async (email) => {
    const api = await signedInMockApi();

    const error = await api.createStaffMember({ ...jordan, email }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'email_taken', message: 'Another staff account already has this email.' });
  });

  it('rejects the email of an inactive account', async () => {
    const api = await signedInMockApi();
    await api.updateStaffMember((await staffByName(api, 'Sam')).id, { isActive: false });

    await expect(api.createStaffMember({ ...jordan, email: 'sam@demo.test' })).rejects.toMatchObject({ status: 409, code: 'email_taken' });
  });

  it('stores the account and returns exactly the StaffMember fields', async () => {
    const { api, store } = createMockApiWithStore();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });

    const created = await api.createStaffMember(jordan);

    expect(created).toEqual({ id: expect.any(String), name: 'Jordan', email: 'jordan@demo.test', isActive: true, createdAt: now.toISOString() });
    expect(Object.keys(created).sort()).toEqual(['createdAt', 'email', 'id', 'isActive', 'name']);
    expect(store.staff.at(-1)).toMatchObject({ id: created.id, password: 'secret123' });
    expect(await api.listStaff()).toContainEqual(created);
  });

  it('lets the new account sign in with the email in any case and take appointments', async () => {
    const api = await signedInMockApi();
    const created = await api.createStaffMember(jordan);
    const body = await validAppointmentRequest(api);

    await expect(api.createAppointment({ ...body, staffMemberId: created.id })).resolves.toMatchObject({
      appointment: { staffMember: { id: created.id, name: 'Jordan' } },
    });
    await api.logout();
    await expect(api.login({ email: 'JORDAN@demo.TEST', password: 'secret123' })).resolves.toEqual(created);
  });
});

describe('createMockApi updateStaffMember', () => {
  it.each(['unknown', '', '00000000-0000-4000-8000-000000000000'])('rejects the unknown id %j with 404', async (id) => {
    const api = await signedInMockApi();

    await expect(api.updateStaffMember(id, { isActive: false })).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('rejects an empty body with no field', async () => {
    const api = await signedInMockApi();
    const sam = await staffByName(api, 'Sam');

    await expect(api.updateStaffMember(sam.id, {})).rejects.toMatchObject({
      status: 422,
      code: 'validation_error',
      message: 'Change at least one field.',
      field: undefined,
    });
  });

  it.each(['', 'x'.repeat(81)])('rejects the name %j and writes nothing', async (name) => {
    const api = await signedInMockApi();
    const sam = await staffByName(api, 'Sam');

    await expect(api.updateStaffMember(sam.id, { name, isActive: false })).rejects.toMatchObject(
      validationMessage('name', 'Must be between 1 and 80 characters.'),
    );
    await expect(staffByName(api, 'Sam')).resolves.toMatchObject({ isActive: true });
  });

  it('rejects deactivating yourself with 409 and writes nothing', async () => {
    const api = await signedInMockApi();
    const alex = await staffByName(api, 'Alex');

    const error = await api.updateStaffMember(alex.id, { name: 'Alexandra', isActive: false }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'cannot_deactivate_self', message: 'You cannot deactivate your own account.' });
    await expect(staffByName(api, 'Alex')).resolves.toMatchObject({ isActive: true });
  });

  it('checks the name before deactivating yourself', async () => {
    const api = await signedInMockApi();
    const alex = await staffByName(api, 'Alex');

    await expect(api.updateStaffMember(alex.id, { name: '', isActive: false })).rejects.toMatchObject({ status: 422, field: 'name' });
  });

  it('renames an account and returns a copy', async () => {
    const api = await signedInMockApi();
    const alex = await staffByName(api, 'Alex');

    const updated = await api.updateStaffMember(alex.id, { name: 'Alexandra' });

    expect(updated).toEqual({ ...alex, name: 'Alexandra' });
    updated.name = 'Changed';
    await expect(api.getCurrentStaffMember()).resolves.toMatchObject({ name: 'Alexandra' });
  });

  it('deactivates and reactivates another account', async () => {
    const api = await signedInMockApi();
    const sam = await staffByName(api, 'Sam');
    const body = await validAppointmentRequest(api);
    const samAppointments = (await api.getDayView({})).appointments.filter((entry) => entry.staffMember.id === sam.id).length;

    await expect(api.updateStaffMember(sam.id, { isActive: false })).resolves.toEqual({ ...sam, isActive: false });

    await expect(staffByName(api, 'Sam')).resolves.toMatchObject({ isActive: false });
    await expect(api.createAppointment({ ...body, staffMemberId: sam.id })).rejects.toMatchObject(validationField('staffMemberId'));
    expect((await api.getDayView({})).appointments.filter((entry) => entry.staffMember.id === sam.id)).toHaveLength(samAppointments);
    expect(samAppointments).toBeGreaterThan(0);
    await api.logout();
    await expect(api.login({ email: 'sam@demo.test', password: 'demo1234' })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });

    await api.login({ email: 'alex@demo.test', password: 'demo1234' });
    await expect(api.updateStaffMember(sam.id, { isActive: true })).resolves.toEqual(sam);
    await api.logout();
    await expect(api.login({ email: 'sam@demo.test', password: 'demo1234' })).resolves.toEqual(sam);
  });

  it('rejects the next call of a signed-in member who was deactivated', async () => {
    const { api, store } = createMockApiWithStore();
    await api.login({ email: 'sam@demo.test', password: 'demo1234' });
    store.staff.find((entry) => entry.name === 'Sam')!.isActive = false;

    await expect(api.updateSettings({ noShowThreshold: 2 })).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    await expect(api.createStaffMember({ name: 'Kim', email: 'kim@demo.test', password: '12345678' })).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });
});
