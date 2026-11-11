import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import type { AppointmentStatus, Client, StaffMember } from './generated/prisma/client.js';
import {
  createTestAppointment,
  createTestClient,
  createTestStaff,
  expectOnlyRequestLines,
  resetDatabase,
  signIn,
} from './test-helpers.js';

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const dateError = { error: { code: 'validation_error', message: 'Enter the date as YYYY-MM-DD.', field: 'date' } };
const staffIdError = { error: { code: 'validation_error', message: 'Enter a valid staff id.', field: 'staffId' } };
const unknownId = '00000000-0000-4000-8000-000000000000';
const dayAppointmentFields = [
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
];
const allStatuses: AppointmentStatus[] = ['pending', 'confirmed', 'cancelled', 'attended', 'no_show'];

let now: Date;
let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let maria: Client;
let agent: Awaited<ReturnType<typeof signIn>>;

beforeEach(async () => {
  await resetDatabase();
  now = new Date('2026-11-10T10:07:00Z');
  app = createApp({ now: () => now });
  await prisma.businessSettings.create({ data: { id: 1, timeZone: 'Europe/Madrid' } });
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  maria = await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });
  agent = await signIn(app, alex.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function appointmentFor(options: Partial<Parameters<typeof createTestAppointment>[0]> = {}) {
  return createTestAppointment({ clientId: maria.id, staffMemberId: alex.id, ...options });
}

function at(iso: string) {
  return new Date(iso);
}

function fromNow(ms: number) {
  return new Date(now.getTime() + ms);
}

async function dayView(query = '') {
  const response = await agent.get(`/v1/appointments${query}`);
  expect(response.status).toBe(200);
  return response.body as {
    date: string;
    timeZone: string;
    appointments: { id: string; startsAt: string; atRiskReasons: unknown[]; isLateCancellation: boolean }[];
  };
}

async function idsOn(date: string) {
  return (await dayView(`?date=${date}`)).appointments.map(({ id }) => id);
}

async function reasonsOf(id: string, date = '2026-11-10') {
  return (await dayView(`?date=${date}`)).appointments.find((appointment) => appointment.id === id)?.atRiskReasons;
}

async function lateFlagOf(id: string, date = '2026-11-10') {
  return (await dayView(`?date=${date}`)).appointments.find((appointment) => appointment.id === id)?.isLateCancellation;
}

describe('request', () => {
  it.each(['', '?date=bad&staffId=bad', '?date=2026-11-10'])('is 401 without a session for %j', async (query) => {
    const response = await request(app).get(`/v1/appointments${query}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });

  it('is 401 when the signed-in staff member is now inactive', async () => {
    await prisma.staffMember.update({ where: { id: alex.id }, data: { isActive: false } });

    const response = await agent.get('/v1/appointments');

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });

  it.each([
    'date=10/11/2026',
    'date=2026-13-01',
    'date=2026-02-30',
    'date=2026-02-29',
    'date=2026-2-1',
    'date=today',
    'date=',
    'date=2026-11-10&date=2026-11-11',
  ])('rejects ?%s as a malformed date', async (query) => {
    const response = await agent.get(`/v1/appointments?${query}`);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(dateError);
  });

  it('accepts 2028-02-29', async () => {
    expect((await dayView('?date=2028-02-29')).date).toBe('2028-02-29');
  });

  it.each(['0000-01-01', '0001-01-01', '0001-01-02', '9999-12-31'])('returns an empty day for %s', async (date) => {
    expect(await dayView(`?date=${date}`)).toEqual({ date, timeZone: 'Europe/Madrid', appointments: [] });
  });

  it.each(['staffId=abc', 'staffId=', `staffId=${unknownId}&staffId=${unknownId}`])(
    'rejects ?%s as a malformed staff id',
    async (query) => {
      const response = await agent.get(`/v1/appointments?${query}`);

      expect(response.status).toBe(422);
      expect(response.body).toEqual(staffIdError);
    },
  );

  it('reports the date error when both are malformed, and ignores other parameters', async () => {
    const both = await agent.get('/v1/appointments?staffId=abc&date=today');
    const other = await agent.get('/v1/appointments?date=2026-11-10&q=x&page=2');

    expect(both.status).toBe(422);
    expect(both.body).toEqual(dateError);
    expect(other.status).toBe(200);
  });

  it('returns no appointments for an unknown staff id', async () => {
    await appointmentFor({ startsAt: at('2026-11-10T15:00:00Z') });

    expect((await dayView(`?date=2026-11-10&staffId=${unknownId}`)).appointments).toEqual([]);
  });
});

describe('the day', () => {
  it('returns exactly date, timeZone and appointments, defaulting to today in the business time zone', async () => {
    const body = await dayView();

    expect(body).toEqual({ date: '2026-11-10', timeZone: 'Europe/Madrid', appointments: [] });
  });

  it('defaults to the business date, not the UTC date', async () => {
    now = at('2026-11-10T23:30:00Z');

    expect((await dayView()).date).toBe('2026-11-11');
  });

  it('puts an appointment on its date in the business time zone', async () => {
    const appointment = await appointmentFor({ startsAt: at('2026-11-10T23:00:00Z') });

    expect(await idsOn('2026-11-11')).toEqual([appointment.id]);
    expect(await idsOn('2026-11-10')).toEqual([]);
  });

  it.each([
    ['2026-10-25', ['2026-10-24T22:00:00Z', '2026-10-25T22:59:00Z'], ['2026-10-24T21:59:00Z', '2026-10-25T23:00:00Z']],
    ['2026-03-29', ['2026-03-28T23:00:00Z', '2026-03-29T21:59:00Z'], ['2026-03-29T22:00:00Z']],
  ])('covers the whole DST day %s', async (date, inside, outside) => {
    const included = [];
    for (const startsAt of inside) {
      included.push(await appointmentFor({ startsAt: at(startsAt) }));
    }
    for (const startsAt of outside) {
      await appointmentFor({ startsAt: at(startsAt) });
    }

    expect(await idsOn(date)).toEqual(included.map(({ id }) => id));
  });

  it('includes every status and inactive staff, and filters by staffId', async () => {
    const sam = await createTestStaff({ name: 'Sam', isActive: false });
    const alexIds = [];
    for (const [index, status] of allStatuses.entries()) {
      alexIds.push((await appointmentFor({ status, startsAt: at(`2026-11-10T1${index}:00:00Z`) })).id);
    }
    const samAppointment = await appointmentFor({ staffMemberId: sam.id, startsAt: at('2026-11-10T16:00:00Z') });

    const all = await dayView('?date=2026-11-10');
    const samOnly = await dayView(`?date=2026-11-10&staffId=${sam.id}`);
    const alexOnly = await dayView(`?date=2026-11-10&staffId=${alex.id}`);

    expect(all.appointments.map(({ id }) => id)).toEqual([...alexIds, samAppointment.id]);
    expect(samOnly.appointments.map(({ id }) => id)).toEqual([samAppointment.id]);
    expect(alexOnly.appointments.map(({ id }) => id)).toEqual(alexIds);
  });

  it('sorts by startsAt, then id', async () => {
    const later = await appointmentFor({ startsAt: at('2026-11-10T16:00:00Z') });
    const tied = [];
    for (let index = 0; index < 4; index += 1) {
      tied.push(await appointmentFor({ startsAt: at('2026-11-10T12:00:00Z') }));
    }
    const earlier = await appointmentFor({ startsAt: at('2026-11-10T08:00:00Z') });

    expect(await idsOn('2026-11-10')).toEqual([
      earlier.id,
      ...tied.map(({ id }) => id).sort((first, second) => first.localeCompare(second)),
      later.id,
    ]);
  });

  it('follows a time zone change made through PATCH /v1/settings', async () => {
    const appointment = await appointmentFor({ startsAt: at('2026-11-11T03:00:00Z') });
    expect(await idsOn('2026-11-11')).toEqual([appointment.id]);

    const patch = await agent.patch('/v1/settings').send({ timeZone: 'America/New_York' });
    const body = await dayView('?date=2026-11-10');

    expect(patch.status).toBe(200);
    expect(body.timeZone).toBe('America/New_York');
    expect(body.appointments.map(({ id, startsAt }) => [id, startsAt])).toEqual([
      [appointment.id, '2026-11-11T03:00:00.000Z'],
    ]);
  });
});

describe('each appointment', () => {
  it('has the Appointment fields plus atRiskReasons and isLateCancellation, with no token', async () => {
    const noPhone = await createTestClient({ name: 'No Phone', phone: null });
    const appointment = await appointmentFor({ startsAt: at('2026-11-10T15:00:00Z') });
    await appointmentFor({ clientId: noPhone.id, startsAt: at('2026-11-10T16:00:00Z') });
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });

    const [first, second] = (await dayView('?date=2026-11-10')).appointments as Record<string, unknown>[];

    expect(Object.keys(first).sort()).toEqual(dayAppointmentFields);
    expect(Object.keys(second).sort()).toEqual(dayAppointmentFields);
    expect(first).toEqual({
      id: appointment.id,
      client: { id: maria.id, name: 'Maria Lopez', phone: '+34 600 123 456' },
      staffMember: { id: alex.id, name: 'Alex' },
      service: 'Haircut',
      startsAt: '2026-11-10T15:00:00.000Z',
      durationMinutes: 30,
      status: 'pending',
      confirmedBy: null,
      cancelledBy: null,
      statusChangedAt: stored.statusChangedAt.toISOString(),
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
      atRiskReasons: [{ code: 'no_reply' }],
      isLateCancellation: false,
    });
    expect(second.client).toEqual({ id: noPhone.id, name: 'No Phone', phone: null });
    expect(JSON.stringify([first, second])).not.toContain(appointment.token);
  });
});

describe('atRiskReasons', () => {
  it('gives no_reply to a pending appointment up to exactly the window', async () => {
    const atEdge = await appointmentFor({ startsAt: fromNow(dayMs) });
    const past = await appointmentFor({ startsAt: fromNow(dayMs + 1) });

    expect(await reasonsOf(atEdge.id, '2026-11-11')).toEqual([{ code: 'no_reply' }]);
    expect(await reasonsOf(past.id, '2026-11-11')).toEqual([]);
  });

  it('never gives no_reply to a confirmed appointment', async () => {
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: 'client', startsAt: fromNow(hourMs) });

    expect(await reasonsOf(appointment.id)).toEqual([]);
  });

  it.each(['pending', 'confirmed'] as const)('gives a %s appointment at or after its start no reasons', async (status) => {
    await appointmentFor({ status: 'no_show', startsAt: at('2026-11-01T09:00:00Z') });
    const atStart = await appointmentFor({ status, startsAt: now });
    const started = await appointmentFor({ status, startsAt: fromNow(-hourMs) });

    expect(await reasonsOf(atStart.id)).toEqual([]);
    expect(await reasonsOf(started.id)).toEqual([]);
  });

  it.each(['cancelled', 'attended', 'no_show'] as const)('gives a %s appointment no reasons', async (status) => {
    await appointmentFor({ status: 'no_show', startsAt: at('2026-11-01T09:00:00Z') });
    const appointment = await appointmentFor({ status, startsAt: fromNow(hourMs) });

    expect(await reasonsOf(appointment.id)).toEqual([]);
  });
});

describe('no-show history', () => {
  it('counts a no-show from 10 days ago on a confirmed appointment today', async () => {
    await appointmentFor({ status: 'no_show', startsAt: fromNow(-10 * dayMs) });
    const appointment = await appointmentFor({ status: 'confirmed', startsAt: fromNow(5 * hourMs) });

    expect(await reasonsOf(appointment.id)).toEqual([{ code: 'no_show_history', noShowCount: 1 }]);
  });

  it.each([
    ['counts', 0, [{ code: 'no_show_history', noShowCount: 1 }]],
    ['does not count', 1, []],
  ])('%s a no-show %i ms past the 180-day lookback', async (_, extraMs, expected) => {
    await appointmentFor({ status: 'no_show', startsAt: fromNow(-180 * dayMs - extraMs) });
    const appointment = await appointmentFor({ status: 'confirmed', startsAt: fromNow(5 * hourMs) });

    expect(await reasonsOf(appointment.id)).toEqual(expected);
  });

  it('gives no reason below noShowThreshold', async () => {
    await prisma.businessSettings.update({ where: { id: 1 }, data: { noShowThreshold: 2 } });
    await appointmentFor({ status: 'no_show', startsAt: fromNow(-10 * dayMs) });
    const appointment = await appointmentFor({ status: 'confirmed', startsAt: fromNow(5 * hourMs) });

    expect(await reasonsOf(appointment.id)).toEqual([]);
  });

  it('lists no_reply before no_show_history', async () => {
    await appointmentFor({ status: 'no_show', startsAt: fromNow(-10 * dayMs) });
    const appointment = await appointmentFor({ startsAt: fromNow(5 * hourMs) });

    expect(await reasonsOf(appointment.id)).toEqual([
      { code: 'no_reply' },
      { code: 'no_show_history', noShowCount: 1 },
    ]);
  });

  it('counts a no-show earlier the same day, which itself has no reasons', async () => {
    const noShow = await appointmentFor({ status: 'no_show', startsAt: at('2026-11-10T08:00:00Z') });
    const later = await appointmentFor({ status: 'confirmed', startsAt: at('2026-11-10T15:00:00Z') });

    expect(await reasonsOf(noShow.id)).toEqual([]);
    expect(await reasonsOf(later.id)).toEqual([{ code: 'no_show_history', noShowCount: 1 }]);
  });

  it("counts a no-show with another staff member under a staffId filter, and ignores other clients'", async () => {
    const sam = await createTestStaff({ name: 'Sam' });
    const other = await createTestClient({ name: 'Other' });
    await appointmentFor({ staffMemberId: sam.id, status: 'no_show', startsAt: fromNow(-10 * dayMs) });
    await appointmentFor({ clientId: other.id, status: 'no_show', startsAt: fromNow(-10 * dayMs) });
    const appointment = await appointmentFor({ status: 'confirmed', startsAt: fromNow(5 * hourMs) });

    const body = await dayView(`?date=2026-11-10&staffId=${alex.id}`);

    expect(body.appointments.map(({ id, atRiskReasons }) => [id, atRiskReasons])).toEqual([
      [appointment.id, [{ code: 'no_show_history', noShowCount: 1 }]],
    ]);
  });

  it.each([3, 100])('loads the day and the history in 2 queries for %i clients', async (count) => {
    const clients = await prisma.client.createManyAndReturn({
      data: Array.from({ length: count }, (_, index) => ({ name: `Client ${index}` })),
    });
    const row = { staffMemberId: alex.id, service: 'Haircut', durationMinutes: 30, statusChangedAt: now };
    await prisma.appointment.createMany({
      data: clients.flatMap(({ id }, index) => [
        { ...row, clientId: id, startsAt: fromNow(hourMs + index * 1000), status: 'confirmed', tokenHash: `day-${index}` },
        { ...row, clientId: id, startsAt: fromNow(-10 * dayMs), status: 'no_show', tokenHash: `history-${index}` },
      ]),
    });
    const findMany = vi.spyOn(prisma.appointment, 'findMany');

    const body = await dayView('?date=2026-11-10');

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(body.appointments).toHaveLength(count);
    for (const appointment of body.appointments) {
      expect(appointment.atRiskReasons).toEqual([{ code: 'no_show_history', noShowCount: 1 }]);
    }
  });
});

describe('isLateCancellation', () => {
  const startsAt = at('2026-11-10T18:00:00Z');

  function cancelledAt(statusChangedAt: Date) {
    return appointmentFor({ status: 'cancelled', cancelledBy: 'client', startsAt, statusChangedAt });
  }

  it.each([
    ['2 h before the start', -2 * hourMs, true],
    ['13 h before the start', -13 * hourMs, false],
    ['after the start', hourMs, true],
  ])('is computed for a cancellation %s', async (_, offsetMs, expected) => {
    const appointment = await cancelledAt(new Date(startsAt.getTime() + offsetMs));

    expect(await lateFlagOf(appointment.id)).toBe(expected);
  });

  it('is false with lateCancellationHours 0', async () => {
    await prisma.businessSettings.update({ where: { id: 1 }, data: { lateCancellationHours: 0 } });
    const appointment = await cancelledAt(new Date(startsAt.getTime() - hourMs));

    expect(await lateFlagOf(appointment.id)).toBe(false);
  });

  it.each(['pending', 'confirmed', 'attended', 'no_show'] as const)('is false for a %s appointment', async (status) => {
    const appointment = await appointmentFor({ status, startsAt, statusChangedAt: new Date(startsAt.getTime() - hourMs) });

    expect(await lateFlagOf(appointment.id)).toBe(false);
  });
});

describe('settings changes', () => {
  it('applies a new noReplyWindowHours on the next request (spec section 16, criterion 9)', async () => {
    const appointment = await appointmentFor({ startsAt: at('2026-11-11T16:07:00Z') });
    expect(await reasonsOf(appointment.id, '2026-11-11')).toEqual([]);

    const patch = await agent.patch('/v1/settings').send({ noReplyWindowHours: 48 });

    expect(patch.status).toBe(200);
    expect(await reasonsOf(appointment.id, '2026-11-11')).toEqual([{ code: 'no_reply' }]);
  });
});

describe('privacy', () => {
  it('logs only request lines, with no client name or phone, on a 200 or a 422', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    await appointmentFor({ startsAt: at('2026-11-10T15:00:00Z') });

    await dayView('?date=2026-11-10');
    await agent.get('/v1/appointments?date=today');
    await agent.get('/v1/appointments?staffId=abc');

    const logged = JSON.stringify(logs.map((log) => log.mock.calls));
    expect(logged).not.toContain('Maria Lopez');
    expect(logged).not.toContain('+34 600 123 456');
    expectOnlyRequestLines(logs);
  });
});
