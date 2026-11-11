import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { buildDemoData, type DemoData } from './demo-data';
import type { DayAppointment } from './types';
import { createMockApi } from './mock-api';

vi.mock('./demo-data', { spy: true });

const now = new Date('2026-11-10T10:07:00Z');

/** The store the mock was built from, so tests can check fields `PublicAppointment` leaves out. */
function createMockApiWithStore() {
  const api = createMockApi({ now });
  const store = vi.mocked(buildDemoData).mock.results.at(-1)?.value as DemoData;
  const byToken = (token: string) => store.appointments.find((appointment) => appointment.token === token)!;
  return { api, byToken };
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
    await expect(createMockApi().getSettings()).rejects.toThrow('Not implemented in mock: getSettings');
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
