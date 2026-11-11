import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { buildDemoData, type DemoData } from './demo-data';
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
    await expect(createMockApi().getDayView({})).rejects.toThrow('Not implemented in mock: getDayView');
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
