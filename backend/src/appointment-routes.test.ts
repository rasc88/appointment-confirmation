import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { isLateCancellation } from './at-risk.js';
import { hashConfirmationToken } from './confirmation-token.js';
import { prisma } from './db.js';
import { createSessionToken } from './session.js';
import type { AppointmentStatus, Client, StaffMember } from './generated/prisma/client.js';
import {
  createTestAppointment,
  createTestClient,
  createTestStaff,
  expectOnlyRequestLines,
  resetDatabase,
  signIn,
} from './test-helpers.js';

const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const notFound = { error: { code: 'not_found', message: 'Not found.' } };
const invalidTransition = { error: { code: 'invalid_transition', message: 'This appointment can no longer be changed.' } };
const appointmentStarted = { error: { code: 'appointment_started', message: 'This appointment has already started.' } };
const appointmentNotStarted = {
  error: { code: 'appointment_not_started', message: 'This appointment has not started yet.' },
};
const outcomeMessage = 'Choose attended or no-show.';
const startedAt = new Date('2026-11-10T09:00:00Z');
const actions = ['confirm', 'cancel', 'outcome', 'undo-outcome'] as const;
const unknownId = '00000000-0000-4000-8000-000000000000';
const appointmentFields = [
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
];
const finalStatuses: AppointmentStatus[] = ['cancelled', 'attended', 'no_show'];
const startsAtMessage = 'Enter a valid date and time.';
const futureMessage = 'Choose a time in the future.';
const staffMessage = 'Choose an active staff member.';
const serviceMessage = 'Enter the service, up to 80 characters.';
const durationMessage = 'Enter a duration from 5 to 480 minutes.';

function validation(message: string, field?: string) {
  return { error: field === undefined ? { code: 'validation_error', message } : { code: 'validation_error', message, field } };
}

let now: Date;
let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let maria: Client;
let agent: Awaited<ReturnType<typeof signIn>>;
let body: Record<string, unknown>;

beforeEach(async () => {
  await resetDatabase();
  now = new Date('2026-11-10T10:07:00Z');
  app = createApp({ now: () => now });
  await prisma.businessSettings.create({ data: { id: 1, businessName: 'Demo Studio', timeZone: 'Europe/Madrid' } });
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  maria = await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });
  agent = await signIn(app, alex.email);
  body = { clientId: maria.id, staffMemberId: alex.id, service: 'Haircut', startsAt: '2026-11-11T09:30:00Z' };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await prisma.$disconnect();
});

function tokenOf(link: string) {
  return link.slice(link.lastIndexOf('/') + 1);
}

function appointmentFor(options: Partial<Parameters<typeof createTestAppointment>[0]> = {}) {
  return createTestAppointment({ clientId: maria.id, staffMemberId: alex.id, ...options });
}

/** Makes the next load see `status` while the row in the database has another one, as in a lost race. */
async function loadAsIf(id: string, status: AppointmentStatus) {
  const stored = await prisma.appointment.findUniqueOrThrow({ where: { id }, include: { client: true, staffMember: true } });
  vi.spyOn(prisma.appointment, 'findUnique').mockResolvedValueOnce({ ...stored, status } as never);
}

describe('session', () => {
  it.each([
    ['post', '/v1/appointments'],
    ['get', '/v1/appointments/abc'],
    ['get', `/v1/appointments/${unknownId}`],
    ['patch', '/v1/appointments/abc'],
    ['post', `/v1/appointments/${unknownId}/link`],
    ...actions.map((action) => ['post', `/v1/appointments/${unknownId}/${action}`] as const),
  ] as const)('%s %s without a session is 401 before 404 or 422', async (method, path) => {
    const response = await request(app)[method](path).send({});

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });
});

describe('POST /v1/appointments', () => {
  it('creates a pending appointment with its link and message', async () => {
    const response = await agent.post('/v1/appointments').send(body);

    expect(response.status).toBe(201);
    expect(Object.keys(response.body).sort()).toEqual(['appointment', 'confirmationLink', 'message']);
    const token = tokenOf(response.body.confirmationLink);
    expect(response.body.confirmationLink).toBe(`http://localhost:5173/c/${token}`);
    expect(response.body.message).toBe(
      `Hi Maria Lopez, this is Demo Studio. Please confirm your Haircut appointment on 11/11/2026 at 10:30: http://localhost:5173/c/${token}`,
    );
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: response.body.appointment.id } });
    expect(stored.tokenHash).toBe(hashConfirmationToken(token));
    expect(response.body.appointment).toEqual({
      id: stored.id,
      client: { id: maria.id, name: 'Maria Lopez', phone: '+34 600 123 456' },
      staffMember: { id: alex.id, name: 'Alex' },
      service: 'Haircut',
      startsAt: '2026-11-11T09:30:00.000Z',
      durationMinutes: 30,
      status: 'pending',
      confirmedBy: null,
      cancelledBy: null,
      statusChangedAt: '2026-11-10T10:07:00.000Z',
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    });
  });

  it('takes durationMinutes from the body, or from the settings read in this request', async () => {
    await prisma.businessSettings.update({ where: { id: 1 }, data: { defaultDurationMinutes: 45 } });

    const fromSettings = await agent.post('/v1/appointments').send(body);
    const fromBody = await agent.post('/v1/appointments').send({ ...body, durationMinutes: 5 });

    expect(fromSettings.body.appointment.durationMinutes).toBe(45);
    expect(fromBody.body.appointment.durationMinutes).toBe(5);
  });

  it('renders the message with the settings as they are at each request', async () => {
    const first = await agent.post('/v1/appointments').send(body);
    await prisma.businessSettings.update({
      where: { id: 1 },
      data: { messageTemplate: 'See you {date} {time} {link}', timeZone: 'America/New_York' },
    });

    const second = await agent.post('/v1/appointments').send(body);

    expect(first.body.message).toContain('at 10:30:');
    expect(second.body.message).toBe(`See you 11/11/2026 04:30 ${second.body.confirmationLink}`);
  });

  it('puts a client named {link} in the message literally', async () => {
    const client = await createTestClient({ name: '{link}' });

    const response = await agent.post('/v1/appointments').send({ ...body, clientId: client.id });

    expect(response.body.message).toMatch(/^Hi \{link\}, this is Demo Studio\./);
  });

  it.each([
    ['http://localhost:5173/', 'http://localhost:5173'],
    ['https://d111111abcdef8.cloudfront.net/app/', 'https://d111111abcdef8.cloudfront.net'],
  ])('builds the link from the origin of PUBLIC_BASE_URL %s', async (publicBaseUrl, origin) => {
    vi.stubEnv('PUBLIC_BASE_URL', publicBaseUrl);
    const cookie = `session=${createSessionToken(alex.id, process.env.SESSION_SECRET!)}`;

    const response = await request(createApp({ now: () => now }))
      .post('/v1/appointments')
      .set({ Origin: origin, Cookie: cookie })
      .send(body);

    expect(response.status).toBe(201);
    expect(response.body.confirmationLink).toMatch(new RegExp(`^${origin}/c/[\\w-]{22}$`));
  });

  it('stores a startsAt with an offset as UTC', async () => {
    const response = await agent.post('/v1/appointments').send({ ...body, startsAt: '2026-11-11T10:30:00+01:00' });

    expect(response.body.appointment.startsAt).toBe('2026-11-11T09:30:00.000Z');
  });

  it.each([
    [{ clientId: undefined }, 'Choose a client.', 'clientId'],
    [{ clientId: 'abc' }, 'Choose a client.', 'clientId'],
    [{ clientId: 1 }, 'Choose a client.', 'clientId'],
    [{ clientId: 'abc', staffMemberId: 'abc' }, 'Choose a client.', 'clientId'],
    [{ staffMemberId: undefined }, staffMessage, 'staffMemberId'],
    [{ staffMemberId: '\u0000' }, staffMessage, 'staffMemberId'],
    [{ staffMemberId: 'abc', service: '' }, staffMessage, 'staffMemberId'],
    [{ service: '' }, serviceMessage, 'service'],
    [{ service: 'x'.repeat(81) }, serviceMessage, 'service'],
    [{ service: 7 }, serviceMessage, 'service'],
    [{ service: '', startsAt: 'soon' }, serviceMessage, 'service'],
    [{ startsAt: undefined }, startsAtMessage, 'startsAt'],
    [{ startsAt: '2026-02-30T10:00:00Z' }, startsAtMessage, 'startsAt'],
    [{ startsAt: '2026-11-11T09:30:00' }, startsAtMessage, 'startsAt'],
    [{ startsAt: '2026-11-11T09:30Z' }, startsAtMessage, 'startsAt'],
    [{ startsAt: '2026-11-11T09:30:00Z', durationMinutes: 4, extra: 1 }, durationMessage, 'durationMinutes'],
    [{ startsAt: 'soon', durationMinutes: 4 }, startsAtMessage, 'startsAt'],
    [{ durationMinutes: 481 }, durationMessage, 'durationMinutes'],
    [{ durationMinutes: 30.5 }, durationMessage, 'durationMinutes'],
    [{ durationMinutes: '30' }, durationMessage, 'durationMinutes'],
    [{ durationMinutes: null }, durationMessage, 'durationMinutes'],
    [{ extra: 1, clientId: unknownId }, 'Unknown field.', 'extra'],
    [{ clientId: unknownId, staffMemberId: unknownId, startsAt: '2026-11-09T10:00:00Z' }, 'Choose a client.', 'clientId'],
    [{ staffMemberId: unknownId, startsAt: '2026-11-09T10:00:00Z' }, staffMessage, 'staffMemberId'],
    [{ startsAt: '2026-11-10T10:07:00Z' }, futureMessage, 'startsAt'],
    [{ startsAt: '2026-11-10T11:06:59+01:00' }, futureMessage, 'startsAt'],
  ])('rejects %j with only the first failure', async (change, message, field) => {
    const response = await agent.post('/v1/appointments').send({ ...body, ...change });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(message, field));
    expect(await prisma.appointment.count()).toBe(0);
  });

  it('rejects an inactive staff member', async () => {
    const sam = await createTestStaff({ name: 'Sam', isActive: false });

    const response = await agent.post('/v1/appointments').send({ ...body, staffMemberId: sam.id });

    expect(response.body).toEqual(validation(staffMessage, 'staffMemberId'));
  });

  it('accepts a start one millisecond after now', async () => {
    const response = await agent.post('/v1/appointments').send({ ...body, startsAt: '2026-11-10T10:07:00.001Z' });

    expect(response.status).toBe(201);
  });

  it('rejects a cross-site Origin with 403', async () => {
    const response = await agent.post('/v1/appointments').set('Origin', 'https://evil.test').send(body);

    expect(response.status).toBe(403);
    expect(await prisma.appointment.count()).toBe(0);
  });
});

describe('GET /v1/appointments/{id}', () => {
  it.each(['pending', 'cancelled', 'no_show'] as const)('returns a %s appointment with no link or reasons', async (status) => {
    const appointment = await appointmentFor({ status, startsAt: new Date('2026-11-01T09:00:00Z') });

    const response = await agent.get(`/v1/appointments/${appointment.id}`);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(appointmentFields);
    expect(response.body).toMatchObject({ id: appointment.id, status, startsAt: '2026-11-01T09:00:00.000Z' });
    expect(response.text).not.toContain(appointment.token);
    expect(response.text).not.toContain(appointment.tokenHash);
  });

  it.each([unknownId, 'abc', '%00'])('returns 404 for the id %j', async (id) => {
    const response = await agent.get(`/v1/appointments/${id}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
  });

  it('does not query for an id that is not UUID-shaped', async () => {
    const findUnique = vi.spyOn(prisma.appointment, 'findUnique');

    await agent.get('/v1/appointments/abc');

    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('PATCH /v1/appointments/{id}', () => {
  it('checks 404 before 409 and 422', async () => {
    expect((await agent.patch(`/v1/appointments/${unknownId}`).send({ clientId: 'x' })).body).toEqual(notFound);
    expect((await agent.patch('/v1/appointments/%00').send({})).body).toEqual(notFound);
  });

  it.each(finalStatuses)('returns 409 for a %s appointment, whatever the body', async (status) => {
    const appointment = await appointmentFor({ status });

    for (const change of [{ service: 'Colour' }, {}, { service: '' }, { clientId: maria.id }]) {
      const response = await agent.patch(`/v1/appointments/${appointment.id}`).send(change);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(invalidTransition);
    }
  });

  it.each([
    [{}, 'Change at least one field.', undefined],
    [{ staffMemberId: 'abc', service: '' }, staffMessage, 'staffMemberId'],
    [{ service: '', startsAt: 'soon' }, serviceMessage, 'service'],
    [{ startsAt: '2026-02-30T10:00:00Z', durationMinutes: 4 }, startsAtMessage, 'startsAt'],
    [{ durationMinutes: 481 }, durationMessage, 'durationMinutes'],
    [{ durationMinutes: 4, extra: 1 }, durationMessage, 'durationMinutes'],
    [{ clientId: unknownId }, 'Unknown field.', 'clientId'],
    [{ extra: 1, staffMemberId: unknownId }, 'Unknown field.', 'extra'],
    [{ staffMemberId: unknownId, startsAt: '2026-11-09T10:00:00Z' }, staffMessage, 'staffMemberId'],
    [{ startsAt: '2026-11-10T10:07:00Z' }, futureMessage, 'startsAt'],
  ])('rejects %j with only the first failure', async (change, message, field) => {
    const appointment = await appointmentFor();

    const response = await agent.patch(`/v1/appointments/${appointment.id}`).send(change);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(message, field));
  });

  it('rejects an inactive staff member', async () => {
    const appointment = await appointmentFor();
    const sam = await createTestStaff({ name: 'Sam', isActive: false });

    const response = await agent.patch(`/v1/appointments/${appointment.id}`).send({ staffMemberId: sam.id });

    expect(response.body).toEqual(validation(staffMessage, 'staffMemberId'));
  });

  it('treats the same instant in another offset as no change, even after the start', async () => {
    const statusChangedAt = new Date('2026-11-09T08:00:00Z');
    const appointment = await appointmentFor({
      startsAt: new Date('2026-11-10T09:00:00Z'),
      status: 'confirmed',
      confirmedBy: 'client',
      statusChangedAt,
    });

    const response = await agent
      .patch(`/v1/appointments/${appointment.id}`)
      .send({ startsAt: '2026-11-10T10:00:00+01:00', service: 'Colour' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      service: 'Colour',
      startsAt: '2026-11-10T09:00:00.000Z',
      status: 'confirmed',
      confirmedBy: 'client',
      statusChangedAt: statusChangedAt.toISOString(),
    });
  });

  it('resets a confirmed appointment to pending when the start changes, moving statusChangedAt', async () => {
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: 'staff' });

    const response = await agent.patch(`/v1/appointments/${appointment.id}`).send({ startsAt: '2026-11-12T15:00:00Z' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      startsAt: '2026-11-12T15:00:00.000Z',
      status: 'pending',
      confirmedBy: null,
      statusChangedAt: '2026-11-10T10:07:00.000Z',
    });
  });

  it('keeps statusChangedAt when a pending appointment changes its start', async () => {
    const statusChangedAt = new Date('2026-11-09T08:00:00Z');
    const appointment = await appointmentFor({ statusChangedAt });

    const response = await agent.patch(`/v1/appointments/${appointment.id}`).send({ startsAt: '2026-11-12T15:00:00Z' });

    expect(response.body).toMatchObject({ status: 'pending', statusChangedAt: statusChangedAt.toISOString() });
  });

  it('keeps confirmed when only the service, staff member or duration changes, and returns the Appointment', async () => {
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: 'client' });
    const sam = await createTestStaff({ name: 'Sam' });

    const response = await agent
      .patch(`/v1/appointments/${appointment.id}`)
      .send({ service: 'Colour', staffMemberId: sam.id, durationMinutes: 60 });

    expect(response.status).toBe(200);
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(response.body).toEqual({
      id: appointment.id,
      client: { id: maria.id, name: 'Maria Lopez', phone: '+34 600 123 456' },
      staffMember: { id: sam.id, name: 'Sam' },
      service: 'Colour',
      startsAt: '2026-11-11T09:30:00.000Z',
      durationMinutes: 60,
      status: 'confirmed',
      confirmedBy: 'client',
      cancelledBy: null,
      statusChangedAt: appointment.statusChangedAt.toISOString(),
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    });
  });

  it('keeps the token hash after any edit', async () => {
    const appointment = await appointmentFor();

    await agent.patch(`/v1/appointments/${appointment.id}`).send({ service: 'Colour' });
    await agent.patch(`/v1/appointments/${appointment.id}`).send({ startsAt: '2026-11-12T15:00:00Z' });

    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(stored.tokenHash).toBe(appointment.tokenHash);
  });

  it('edits a started appointment, but a new start must be in the future', async () => {
    const appointment = await appointmentFor({ startsAt: new Date('2026-11-10T09:00:00Z') });
    const path = `/v1/appointments/${appointment.id}`;

    expect((await agent.patch(path).send({ service: 'Colour' })).status).toBe(200);
    expect((await agent.patch(path).send({ startsAt: '2026-11-10T10:00:00Z' })).body).toEqual(
      validation(futureMessage, 'startsAt'),
    );
    expect((await agent.patch(path).send({ startsAt: '2026-11-10T10:08:00Z' })).status).toBe(200);
  });

  it('uses the injected clock for the future check', async () => {
    const appointment = await appointmentFor();
    now = new Date('2026-11-12T16:00:00Z');

    const response = await agent.patch(`/v1/appointments/${appointment.id}`).send({ startsAt: '2026-11-12T15:00:00Z' });

    expect(response.body).toEqual(validation(futureMessage, 'startsAt'));
  });

  it('returns 409 when the status changed after it was checked', async () => {
    const appointment = await appointmentFor({ status: 'cancelled', cancelledBy: 'client' });
    await loadAsIf(appointment.id, 'pending');

    const response = await agent.patch(`/v1/appointments/${appointment.id}`).send({ service: 'Colour' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).service).toBe('Haircut');
  });
});

describe('POST /v1/appointments/{id}/link', () => {
  it('issues a new token and keeps the status', async () => {
    const statusChangedAt = new Date('2026-11-09T08:00:00Z');
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: 'client', statusChangedAt });

    const response = await agent.post(`/v1/appointments/${appointment.id}/link`);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(['appointment', 'confirmationLink', 'message']);
    expect(Object.keys(response.body.appointment).sort()).toEqual(appointmentFields);
    const token = tokenOf(response.body.confirmationLink);
    expect(response.body.confirmationLink).toBe(`http://localhost:5173/c/${token}`);
    expect(response.body.message).toBe(
      `Hi Maria Lopez, this is Demo Studio. Please confirm your Haircut appointment on 11/11/2026 at 10:30: http://localhost:5173/c/${token}`,
    );
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
    expect(stored.tokenHash).toBe(hashConfirmationToken(token));
    expect(stored.tokenHash).not.toBe(appointment.tokenHash);
    expect(response.body.appointment).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'client',
      statusChangedAt: statusChangedAt.toISOString(),
    });
  });

  it('reads the settings in the request', async () => {
    const appointment = await appointmentFor();
    await prisma.businessSettings.update({ where: { id: 1 }, data: { messageTemplate: 'New {link}' } });

    const response = await agent.post(`/v1/appointments/${appointment.id}/link`);

    expect(response.body.message).toBe(`New ${response.body.confirmationLink}`);
  });

  it.each([unknownId, 'abc'])('returns 404 for the id %j', async (id) => {
    const response = await agent.post(`/v1/appointments/${id}/link`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
  });

  it.each(finalStatuses)('returns 409 invalid_transition for a %s appointment, even after the start', async (status) => {
    const appointment = await appointmentFor({ status, startsAt: new Date('2026-11-10T09:00:00Z') });

    const response = await agent.post(`/v1/appointments/${appointment.id}/link`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
  });

  it.each(['2026-11-10T10:07:00Z', '2026-11-10T09:00:00Z'])(
    'returns 409 appointment_started when the start %s is at or before now',
    async (startsAt) => {
      const appointment = await appointmentFor({ status: 'confirmed', startsAt: new Date(startsAt) });

      const response = await agent.post(`/v1/appointments/${appointment.id}/link`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(appointmentStarted);
      const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } });
      expect(stored.tokenHash).toBe(appointment.tokenHash);
    },
  );

  it('returns 409 when the status changed after it was checked', async () => {
    const appointment = await appointmentFor({ status: 'cancelled', cancelledBy: 'staff' });
    await loadAsIf(appointment.id, 'pending');

    const response = await agent.post(`/v1/appointments/${appointment.id}/link`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).tokenHash).toBe(
      appointment.tokenHash,
    );
  });
});

describe('privacy', () => {
  it('logs no client name, phone or token on create, regenerate and a 422', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );

    const created = await agent.post('/v1/appointments').send(body);
    const regenerated = await agent.post(`/v1/appointments/${created.body.appointment.id}/link`);
    await agent.post('/v1/appointments').send({ ...body, startsAt: '2026-11-09T10:00:00Z' });

    expect(regenerated.status).toBe(200);
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    const tokens = [created, regenerated].map(({ body: { confirmationLink } }) => tokenOf(confirmationLink));
    for (const secret of ['Maria Lopez', '+34 600 123 456', ...tokens]) {
      expect(logged).not.toContain(secret);
    }
    expectOnlyRequestLines(spies);
  });
});

function storedRow(id: string) {
  return prisma.appointment.findUniqueOrThrow({ where: { id } });
}

/** Checks a rejected request wrote nothing. */
async function expectUnchanged(appointment: Awaited<ReturnType<typeof appointmentFor>>) {
  const stored = await storedRow(appointment.id);
  expect(stored.status).toBe(appointment.status);
  expect(stored.updatedAt).toEqual(appointment.updatedAt);
  expect(stored.statusChangedAt).toEqual(appointment.statusChangedAt);
}

describe.each(actions)('POST /v1/appointments/{id}/%s', (action) => {
  it.each([unknownId, 'unknown'])('returns 404 for the id %j', async (id) => {
    const response = await agent.post(`/v1/appointments/${id}/${action}`).send({ outcome: 'attended' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
  });

  it('does not query for an id that is not UUID-shaped', async () => {
    const findUnique = vi.spyOn(prisma.appointment, 'findUnique');

    await agent.post(`/v1/appointments/unknown/${action}`);

    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /v1/appointments/{id}/confirm', () => {
  it('confirms a pending appointment by staff and returns the plain Appointment', async () => {
    const appointment = await appointmentFor({ statusChangedAt: new Date('2026-11-09T08:00:00Z') });

    const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`);

    expect(response.status).toBe(200);
    const stored = await storedRow(appointment.id);
    expect(response.body).toEqual({
      id: appointment.id,
      client: { id: maria.id, name: 'Maria Lopez', phone: '+34 600 123 456' },
      staffMember: { id: alex.id, name: 'Alex' },
      service: 'Haircut',
      startsAt: '2026-11-11T09:30:00.000Z',
      durationMinutes: 30,
      status: 'confirmed',
      confirmedBy: 'staff',
      cancelledBy: null,
      statusChangedAt: '2026-11-10T10:07:00.000Z',
      createdAt: stored.createdAt.toISOString(),
      updatedAt: stored.updatedAt.toISOString(),
    });
    expect(stored).toMatchObject({ status: 'confirmed', confirmedBy: 'staff', statusChangedAt: now });
  });

  it.each([['before', undefined], ['after', startedAt]] as const)(
    'returns an already confirmed appointment unchanged %s the start',
    async (_, startsAt) => {
      const appointment = await appointmentFor({
        status: 'confirmed',
        confirmedBy: 'client',
        statusChangedAt: new Date('2026-11-09T08:00:00Z'),
        startsAt,
      });

      const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`).send({ ignored: true });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'confirmed',
        confirmedBy: 'client',
        statusChangedAt: '2026-11-09T08:00:00.000Z',
        updatedAt: appointment.updatedAt.toISOString(),
      });
      await expectUnchanged(appointment);
    },
  );

  it.each(['2026-11-10T10:07:00Z', '2026-11-10T09:00:00Z'])(
    'returns 409 appointment_started for a pending appointment starting %s',
    async (startsAt) => {
      const appointment = await appointmentFor({ startsAt: new Date(startsAt) });

      const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(appointmentStarted);
      await expectUnchanged(appointment);
    },
  );

  it.each(finalStatuses)('returns 409 invalid_transition for a %s appointment before the start', async (status) => {
    const appointment = await appointmentFor({ status });

    const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    await expectUnchanged(appointment);
  });

  it('returns 409 when the status changed after it was checked', async () => {
    const appointment = await appointmentFor({ status: 'cancelled', cancelledBy: 'client' });
    await loadAsIf(appointment.id, 'pending');

    const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    await expectUnchanged(appointment);
  });

  it('returns 409 and keeps the client confirmation when the client confirmed after the check', async () => {
    const statusChangedAt = new Date('2026-11-10T09:00:00Z');
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: 'client', statusChangedAt });
    await loadAsIf(appointment.id, 'pending');

    const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    expect(await storedRow(appointment.id)).toMatchObject({ status: 'confirmed', confirmedBy: 'client', statusChangedAt });
  });

  it('rejects a cross-site Origin with 403', async () => {
    const appointment = await appointmentFor();

    const response = await agent.post(`/v1/appointments/${appointment.id}/confirm`).set('Origin', 'https://evil.test');

    expect(response.status).toBe(403);
    await expectUnchanged(appointment);
  });
});

describe('POST /v1/appointments/{id}/cancel', () => {
  it.each([
    ['pending', null],
    ['confirmed', 'client'],
  ] as const)('cancels a %s appointment by staff, keeping confirmedBy', async (status, confirmedBy) => {
    const appointment = await appointmentFor({ status, confirmedBy });

    const response = await agent.post(`/v1/appointments/${appointment.id}/cancel`).send({ ignored: true });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(appointmentFields);
    const stored = await storedRow(appointment.id);
    expect(response.body).toMatchObject({
      status: 'cancelled',
      cancelledBy: 'staff',
      confirmedBy,
      statusChangedAt: '2026-11-10T10:07:00.000Z',
      updatedAt: stored.updatedAt.toISOString(),
    });
    expect(stored).toMatchObject({ status: 'cancelled', cancelledBy: 'staff', confirmedBy, statusChangedAt: now });
  });

  it.each(['pending', 'confirmed'] as const)('cancels a %s appointment after the start', async (status) => {
    const appointment = await appointmentFor({ status, startsAt: startedAt });

    const response = await agent.post(`/v1/appointments/${appointment.id}/cancel`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'cancelled', cancelledBy: 'staff' });
  });

  it.each(finalStatuses)('returns 409 invalid_transition for a %s appointment', async (status) => {
    const appointment = await appointmentFor({ status });

    const response = await agent.post(`/v1/appointments/${appointment.id}/cancel`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    await expectUnchanged(appointment);
  });

  it('stores the cancel time, so isLateCancellation reads it against the start', async () => {
    const settings = { lateCancellationHours: 24 };
    const late = await appointmentFor({ startsAt: new Date('2026-11-11T09:30:00Z') });
    const afterStart = await appointmentFor({ startsAt: startedAt });
    const early = await appointmentFor({ startsAt: new Date('2026-11-11T10:08:00Z') });

    for (const { id } of [late, afterStart, early]) {
      expect((await agent.post(`/v1/appointments/${id}/cancel`)).status).toBe(200);
    }

    expect(isLateCancellation(await storedRow(late.id), settings)).toBe(true);
    expect(isLateCancellation(await storedRow(afterStart.id), settings)).toBe(true);
    expect(isLateCancellation(await storedRow(early.id), settings)).toBe(false);
  });

  it('returns 409 when the status changed after it was checked', async () => {
    const appointment = await appointmentFor({ status: 'cancelled', cancelledBy: 'client' });
    await loadAsIf(appointment.id, 'pending');

    const response = await agent.post(`/v1/appointments/${appointment.id}/cancel`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    expect(await storedRow(appointment.id)).toMatchObject({ cancelledBy: 'client', updatedAt: appointment.updatedAt });
  });
});

describe('POST /v1/appointments/{id}/outcome', () => {
  it.each([
    ['pending', null, 'no_show', '2026-11-10T10:07:00Z'],
    ['confirmed', 'client', 'attended', '2026-11-10T09:00:00Z'],
  ] as const)('records a started %s appointment as %s', async (status, confirmedBy, outcome, startsAt) => {
    const appointment = await appointmentFor({ status, confirmedBy, startsAt: new Date(startsAt) });

    const response = await agent.post(`/v1/appointments/${appointment.id}/outcome`).send({ outcome });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(appointmentFields);
    const stored = await storedRow(appointment.id);
    expect(response.body).toMatchObject({
      status: outcome,
      confirmedBy,
      cancelledBy: null,
      statusChangedAt: '2026-11-10T10:07:00.000Z',
      updatedAt: stored.updatedAt.toISOString(),
    });
    expect(stored).toMatchObject({ status: outcome, confirmedBy, cancelledBy: null, statusChangedAt: now });
  });

  it.each(finalStatuses)('returns 409 invalid_transition for a %s appointment, whatever the body', async (status) => {
    const appointment = await appointmentFor({ status, startsAt: startedAt });

    for (const change of [{ outcome: 'attended' }, { outcome: 'maybe' }]) {
      const response = await agent.post(`/v1/appointments/${appointment.id}/outcome`).send(change);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(invalidTransition);
    }
    await expectUnchanged(appointment);
  });

  it.each(['pending', 'confirmed'] as const)(
    'returns 409 appointment_not_started for a %s appointment, whatever the body',
    async (status) => {
      const appointment = await appointmentFor({ status, startsAt: new Date('2026-11-10T10:07:01Z') });

      for (const change of [{ outcome: 'attended' }, { outcome: 'maybe' }]) {
        const response = await agent.post(`/v1/appointments/${appointment.id}/outcome`).send(change);

        expect(response.status).toBe(409);
        expect(response.body).toEqual(appointmentNotStarted);
      }
      await expectUnchanged(appointment);
    },
  );

  it.each([
    [{}, outcomeMessage, 'outcome'],
    [{ outcome: null }, outcomeMessage, 'outcome'],
    [{ outcome: 'maybe' }, outcomeMessage, 'outcome'],
    [{ outcome: 'cancelled' }, outcomeMessage, 'outcome'],
    [{ outcome: 'maybe', note: 'x' }, outcomeMessage, 'outcome'],
    [{ outcome: 'attended', note: 'x' }, 'Unknown field.', 'note'],
    [[], 'Request body must be a JSON object.', undefined],
  ])('rejects %j with only the first failure', async (change, message, field) => {
    const appointment = await appointmentFor({ startsAt: startedAt });

    const response = await agent.post(`/v1/appointments/${appointment.id}/outcome`).send(change);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(message, field));
    await expectUnchanged(appointment);
  });

  it('returns 409 when the status changed after it was checked', async () => {
    const appointment = await appointmentFor({ status: 'cancelled', cancelledBy: 'client', startsAt: startedAt });
    await loadAsIf(appointment.id, 'confirmed');

    const response = await agent.post(`/v1/appointments/${appointment.id}/outcome`).send({ outcome: 'no_show' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    await expectUnchanged(appointment);
  });
});

describe('POST /v1/appointments/{id}/undo-outcome', () => {
  it.each([
    ['attended', 'client', 'confirmed'],
    ['no_show', null, 'pending'],
  ] as const)('puts a %s appointment with confirmedBy %s back to %s', async (status, confirmedBy, expected) => {
    const appointment = await appointmentFor({ status, confirmedBy, startsAt: startedAt });

    const response = await agent.post(`/v1/appointments/${appointment.id}/undo-outcome`).send({ ignored: true });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(appointmentFields);
    const stored = await storedRow(appointment.id);
    expect(response.body).toMatchObject({
      status: expected,
      confirmedBy,
      statusChangedAt: '2026-11-10T10:07:00.000Z',
      updatedAt: stored.updatedAt.toISOString(),
    });
    expect(stored).toMatchObject({ status: expected, confirmedBy, statusChangedAt: now });
  });

  it.each(['pending', 'confirmed', 'cancelled'] as const)(
    'returns 409 invalid_transition for a %s appointment',
    async (status) => {
      const appointment = await appointmentFor({ status, startsAt: startedAt });

      const response = await agent.post(`/v1/appointments/${appointment.id}/undo-outcome`);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(invalidTransition);
      await expectUnchanged(appointment);
    },
  );

  it('returns 409 when the status changed after it was checked', async () => {
    const appointment = await appointmentFor({ status: 'pending', startsAt: startedAt });
    await loadAsIf(appointment.id, 'attended');

    const response = await agent.post(`/v1/appointments/${appointment.id}/undo-outcome`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual(invalidTransition);
    await expectUnchanged(appointment);
  });
});

describe('appointment history', () => {
  it('counts a no-show on the client and uncounts it after undo', async () => {
    const appointment = await appointmentFor({ status: 'confirmed', confirmedBy: 'client', startsAt: startedAt });
    const noShowCount = async () => (await agent.get(`/v1/clients/${maria.id}`)).body.noShowCount;

    expect(await noShowCount()).toBe(0);
    await agent.post(`/v1/appointments/${appointment.id}/outcome`).send({ outcome: 'no_show' });
    expect(await noShowCount()).toBe(1);
    await agent.post(`/v1/appointments/${appointment.id}/undo-outcome`);
    expect(await noShowCount()).toBe(0);
  });

  it('goes from create through confirm, outcome and undo', async () => {
    const created = await agent.post('/v1/appointments').send(body);
    const path = `/v1/appointments/${created.body.appointment.id}`;

    expect((await agent.post(`${path}/confirm`)).body).toMatchObject({ status: 'confirmed', confirmedBy: 'staff' });
    now = new Date('2026-11-11T09:45:00Z');
    expect((await agent.post(`${path}/outcome`).send({ outcome: 'attended' })).body).toMatchObject({
      status: 'attended',
      statusChangedAt: '2026-11-11T09:45:00.000Z',
    });
    now = new Date('2026-11-11T09:50:00Z');
    expect((await agent.post(`${path}/undo-outcome`)).body).toMatchObject({
      status: 'confirmed',
      confirmedBy: 'staff',
      cancelledBy: null,
      statusChangedAt: '2026-11-11T09:50:00.000Z',
    });
  });

  it('logs no client name, phone or token on any action', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const appointment = await appointmentFor({ startsAt: startedAt });
    const path = `/v1/appointments/${appointment.id}`;

    await agent.post(`${path}/confirm`);
    await agent.post(`${path}/outcome`).send({ outcome: 'maybe' });
    await agent.post(`${path}/outcome`).send({ outcome: 'no_show' });
    await agent.post(`${path}/undo-outcome`);
    await agent.post(`${path}/cancel`);

    expect((await storedRow(appointment.id)).status).toBe('cancelled');
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    for (const secret of ['Maria Lopez', '+34 600 123 456', appointment.token]) {
      expect(logged).not.toContain(secret);
    }
    expectOnlyRequestLines(spies);
  });
});
