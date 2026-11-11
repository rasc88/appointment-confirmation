import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemoData } from '../prisma/seed.js';
import { createApp } from './app.js';
import { prisma } from './db.js';
import type { StaffMember } from './generated/prisma/client.js';
import { createTestStaff, resetDatabase, signIn, testPassword } from './test-helpers.js';

const staffFields = ['createdAt', 'email', 'id', 'isActive', 'name'];
const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const jordan = { name: 'Jordan', email: 'Jordan@Demo.test', password: 'secret123' };

function validation(field: string, message: string) {
  return { error: { code: 'validation_error', message, field } };
}

let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let sam: StaffMember;
let agent: Awaited<ReturnType<typeof signIn>>;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  sam = await createTestStaff({ name: 'Sam', email: 'sam@demo.test' });
  agent = await signIn(app, alex.email);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function snapshot() {
  return prisma.staffMember.findMany({ orderBy: { email: 'asc' } });
}

describe('GET /v1/staff', () => {
  it('lists every account, active and inactive, in createdAt then email order', async () => {
    const createdAt = new Date('2026-11-01T08:00:00Z');
    await prisma.staffMember.update({ where: { id: sam.id }, data: { isActive: false } });
    const [zed, amy] = await Promise.all([
      createTestStaff({ name: 'Zed', email: 'zed@demo.test' }),
      createTestStaff({ name: 'Amy', email: 'amy@demo.test' }),
    ]);
    await prisma.staffMember.updateMany({ where: { id: { in: [zed.id, amy.id] } }, data: { createdAt } });

    const response = await agent.get('/v1/staff');

    expect(response.status).toBe(200);
    expect(response.body.map(({ name, isActive }: { name: string; isActive: boolean }) => [name, isActive])).toEqual([
      ['Amy', true],
      ['Zed', true],
      ['Alex', true],
      ['Sam', false],
    ]);
    for (const staffMember of response.body) {
      expect(Object.keys(staffMember).sort()).toEqual(staffFields);
    }
  });

  it('lists the seed accounts as Alex then Sam', { timeout: 30_000 }, async () => {
    await seedDemoData(prisma);
    const seeded = await signIn(app, 'alex@demo.test', 'demo1234');

    const response = await seeded.get('/v1/staff');

    expect(response.body.map(({ name }: { name: string }) => name)).toEqual(['Alex', 'Sam']);
  });
});

describe('POST /v1/staff', () => {
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
    [{ email: jordan.email, password: jordan.password }, 'name', 'Must be between 1 and 80 characters.'],
    [{ ...jordan, name: 7 }, 'name', 'Must be between 1 and 80 characters.'],
    [{ ...jordan, email: null }, 'email', 'Enter a valid email address.'],
    [{ name: jordan.name, email: jordan.email }, 'password', 'Must be between 8 and 72 characters.'],
    [{ ...jordan, isActive: false }, 'isActive', 'Unknown field.'],
    [{ ...jordan, name: '', extra: 1 }, 'name', 'Must be between 1 and 80 characters.'],
  ])('rejects %j with 422 on %s and writes nothing', async (body, field, message) => {
    const before = await snapshot();

    const response = await agent.post('/v1/staff').send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(field, message));
    expect(await snapshot()).toEqual(before);
  });

  it('accepts lengths at the limits, counted in code points', async () => {
    const atLimits = { name: '😀'.repeat(80), email: `${'x'.repeat(244)}@demo.test`, password: '😀'.repeat(72) };

    const response = await agent.post('/v1/staff').send(atLimits);
    const shortest = await agent.post('/v1/staff').send({ name: 'K', email: 'kim@demo.test', password: '12345678' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: '😀'.repeat(80), email: atLimits.email });
    expect(shortest.status).toBe(201);
  });

  it('stores the account with a lowercased email and a cost-12 hash, and returns the StaffMember', async () => {
    const response = await agent.post('/v1/staff').send(jordan);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: expect.any(String),
      name: 'Jordan',
      email: 'jordan@demo.test',
      isActive: true,
      createdAt: expect.stringMatching(/Z$/),
    });
    const stored = await prisma.staffMember.findUniqueOrThrow({ where: { id: response.body.id } });
    expect(stored.passwordHash).toMatch(/^\$2b\$12\$/);
    expect(await bcrypt.compare('secret123', stored.passwordHash)).toBe(true);
  });

  it('lets the new account sign in with its email in any case', async () => {
    await agent.post('/v1/staff').send(jordan);

    await expect(signIn(app, 'JORDAN@demo.TEST', 'secret123')).resolves.toBeDefined();
  });

  it.each(['SAM@demo.test', 'sam@demo.test'])('rejects the used email %j with 409 email_taken', async (email) => {
    const response = await agent.post('/v1/staff').send({ ...jordan, email });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'email_taken', message: 'Another staff account already has this email.' },
    });
    expect(await prisma.staffMember.count()).toBe(2);
  });

  it('rejects the email of an inactive account', async () => {
    await prisma.staffMember.update({ where: { id: sam.id }, data: { isActive: false } });

    expect((await agent.post('/v1/staff').send({ ...jordan, email: 'sam@demo.test' })).status).toBe(409);
  });

  it('lets only one of two concurrent creates with the same email succeed', async () => {
    const statuses = await Promise.all([agent.post('/v1/staff').send(jordan), agent.post('/v1/staff').send(jordan)]);

    expect(statuses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('checks 401 before 422', async () => {
    const response = await request(app).post('/v1/staff').send({});

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });

  it('checks the Origin before 401', async () => {
    expect((await request(app).post('/v1/staff').set('Origin', 'https://evil.test').send(jordan)).status).toBe(403);
  });
});

describe('PATCH /v1/staff/{id}', () => {
  it.each(['unknown', '%00', '00000000-0000-4000-8000-000000000000'])('returns 404 for the id %j', async (id) => {
    const response = await agent.patch(`/v1/staff/${id}`).send({ isActive: false });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it('checks 404 before 422', async () => {
    expect((await agent.patch('/v1/staff/unknown').send({})).status).toBe(404);
  });

  it('checks 401 before 404', async () => {
    expect((await request(app).patch('/v1/staff/unknown').send({ isActive: false })).status).toBe(401);
  });

  it('rejects an empty body with no field', async () => {
    const response = await agent.patch(`/v1/staff/${sam.id}`).send({});

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: 'validation_error', message: 'Change at least one field.' } });
  });

  it.each([
    [{ name: '', isActive: false }, 'name', 'Must be between 1 and 80 characters.'],
    [{ name: 'x'.repeat(81) }, 'name', 'Must be between 1 and 80 characters.'],
    [{ name: null }, 'name', 'Must be between 1 and 80 characters.'],
    [{ isActive: 'false' }, 'isActive', 'Must be true or false.'],
    [{ isActive: null }, 'isActive', 'Must be true or false.'],
    [{ email: 'new@demo.test' }, 'email', 'Unknown field.'],
    [{ name: 'Samuel', password: 'secret123' }, 'password', 'Unknown field.'],
  ])('rejects %j with 422 on %s and writes nothing', async (body, field, message) => {
    const before = await snapshot();

    const response = await agent.patch(`/v1/staff/${sam.id}`).send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(field, message));
    expect(await snapshot()).toEqual(before);
  });

  it('checks the name before deactivating yourself', async () => {
    const response = await agent.patch(`/v1/staff/${alex.id}`).send({ name: '', isActive: false });

    expect(response.status).toBe(422);
    expect(response.body.error.field).toBe('name');
  });

  it('rejects deactivating yourself with 409, even with a rename, and writes nothing', async () => {
    const before = await snapshot();

    const response = await agent.patch(`/v1/staff/${alex.id}`).send({ name: 'Alexandra', isActive: false });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: { code: 'cannot_deactivate_self', message: 'You cannot deactivate your own account.' },
    });
    expect(await snapshot()).toEqual(before);
  });

  it('allows isActive: true on yourself', async () => {
    const response = await agent.patch(`/v1/staff/${alex.id}`).send({ isActive: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: alex.id, isActive: true });
  });

  it('renames an account and returns exactly the StaffMember fields', async () => {
    const response = await agent.patch(`/v1/staff/${sam.id}`).send({ name: '😀'.repeat(80) });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: sam.id,
      name: '😀'.repeat(80),
      email: 'sam@demo.test',
      isActive: true,
      createdAt: sam.createdAt.toISOString(),
    });
  });

  it('deactivates and reactivates another account, which signs in with its existing password', async () => {
    const deactivated = await agent.patch(`/v1/staff/${sam.id}`).send({ isActive: false });
    const again = await agent.patch(`/v1/staff/${sam.id}`).send({ isActive: false });

    expect(deactivated.body).toMatchObject({ isActive: false });
    expect(again.status).toBe(200);
    expect(again.body).toEqual(deactivated.body);
    await expect(signIn(app, sam.email)).rejects.toThrow('Sign-in failed with 401');

    const reactivated = await agent.patch(`/v1/staff/${sam.id}`).send({ isActive: true });

    expect(reactivated.body).toMatchObject({ isActive: true });
    await expect(signIn(app, sam.email, testPassword)).resolves.toBeDefined();
  });

  it('keeps the appointments of a deactivated account', async () => {
    const client = await prisma.client.create({ data: { name: 'Ana Torres' } });
    await prisma.appointment.create({
      data: {
        clientId: client.id,
        staffMemberId: sam.id,
        service: 'Haircut',
        startsAt: new Date('2026-11-11T09:00:00Z'),
        durationMinutes: 30,
        tokenHash: 'a'.repeat(64),
      },
    });
    const before = await prisma.appointment.findMany();

    await agent.patch(`/v1/staff/${sam.id}`).send({ isActive: false });

    expect(await prisma.appointment.findMany()).toEqual(before);
  });
});

describe('a member deactivated after signing in', () => {
  it('gets 401 on every staff endpoint with the same cookie, and is back after reactivation', async () => {
    const samAgent = await signIn(app, sam.email);
    await prisma.staffMember.update({ where: { id: sam.id }, data: { isActive: false } });

    const requests = () => [
      samAgent.get('/v1/auth/me'),
      samAgent.get('/v1/staff'),
      samAgent.post('/v1/staff').send(jordan),
      samAgent.patch(`/v1/staff/${alex.id}`).send({ name: 'Alexandra' }),
    ];
    for (const response of await Promise.all(requests())) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(unauthenticated);
    }
    expect(await prisma.staffMember.count()).toBe(2);

    await prisma.staffMember.update({ where: { id: sam.id }, data: { isActive: true } });

    expect((await samAgent.get('/v1/auth/me')).status).toBe(200);
    expect((await samAgent.get('/v1/staff')).status).toBe(200);
  });
});
