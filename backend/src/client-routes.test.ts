import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import type { StaffMember } from './generated/prisma/client.js';
import { createTestAppointment, createTestClient, createTestStaff, resetDatabase, signIn } from './test-helpers.js';

const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const notFound = { error: { code: 'not_found', message: 'Not found.' } };
const searchMessage = 'Enter 1 to 80 characters to search.';
const nameMessage = "Enter the client's name, up to 80 characters.";
const phoneMessage = 'Use only digits, spaces, +, ( ) and -, up to 30 characters.';
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

function validation(message: string, field?: string) {
  return { error: field === undefined ? { code: 'validation_error', message } : { code: 'validation_error', message, field } };
}

let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let agent: Awaited<ReturnType<typeof signIn>>;

beforeEach(async () => {
  await resetDatabase();
  app = createApp({ now: () => new Date('2026-11-10T10:07:00Z') });
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  agent = await signIn(app, alex.email);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function searchNames(query: string) {
  const response = await agent.get(`/v1/clients${query}`);
  expect(response.status).toBe(200);
  return response.body.map(({ name }: { name: string }) => name);
}

describe('session', () => {
  it.each([
    ['get', '/v1/clients?q='],
    ['post', '/v1/clients'],
    ['get', '/v1/clients/abc'],
    ['get', '/v1/clients/00000000-0000-4000-8000-000000000000'],
  ] as const)('%s %s without a session is 401 before 404 or 422', async (method, path) => {
    const response = await request(app)[method](path).send({ name: '' });

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });
});

describe('GET /v1/clients', () => {
  it('returns the first 20 clients by name without q', async () => {
    const names = Array.from({ length: 25 }, (_, index) => `Client ${String(25 - index).padStart(2, '0')}`);
    await prisma.client.createMany({ data: names.map((name) => ({ name })) });

    expect(await searchNames('')).toEqual([...names].sort().slice(0, 20));
  });

  it('matches name or phone case-insensitively by substring, sorted by name then id', async () => {
    await createTestClient({ name: 'Mario Rossi' });
    await createTestClient({ name: 'Omar', phone: '+44 7700 900' });
    await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });
    await createTestClient({ name: 'Sam', phone: null });
    const [first, second] = await Promise.all([createTestClient({ name: 'Twin' }), createTestClient({ name: 'Twin' })]);

    expect(await searchNames('?q=mar')).toEqual(['Maria Lopez', 'Mario Rossi', 'Omar']);
    expect(await searchNames('?q=600%201')).toEqual(['Maria Lopez']);
    expect(await searchNames('?q=MARIA')).toEqual(['Maria Lopez']);
    expect(await searchNames('?q=xyz')).toEqual([]);
    const twins = await agent.get('/v1/clients?q=twin');
    expect(twins.body.map(({ id }: { id: string }) => id)).toEqual([first.id, second.id].sort());
  });

  it('returns exactly the Client fields', async () => {
    const client = await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });

    const response = await agent.get('/v1/clients?q=maria');

    expect(response.body).toEqual([
      { id: client.id, name: 'Maria Lopez', phone: '+34 600 123 456', createdAt: client.createdAt.toISOString() },
    ]);
  });

  it('returns at most 20 matches', async () => {
    await prisma.client.createMany({ data: Array.from({ length: 22 }, (_, index) => ({ name: `Ana ${index}` })) });

    expect(await searchNames('?q=ana')).toHaveLength(20);
  });

  it.each([
    ['%25', ['100% Sam']],
    ['_', ['Ann_B']],
    ['%5C', ['a\\b']],
  ])('treats q=%s literally', async (query, expected) => {
    for (const name of ['100% Sam', 'Ann_B', 'a\\b', 'Plain']) {
      await createTestClient({ name });
    }

    expect(await searchNames(`?q=${query}`)).toEqual(expected);
  });

  it.each(['?q=', `?q=${'x'.repeat(81)}`, '?q=a&q=b'])('rejects %s with 422 on q', async (query) => {
    const response = await agent.get(`/v1/clients${query}`);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(searchMessage, 'q'));
  });

  it('counts q in code points and ignores other query parameters', async () => {
    await createTestClient({ name: 'Maria Lopez' });

    expect(await searchNames(`?q=${encodeURIComponent('😀'.repeat(80))}`)).toEqual([]);
    expect(await searchNames('?q=maria&limit=1&page=2')).toEqual(['Maria Lopez']);
  });
});

describe('POST /v1/clients', () => {
  it('creates a client and returns exactly the Client fields', async () => {
    const response = await agent.post('/v1/clients').send({ name: 'Maria Lopez', phone: '+34 (600) 123-456' });

    expect(response.status).toBe(201);
    const stored = await prisma.client.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(response.body).toEqual({
      id: stored.id,
      name: 'Maria Lopez',
      phone: '+34 (600) 123-456',
      createdAt: stored.createdAt.toISOString(),
    });
  });

  it.each([{ name: 'Sam' }, { name: 'Sam', phone: null }])('stores a missing or null phone as null: %j', async (body) => {
    const response = await agent.post('/v1/clients').send(body);

    expect(response.status).toBe(201);
    expect(response.body.phone).toBeNull();
  });

  it('allows duplicate names and phones, and keeps names untrimmed', async () => {
    const body = { name: ' Sam ', phone: '600' };

    expect((await agent.post('/v1/clients').send(body)).status).toBe(201);
    expect((await agent.post('/v1/clients').send(body)).body.name).toBe(' Sam ');
    expect(await prisma.client.count()).toBe(2);
  });

  it('accepts a name of 80 code points and a phone of 30 characters', async () => {
    const response = await agent.post('/v1/clients').send({ name: '😀'.repeat(80), phone: '1'.repeat(30) });

    expect(response.status).toBe(201);
  });

  it.each([
    [{}, nameMessage, 'name'],
    [{ name: '' }, nameMessage, 'name'],
    [{ name: 'x'.repeat(81) }, nameMessage, 'name'],
    [{ name: 42 }, nameMessage, 'name'],
    [{ name: null }, nameMessage, 'name'],
    [{ name: '', phone: 'abc' }, nameMessage, 'name'],
    [{ name: 'Sam', phone: '' }, phoneMessage, 'phone'],
    [{ name: 'Sam', phone: 'abc' }, phoneMessage, 'phone'],
    [{ name: 'Sam', phone: '1'.repeat(31) }, phoneMessage, 'phone'],
    [{ name: 'Sam', phone: 600 }, phoneMessage, 'phone'],
    [{ name: 'Sam', email: 'x' }, 'Unknown field.', 'email'],
    [{ name: '', email: 'x' }, nameMessage, 'name'],
  ])('rejects %j', async (body, message, field) => {
    const response = await agent.post('/v1/clients').send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(message, field));
    expect(await prisma.client.count()).toBe(0);
  });

  it('rejects a NUL in the name with 422 and no field, and logs nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await agent.post('/v1/clients').send({ name: 'Sam\u0000' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Text must not contain the NUL character.'));
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('checks the Origin before 401', async () => {
    const response = await request(app).post('/v1/clients').set('Origin', 'https://evil.test').send({ name: 'Sam' });

    expect(response.status).toBe(403);
  });
});

describe('request bodies that cannot be read', () => {
  it.each([
    ['an unsupported charset', { 'Content-Type': 'application/json; charset=latin1' }, '{"name":"Sam"}'],
    ['an unknown encoding', { 'Content-Type': 'application/json', 'Content-Encoding': 'foo' }, '{"name":"Sam"}'],
    ['gzip on an uncompressed body', { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, '{"name":"Sam"}'],
  ])('returns 422 without field for %s and logs nothing', async (_label, headers, body) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await agent.post('/v1/clients').set(headers).send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Request body could not be read.'));
    expect(consoleError).not.toHaveBeenCalled();
    expect(await prisma.client.count()).toBe(0);
  });

  it('keeps the messages for malformed JSON and a body over 100 kB', async () => {
    const malformed = await agent.post('/v1/clients').set('Content-Type', 'application/json').send('{"name":');
    const tooLarge = await agent.post('/v1/clients').send({ name: 'x'.repeat(101 * 1024) });

    expect(malformed.body).toEqual(validation('Request body must be valid JSON.'));
    expect(tooLarge.body).toEqual(validation('Request body is too large.'));
  });
});

describe('GET /v1/clients/{id}', () => {
  it('returns the client with every appointment, newest first, and the no-show count', async () => {
    const client = await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });
    const other = await createTestClient({ name: 'Other' });
    const sam = await createTestStaff({ name: 'Sam', isActive: false });
    const sameStart = new Date('2026-10-01T09:00:00Z');
    const appointments = await Promise.all([
      createTestAppointment({ clientId: client.id, staffMemberId: alex.id, startsAt: new Date('2026-11-11T09:30:00Z') }),
      createTestAppointment({ clientId: client.id, staffMemberId: sam.id, startsAt: sameStart, status: 'no_show' }),
      createTestAppointment({ clientId: client.id, staffMemberId: alex.id, startsAt: sameStart, status: 'no_show' }),
      createTestAppointment({
        clientId: client.id,
        staffMemberId: alex.id,
        startsAt: new Date('2026-10-20T15:00:00Z'),
        status: 'cancelled',
        cancelledBy: 'client',
      }),
      createTestAppointment({ clientId: other.id, staffMemberId: alex.id, status: 'no_show' }),
    ]);
    const [upcoming, samNoShow, alexNoShow, cancelled] = appointments;
    const tied = [samNoShow, alexNoShow].sort((a, b) => a.id.localeCompare(b.id));

    const response = await agent.get(`/v1/clients/${client.id}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: client.id,
      name: 'Maria Lopez',
      phone: '+34 600 123 456',
      createdAt: client.createdAt.toISOString(),
      noShowCount: 2,
    });
    expect(Object.keys(response.body).sort()).toEqual(['appointments', 'createdAt', 'id', 'name', 'noShowCount', 'phone']);
    expect(response.body.appointments.map(({ id }: { id: string }) => id)).toEqual([
      upcoming.id,
      cancelled.id,
      ...tied.map(({ id }) => id),
    ]);
    for (const appointment of response.body.appointments) {
      expect(Object.keys(appointment).sort()).toEqual(appointmentFields);
    }
    expect(response.body.appointments[0]).toEqual({
      id: upcoming.id,
      client: { id: client.id, name: 'Maria Lopez', phone: '+34 600 123 456' },
      staffMember: { id: alex.id, name: 'Alex' },
      service: 'Haircut',
      startsAt: '2026-11-11T09:30:00.000Z',
      durationMinutes: 30,
      status: 'pending',
      confirmedBy: null,
      cancelledBy: null,
      statusChangedAt: upcoming.statusChangedAt.toISOString(),
      createdAt: upcoming.createdAt.toISOString(),
      updatedAt: upcoming.updatedAt.toISOString(),
    });
    expect(response.body.appointments.find(({ id }: { id: string }) => id === samNoShow.id).staffMember).toEqual({
      id: sam.id,
      name: 'Sam',
    });
  });

  it('returns noShowCount 0 and no appointments for a new client', async () => {
    const client = await createTestClient();

    const response = await agent.get(`/v1/clients/${client.id}`);

    expect(response.body).toMatchObject({ noShowCount: 0, appointments: [] });
  });

  it('makes two queries however many appointments and staff there are', async () => {
    const client = await createTestClient();
    const sam = await createTestStaff({ name: 'Sam' });
    for (const staffMember of [alex, sam, alex]) {
      await createTestAppointment({ clientId: client.id, staffMemberId: staffMember.id });
    }
    const spies = [
      vi.spyOn(prisma.client, 'findUnique'),
      vi.spyOn(prisma.client, 'findMany'),
      vi.spyOn(prisma.appointment, 'findUnique'),
      vi.spyOn(prisma.appointment, 'findMany'),
      vi.spyOn(prisma.staffMember, 'findMany'),
    ];

    const response = await agent.get(`/v1/clients/${client.id}`);

    expect(response.body.appointments).toHaveLength(3);
    expect(spies.map((spy) => spy.mock.calls.length)).toEqual([1, 0, 0, 1, 0]);
  });

  it.each(['00000000-0000-4000-8000-000000000000', 'abc', '%00'])('returns 404 for the id %j', async (id) => {
    const response = await agent.get(`/v1/clients/${id}`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
  });

  it('queries only for a UUID-shaped id, in either case', async () => {
    const findUnique = vi.spyOn(prisma.client, 'findUnique');

    await agent.get('/v1/clients/%00');
    await agent.get('/v1/clients/abc');
    expect(findUnique).not.toHaveBeenCalled();
    await agent.get('/v1/clients/0B8F6A52-3C1E-4D7A-9F20-6E5B1C2D3A41');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
