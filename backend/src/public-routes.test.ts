import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import * as confirmationToken from './confirmation-token.js';
import { prisma } from './db.js';
import type { Actor, AppointmentStatus, Client, StaffMember } from './generated/prisma/client.js';
import {
  createTestAppointment,
  createTestClient,
  createTestStaff,
  expectOnlyRequestLines,
  loggedLines,
  resetDatabase,
  signIn,
  testPassword,
} from './test-helpers.js';

vi.mock('./confirmation-token.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./confirmation-token.js')>();
  return { ...actual, hashConfirmationToken: vi.fn(actual.hashConfirmationToken) };
});

const notFound = { error: { code: 'not_found', message: 'This link is not valid.' } };
const invalidTransition = { error: { code: 'invalid_transition', message: 'This appointment can no longer be changed.' } };
const appointmentStarted = { error: { code: 'appointment_started', message: 'This appointment has already started.' } };
const rateLimited = { error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } };
const startsAt = new Date('2026-11-11T09:30:00Z');
const finalStatuses: AppointmentStatus[] = ['cancelled', 'attended', 'no_show'];
const allStatuses: AppointmentStatus[] = ['pending', 'confirmed', ...finalStatuses];
const actions = ['get', 'confirm', 'cancel'] as const;

type Action = (typeof actions)[number];

let now: Date;
let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let maria: Client;

beforeEach(async () => {
  await resetDatabase();
  now = new Date('2026-11-10T10:07:00Z');
  app = createApp({ now: () => now });
  await prisma.businessSettings.create({ data: { id: 1, businessName: 'Demo Studio', timeZone: 'Europe/Madrid' } });
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  maria = await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(confirmationToken.hashConfirmationToken).mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function appointmentFor(options: Partial<Parameters<typeof createTestAppointment>[0]> = {}) {
  return createTestAppointment({ clientId: maria.id, staffMemberId: alex.id, startsAt, ...options });
}

function send(action: Action, token: string, ip = '203.0.113.1', target = app) {
  const path = `/v1/public/appointments/${token}`;
  const pending = action === 'get' ? request(target).get(path) : request(target).post(`${path}/${action}`);
  return pending.set('X-Forwarded-For', ip);
}

/** Uses up `count` requests of the IP's limit. */
async function sendTimes(count: number) {
  for (let attempt = 0; attempt < count; attempt += 1) {
    expect((await send(actions[attempt % 3], 'x')).status).not.toBe(429);
  }
}

function publicAppointment(overrides: Record<string, unknown> = {}) {
  return {
    businessName: 'Demo Studio',
    timeZone: 'Europe/Madrid',
    service: 'Haircut',
    staffName: 'Alex',
    startsAt: '2026-11-11T09:30:00.000Z',
    durationMinutes: 30,
    status: 'pending',
    hasStarted: false,
    ...overrides,
  };
}

function storedRow(id: string) {
  return prisma.appointment.findUniqueOrThrow({ where: { id } });
}

/** Makes the next lookup see `status` while the row in the database has another one, as in a lost race. */
async function lookUpAsIf(id: string, overrides: { status?: AppointmentStatus; tokenHash?: string }) {
  const stored = await prisma.appointment.findUniqueOrThrow({ where: { id }, include: { staffMember: true } });
  vi.spyOn(prisma.appointment, 'findUnique').mockResolvedValueOnce({ ...stored, ...overrides } as never);
}

describe('response shape', () => {
  it.each(['+34 600 123 456', null])('returns exactly the 8 public keys for a client with phone %j', async (phone) => {
    const client = await createTestClient({ name: 'Unique Client Name', phone });
    const appointment = await appointmentFor({ clientId: client.id, confirmedBy: 'staff', status: 'confirmed' });

    for (const action of ['get', 'confirm'] as const) {
      const response = await send(action, appointment.token);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(publicAppointment({ status: 'confirmed' }));
      const text = response.text;
      for (const secret of [client.name, client.id, appointment.id, alex.id, appointment.token, appointment.tokenHash]) {
        expect(text).not.toContain(secret);
      }
      if (phone !== null) {
        expect(text).not.toContain(phone);
      }
      expect(text).not.toContain('confirmedBy');
      expect(text).not.toContain('cancelledBy');
    }
  });

  it('returns the 8 keys from cancel', async () => {
    const appointment = await appointmentFor();

    const response = await send('cancel', appointment.token);

    expect(response.body).toEqual(publicAppointment({ status: 'cancelled' }));
  });

  it('reads the settings row on each request', async () => {
    const appointment = await appointmentFor();
    expect((await send('get', appointment.token)).body.businessName).toBe('Demo Studio');
    await prisma.businessSettings.update({ where: { id: 1 }, data: { businessName: 'New Name', timeZone: 'America/New_York' } });

    const response = await send('get', appointment.token);

    expect(response.body).toEqual(publicAppointment({ businessName: 'New Name', timeZone: 'America/New_York' }));
  });

  it('names an inactive staff member', async () => {
    const sam = await createTestStaff({ name: 'Sam', isActive: false });
    const appointment = await appointmentFor({ staffMemberId: sam.id });

    expect((await send('get', appointment.token)).body.staffName).toBe('Sam');
  });

  it('sets hasStarted from now >= startsAt in a non-UTC time zone', async () => {
    const appointment = await appointmentFor();

    now = new Date(startsAt.getTime() - 1);
    expect((await send('get', appointment.token)).body.hasStarted).toBe(false);
    now = startsAt;
    expect((await send('get', appointment.token)).body.hasStarted).toBe(true);
    now = new Date(startsAt.getTime() + 60_000);
    expect((await send('get', appointment.token)).body.hasStarted).toBe(true);
  });
});

describe('token lookup', () => {
  it('looks the appointment up by the token hash only', async () => {
    const appointment = await appointmentFor();
    const findUnique = vi.spyOn(prisma.appointment, 'findUnique');

    await send('get', appointment.token);

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique.mock.calls[0][0]).toEqual({
      where: { tokenHash: confirmationToken.hashConfirmationToken(appointment.token) },
      include: { staffMember: true },
    });
  });

  it.each([
    ['x', 'x'],
    ['129 characters', 'a'.repeat(129)],
    ['a dot', `${'a'.repeat(22)}.b`],
    ['%20', `${'a'.repeat(22)}%20b`],
    ['2,000 characters', 'a'.repeat(2000)],
  ])('returns the 404 for a token of %s without hashing or a query', async (_label, token) => {
    const queries = [
      vi.spyOn(prisma.appointment, 'findUnique'),
      vi.spyOn(prisma.appointment, 'update'),
      vi.spyOn(prisma.businessSettings, 'upsert'),
    ];
    vi.mocked(confirmationToken.hashConfirmationToken).mockClear();

    for (const action of actions) {
      const response = await send(action, token);

      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFound);
    }
    expect(confirmationToken.hashConfirmationToken).not.toHaveBeenCalled();
    for (const query of queries) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('returns the identical 404 for a well-formed unknown token', async () => {
    const malformed = await send('get', 'x');

    for (const action of actions) {
      const response = await send(action, 'A'.repeat(22));

      expect(response.status).toBe(404);
      expect(response.body).toEqual(malformed.body);
    }
  });

  it('rejects the old token after the link is regenerated and accepts the new one', async () => {
    const appointment = await appointmentFor();
    const agent = await signIn(app, alex.email);
    const regenerated = await agent.post(`/v1/appointments/${appointment.id}/link`);
    const newToken = regenerated.body.confirmationLink.split('/c/')[1];

    for (const action of actions) {
      const response = await send(action, appointment.token);

      expect(response.status).toBe(404);
      expect(response.body).toEqual(notFound);
    }
    expect((await send('get', newToken)).status).toBe(200);
    expect((await send('confirm', newToken)).body.status).toBe('confirmed');
  });

  it.each(allStatuses)('returns 200 on GET for %s before and after the start time', async (status) => {
    const appointment = await appointmentFor({ status });

    expect((await send('get', appointment.token)).body).toEqual(publicAppointment({ status }));
    now = startsAt;
    expect((await send('get', appointment.token)).body).toEqual(publicAppointment({ status, hasStarted: true }));
  });
});

describe('POST /v1/public/appointments/{token}/confirm', () => {
  it('confirms a pending appointment', async () => {
    const appointment = await appointmentFor({ cancelledBy: 'staff' });

    const response = await send('confirm', appointment.token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(publicAppointment({ status: 'confirmed' }));
    expect(await storedRow(appointment.id)).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'client',
      cancelledBy: 'staff',
      statusChangedAt: now,
    });
  });

  it.each<Actor>(['client', 'staff'])('returns an appointment confirmed by %s unchanged, without writing', async (actor) => {
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: actor });
    const { token, ...row } = appointment;
    const update = vi.spyOn(prisma.appointment, 'update');

    const response = await send('confirm', token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(publicAppointment({ status: 'confirmed' }));
    expect(update).not.toHaveBeenCalled();
    expect(await storedRow(appointment.id)).toEqual(row);
  });

  it.each<AppointmentStatus>(['pending', 'confirmed'])('returns 409 appointment_started for a started %s', async (status) => {
    const appointment = await appointmentFor({ status });
    const { token, ...row } = appointment;

    for (const time of [startsAt, new Date(startsAt.getTime() + 60_000)]) {
      now = time;
      const response = await send('confirm', token);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(appointmentStarted);
    }
    expect(await storedRow(appointment.id)).toEqual(row);
  });

  it.each(finalStatuses)('returns 409 invalid_transition for %s before and after the start time', async (status) => {
    const appointment = await appointmentFor({ status });
    const { token, ...row } = appointment;

    for (const time of [now, startsAt]) {
      now = time;
      const response = await send('confirm', token);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(invalidTransition);
    }
    expect(await storedRow(appointment.id)).toEqual(row);
  });
});

describe('POST /v1/public/appointments/{token}/cancel', () => {
  it.each<[AppointmentStatus, Actor | null]>([
    ['pending', null],
    ['confirmed', 'client'],
    ['confirmed', 'staff'],
  ])('cancels a %s appointment and keeps confirmedBy %j', async (status, confirmedBy) => {
    const appointment = await appointmentFor({ status, confirmedBy });

    const response = await send('cancel', appointment.token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(publicAppointment({ status: 'cancelled', hasStarted: false }));
    expect(await storedRow(appointment.id)).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'client',
      confirmedBy,
      statusChangedAt: now,
    });
  });

  it.each<AppointmentStatus>(['pending', 'confirmed'])('returns 409 appointment_started for a started %s', async (status) => {
    const appointment = await appointmentFor({ status });
    const { token, ...row } = appointment;

    for (const time of [startsAt, new Date(startsAt.getTime() + 60_000)]) {
      now = time;
      const response = await send('cancel', token);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(appointmentStarted);
    }
    expect(await storedRow(appointment.id)).toEqual(row);
  });

  it.each(finalStatuses)('returns 409 invalid_transition for %s before and after the start time', async (status) => {
    const appointment = await appointmentFor({ status });
    const { token, ...row } = appointment;

    for (const time of [now, startsAt]) {
      now = time;
      const response = await send('cancel', token);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(invalidTransition);
    }
    expect(await storedRow(appointment.id)).toEqual(row);
  });
});

describe('races', () => {
  it.each([
    ['confirm', 'pending', 'confirmed'],
    ['confirm', 'pending', 'cancelled'],
    ['cancel', 'pending', 'cancelled'],
    ['cancel', 'confirmed', 'attended'],
  ] as const)('%s returns 409 when the status changed from %s to %s after the lookup', async (action, seen, stored) => {
    const appointment = await appointmentFor({ status: stored });
    const { token, ...row } = appointment;
    await lookUpAsIf(appointment.id, { status: seen });

    const response = await send(action, token);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    expect(await storedRow(appointment.id)).toEqual(row);
  });

  it.each(['confirm', 'cancel'] as const)('%s returns 409 when the link was regenerated after the lookup', async (action) => {
    const appointment = await appointmentFor();
    const { token, ...row } = appointment;
    await lookUpAsIf(appointment.id, { tokenHash: 'f'.repeat(64) });

    const response = await send(action, token);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    expect(await storedRow(appointment.id)).toEqual(row);
  });
});

describe('public rate limit', () => {
  it('returns 429 with Retry-After on the 31st request, with no query, whatever the outcomes', async () => {
    const pending = await appointmentFor();
    const cancelled = await appointmentFor({ status: 'cancelled' });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await send('get', pending.token)).status).toBe(200);
      expect((await send('confirm', cancelled.token)).status).toBe(409);
      expect((await send('cancel', 'A'.repeat(22))).status).toBe(404);
    }
    const queries = [vi.spyOn(prisma.appointment, 'findUnique'), vi.spyOn(prisma.businessSettings, 'upsert')];

    for (const action of actions) {
      const response = await send(action, pending.token);

      expect(response.status).toBe(429);
      expect(response.body).toEqual(rateLimited);
      expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    for (const query of queries) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('limits malformed tokens too', async () => {
    await sendTimes(30);

    expect((await send('get', 'x')).status).toBe(429);
  });

  it('lets requests through again once the 60-second window from the first request ends', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T09:00:00Z'), toFake: ['Date'] });
    app = createApp({ now: () => now });
    await sendTimes(30);

    vi.setSystemTime(new Date('2026-11-10T09:00:59.500Z'));
    const lastMoment = await send('get', 'x');
    expect(lastMoment.status).toBe(429);
    expect(lastMoment.headers['retry-after']).toBe('1');
    vi.setSystemTime(new Date('2026-11-10T09:01:00Z'));
    expect((await send('get', 'x')).status).toBe(404);
  });

  it('keeps a separate counter per X-Forwarded-For', async () => {
    await sendTimes(30);

    expect((await send('get', 'x', '198.51.100.7')).status).toBe(404);
    expect((await send('get', 'x')).status).toBe(429);
  });

  it('gives each app its own counters', async () => {
    await sendTimes(30);

    expect((await send('get', 'x', '203.0.113.1', createApp({ now: () => now }))).status).toBe(404);
  });

  it('is independent of the sign-in limit', async () => {
    const login = (password: string) =>
      request(app).post('/v1/auth/login').set('X-Forwarded-For', '203.0.113.1').send({ email: alex.email, password });
    await sendTimes(30);
    expect((await send('get', 'x')).status).toBe(429);

    expect((await login(testPassword)).status).toBe(200);
    app = createApp({ now: () => now });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login('wrong-password')).status).toBe(401);
    }
    expect((await login(testPassword)).status).toBe(429);
    expect((await send('get', 'x')).status).toBe(404);
  });
});

describe('headers, Origin and body', () => {
  it('sets Cache-Control: no-store on 200, 404, 409 and 429', async () => {
    const pending = await appointmentFor();
    const cancelled = await appointmentFor({ status: 'cancelled' });
    const responses = [
      await send('get', pending.token),
      await send('get', 'x'),
      await send('confirm', cancelled.token),
    ];
    await sendTimes(27);
    responses.push(await send('cancel', pending.token));

    expect(responses.map((response) => response.status)).toEqual([200, 404, 409, 429]);
    for (const response of responses) {
      expect(response.headers['cache-control']).toBe('no-store');
    }
  });

  it('accepts confirm and cancel with a foreign Origin', async () => {
    const appointment = await appointmentFor();

    expect((await send('confirm', appointment.token).set('Origin', 'https://evil.test')).status).toBe(200);
    expect((await send('cancel', appointment.token).set('Origin', 'https://evil.test')).status).toBe(200);
  });

  it('never reads the body: malformed JSON and a body over 100 kB still return 200', async () => {
    const appointment = await appointmentFor();

    const malformed = await send('confirm', appointment.token).set('Content-Type', 'application/json').send('{"x":');
    const large = await send('cancel', appointment.token).send({ text: 'x'.repeat(101 * 1024) });

    expect(malformed.status).toBe(200);
    expect(large.status).toBe(200);
  });
});

describe('logging', () => {
  it('logs only request lines, with no token, on success and errors', async () => {
    const appointment = await appointmentFor();
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'info')];

    await send('get', appointment.token);
    await send('get', 'x');
    await send('confirm', appointment.token);
    await send('confirm', appointment.token);
    now = startsAt;
    await send('cancel', appointment.token);

    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(appointment.token);
    expectOnlyRequestLines(spies);
  });

  it('returns 500 for an unexpected error and logs the route template, not the token', async () => {
    const appointment = await appointmentFor();
    vi.spyOn(prisma.appointment, 'findUnique').mockRejectedValueOnce(new TypeError('boom'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await send('get', appointment.token);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'internal_error', message: 'Something went wrong.' } });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(appointment.token);
    expect(loggedLines([consoleError])[0]).toMatchObject({
      level: 'error',
      msg: 'Unhandled error: GET /public/appointments/:token TypeError',
    });
  });
});
