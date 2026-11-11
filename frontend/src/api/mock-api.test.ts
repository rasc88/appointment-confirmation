import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error';
import { buildDemoData } from './demo-data';
import { createMockApi } from './mock-api';

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
