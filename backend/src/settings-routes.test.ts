import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import type { StaffMember } from './generated/prisma/client.js';
import { createSessionToken } from './session.js';
import { createTestAppointment, createTestClient, createTestStaff, resetDatabase, signIn } from './test-helpers.js';

const sessionSecret = process.env.SESSION_SECRET!;
const appOrigin = new URL(process.env.PUBLIC_BASE_URL!).origin;
const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const settingsFields = [
  'businessName',
  'defaultDurationMinutes',
  'lateCancellationHours',
  'messageTemplate',
  'noReplyWindowHours',
  'noShowLookbackDays',
  'noShowThreshold',
  'timeZone',
  'updatedAt',
];
const defaultSettings = {
  businessName: 'My Business',
  timeZone: 'UTC',
  noReplyWindowHours: 24,
  noShowThreshold: 1,
  noShowLookbackDays: 180,
  lateCancellationHours: 12,
  defaultDurationMinutes: 30,
  messageTemplate:
    'Hi {client}, this is {business}. Please confirm your {service} appointment on {date} at {time}: {link}',
};
const allChanged = {
  businessName: 'Studio Two',
  timeZone: 'Europe/Madrid',
  noReplyWindowHours: 48,
  noShowThreshold: 3,
  noShowLookbackDays: 90,
  lateCancellationHours: 0,
  defaultDurationMinutes: 45,
  messageTemplate: 'Hi {client}: {link}',
};
const nameMessage = 'Must be between 1 and 80 characters.';
const timeZoneMessage = 'Must be an IANA time zone, for example Europe/Madrid.';
const templateLengthMessage = 'Must be between 1 and 500 characters.';
const ranges = [
  ['noReplyWindowHours', 1, 168],
  ['noShowThreshold', 1, 10],
  ['noShowLookbackDays', 7, 730],
  ['lateCancellationHours', 0, 168],
  ['defaultDurationMinutes', 5, 480],
] as const;

function validation(message: string, field?: string) {
  return { error: field === undefined ? { code: 'validation_error', message } : { code: 'validation_error', message, field } };
}

let now: Date;
let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let agent: Awaited<ReturnType<typeof signIn>>;

beforeEach(async () => {
  await resetDatabase();
  now = new Date('2026-11-10T10:07:00Z');
  app = createApp({ now: () => now });
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  agent = await signIn(app, alex.email);
});

afterAll(async () => {
  await prisma.$disconnect();
});

function patchRaw(json: string) {
  return agent.patch('/v1/settings').set('Content-Type', 'application/json').send(json);
}

/** Seeds the row with a known `updatedAt`, so a test can tell whether a PATCH wrote it. */
async function seedSettings() {
  return prisma.businessSettings.create({
    data: { id: 1, businessName: 'Old Name', updatedAt: new Date('2026-11-01T08:00:00Z') },
  });
}

async function expectUnchanged(before: Awaited<ReturnType<typeof seedSettings>>) {
  expect(await prisma.businessSettings.findMany()).toEqual([before]);
}

describe('session', () => {
  it.each([
    ['no cookie', () => undefined],
    ['a bad signature', (id: string) => `session=${createSessionToken(id, sessionSecret)}x`],
    ['an inactive staff member', (id: string, inactiveId: string) => `session=${createSessionToken(inactiveId, sessionSecret)}`],
  ])('GET and PATCH are 401 with %s', async (_label, cookieFor) => {
    const inactive = await createTestStaff({ isActive: false });
    const cookie = cookieFor(alex.id, inactive.id);

    for (const method of ['get', 'patch'] as const) {
      const pending = request(app)[method]('/v1/settings');
      const response = await (cookie ? pending.set('Cookie', cookie) : pending).send({ noShowThreshold: 0 });
      expect(response.status).toBe(401);
      expect(response.body).toEqual(unauthenticated);
    }
  });

  it('GET is 401 with an expired session', async () => {
    vi.useFakeTimers({ now: new Date('2020-01-01T00:00:00Z'), toFake: ['Date'] });
    const expiredToken = createSessionToken(alex.id, sessionSecret);
    vi.useRealTimers();

    const response = await request(app).get('/v1/settings').set('Cookie', `session=${expiredToken}`);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });
});

describe('GET /v1/settings', () => {
  it('creates the row with the spec 6.7 defaults when there is none', async () => {
    const response = await agent.get('/v1/settings');

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(settingsFields);
    expect(response.body).toMatchObject(defaultSettings);
    expect(new Date(response.body.updatedAt).toISOString()).toBe(response.body.updatedAt);
    const rows = await prisma.businessSettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    expect(rows[0].updatedAt.toISOString()).toBe(response.body.updatedAt);
  });

  it('returns the stored row', async () => {
    await seedSettings();

    const response = await agent.get('/v1/settings');

    expect(response.body).toEqual({ ...defaultSettings, businessName: 'Old Name', updatedAt: '2026-11-01T08:00:00.000Z' });
  });

  it('is not subject to the Origin check', async () => {
    const response = await agent.get('/v1/settings').set('Origin', 'https://evil.example');

    expect(response.status).toBe(200);
  });
});

describe('PATCH /v1/settings: who and in which order', () => {
  it('rejects a foreign Origin with a valid body and writes nothing', async () => {
    const before = await seedSettings();

    const response = await agent.patch('/v1/settings').set('Origin', 'https://evil.example').send({ businessName: 'New' });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: 'cross_site_request', message: 'Cross-site requests are not allowed.' } });
    await expectUnchanged(before);
  });

  it('accepts the app Origin and no Origin', async () => {
    expect((await agent.patch('/v1/settings').set('Origin', appOrigin).send({ businessName: 'A' })).status).toBe(200);
    expect((await agent.patch('/v1/settings').send({ businessName: 'B' })).status).toBe(200);
  });

  it('reports malformed JSON before the session', async () => {
    const response = await request(app)
      .patch('/v1/settings')
      .set('Content-Type', 'application/json')
      .send('{"businessName":');

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Request body must be valid JSON.'));
  });

  it('reports a foreign Origin before malformed JSON', async () => {
    const response = await request(app)
      .patch('/v1/settings')
      .set('Origin', 'https://evil.example')
      .set('Content-Type', 'application/json')
      .send('{');

    expect(response.status).toBe(403);
  });

  it.each(['[]', '"x"', 'null'])('rejects %s as not a JSON object', async (json) => {
    const response = await patchRaw(json);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Request body must be a JSON object.'));
  });

  it('rejects an empty object', async () => {
    const response = await agent.patch('/v1/settings').send({});

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Change at least one setting.'));
  });
});

describe('PATCH /v1/settings: field checks', () => {
  it.each([
    [{ businessName: '' }, 'businessName', nameMessage],
    [{ businessName: '😀'.repeat(81) }, 'businessName', nameMessage],
    [{ businessName: null }, 'businessName', nameMessage],
    [{ businessName: 1 }, 'businessName', nameMessage],
    [{ timeZone: 'Mars/Base' }, 'timeZone', timeZoneMessage],
    [{ timeZone: 'europe/madrid' }, 'timeZone', timeZoneMessage],
    [{ timeZone: '+01:00' }, 'timeZone', timeZoneMessage],
    [{ timeZone: '' }, 'timeZone', timeZoneMessage],
    [{ timeZone: 1 }, 'timeZone', timeZoneMessage],
    [{ timeZone: null }, 'timeZone', timeZoneMessage],
    [{ messageTemplate: '' }, 'messageTemplate', templateLengthMessage],
    [{ messageTemplate: `${'😀'.repeat(495)}{link}` }, 'messageTemplate', templateLengthMessage],
    [{ messageTemplate: 1 }, 'messageTemplate', templateLengthMessage],
    [{ messageTemplate: null }, 'messageTemplate', templateLengthMessage],
    [
      { messageTemplate: 'Hi {Link}' },
      'messageTemplate',
      'Unknown placeholder {Link}. Allowed: {client}, {business}, {service}, {staff}, {date}, {time}, {link}.',
    ],
    [
      { messageTemplate: 'Hi { link }' },
      'messageTemplate',
      'Unknown placeholder { link }. Allowed: {client}, {business}, {service}, {staff}, {date}, {time}, {link}.',
    ],
    [{ messageTemplate: 'no link' }, 'messageTemplate', 'Must contain {link}.'],
  ])('rejects %j', async (body, field, message) => {
    const before = await seedSettings();

    const response = await agent.patch('/v1/settings').send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(message, field));
    await expectUnchanged(before);
  });

  it.each([
    { businessName: '😀'.repeat(80) },
    { businessName: ' ' },
    { timeZone: 'Europe/Madrid' },
    { timeZone: 'America/New_York' },
    { timeZone: 'UTC' },
    { messageTemplate: `${'😀'.repeat(494)}{link}` },
    { messageTemplate: 'A lone { is plain text: {link}' },
  ])('accepts %j and stores it as sent', async (body) => {
    const response = await agent.patch('/v1/settings').send(body);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(body);
    expect(await prisma.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject(body);
  });

  describe.each(ranges)('%s', (field, min, max) => {
    const message = `Must be a whole number between ${min} and ${max}.`;

    it.each([min, max])('accepts %s', async (value) => {
      const response = await agent.patch('/v1/settings').send({ [field]: value });

      expect(response.status).toBe(200);
      expect(response.body[field]).toBe(value);
    });

    it.each([min - 1, max + 1, 1.5, '24', null, true])('rejects %j', async (value) => {
      const response = await agent.patch('/v1/settings').send({ [field]: value });

      expect(response.status).toBe(422);
      expect(response.body).toEqual(validation(message, field));
    });

    it('rejects 1e400', async () => {
      const response = await patchRaw(`{"${field}": 1e400}`);

      expect(response.status).toBe(422);
      expect(response.body).toEqual(validation(message, field));
    });
  });

  it('accepts 24.0 as the JSON integer 24', async () => {
    const response = await patchRaw('{"noReplyWindowHours": 24.0}');

    expect(response.status).toBe(200);
    expect(response.body.noReplyWindowHours).toBe(24);
  });

  it.each([
    [{ messageTemplate: 'no link', businessName: '' }, 'businessName', nameMessage],
    [{ defaultDurationMinutes: 1, noReplyWindowHours: 0 }, 'noReplyWindowHours', 'Must be a whole number between 1 and 168.'],
    [{ timeZone: 'Mars/Base', noShowThreshold: 0 }, 'timeZone', timeZoneMessage],
    [{ foo: 1 }, 'foo', 'Unknown field.'],
    [{ foo: 1, noShowThreshold: 0 }, 'noShowThreshold', 'Must be a whole number between 1 and 10.'],
    [{ updatedAt: '2026-01-01T00:00:00Z' }, 'updatedAt', 'Unknown field.'],
    [{ id: 2 }, 'id', 'Unknown field.'],
  ])('reports the first failure in check order for %j', async (body, field, message) => {
    const response = await agent.patch('/v1/settings').send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation(message, field));
  });

  it.each([{ businessName: 'A\u0000B' }, { messageTemplate: 'A\u0000B {link}' }])(
    'rejects %j with a NUL without field and writes nothing',
    async (body) => {
      const before = await seedSettings();

      const response = await agent.patch('/v1/settings').send(body);

      expect(response.status).toBe(422);
      expect(response.body).toEqual(validation('Text must not contain the NUL character.'));
      await expectUnchanged(before);
    },
  );
});

describe('PATCH /v1/settings: the write', () => {
  it('writes nothing unless every field passes', async () => {
    await seedSettings();
    const before = await agent.get('/v1/settings');

    const response = await agent.patch('/v1/settings').send({ businessName: 'New', noShowThreshold: 0 });

    expect(response.status).toBe(422);
    expect((await agent.get('/v1/settings')).body).toEqual(before.body);
  });

  it('writes only the fields sent, with updatedAt from now and the caller as updatedByStaffId', async () => {
    const response = await agent.patch('/v1/settings').send({ noReplyWindowHours: 48 });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(settingsFields);
    expect(response.body).toEqual({ ...defaultSettings, noReplyWindowHours: 48, updatedAt: '2026-11-10T10:07:00.000Z' });
    const rows = await prisma.businessSettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, updatedByStaffId: alex.id });
  });

  it('writes all eight fields in one request', async () => {
    const response = await agent.patch('/v1/settings').send(allChanged);

    expect(response.status).toBe(200);
    expect((await agent.get('/v1/settings')).body).toEqual({ ...allChanged, updatedAt: '2026-11-10T10:07:00.000Z' });
  });

  it('accepts the current value and moves updatedAt to now', async () => {
    await seedSettings();

    const response = await agent.patch('/v1/settings').send({ businessName: 'Old Name' });

    expect(response.status).toBe(200);
    expect(response.body.updatedAt).toBe('2026-11-10T10:07:00.000Z');
  });

  it('keeps the last write per field', async () => {
    const sam = await createTestStaff({ name: 'Sam', email: 'sam@demo.test' });
    const samAgent = await signIn(app, sam.email);

    await agent.patch('/v1/settings').send({ businessName: 'A' });
    await samAgent.patch('/v1/settings').send({ noShowThreshold: 3 });
    expect(await prisma.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      businessName: 'A',
      noShowThreshold: 3,
      updatedByStaffId: sam.id,
    });

    await agent.patch('/v1/settings').send({ businessName: 'B' });
    expect(await prisma.businessSettings.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({
      businessName: 'B',
      noShowThreshold: 3,
      updatedByStaffId: alex.id,
    });
  });

  it('does not touch appointments when the time zone changes', async () => {
    const client = await createTestClient();
    const appointment = await createTestAppointment({ clientId: client.id, staffMemberId: alex.id });

    expect((await agent.patch('/v1/settings').send({ timeZone: 'America/New_York' })).status).toBe(200);

    expect(await prisma.appointment.findUniqueOrThrow({ where: { id: appointment.id } })).toMatchObject({
      startsAt: appointment.startsAt,
    });
  });
});

describe('the next request uses the new values', () => {
  it('creates an appointment with the new default duration', async () => {
    const client = await createTestClient();
    await agent.patch('/v1/settings').send({ defaultDurationMinutes: 45 });

    const response = await agent.post('/v1/appointments').send({
      clientId: client.id,
      staffMemberId: alex.id,
      service: 'Haircut',
      startsAt: '2026-11-11T09:30:00Z',
    });

    expect(response.status).toBe(201);
    expect(response.body.appointment.durationMinutes).toBe(45);
  });

  it('shows the new business name and time zone on the public page', async () => {
    const client = await createTestClient();
    const { token } = await createTestAppointment({ clientId: client.id, staffMemberId: alex.id });
    await agent.patch('/v1/settings').send({ businessName: 'Studio Two', timeZone: 'America/New_York' });

    const response = await request(app).get(`/v1/public/appointments/${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ businessName: 'Studio Two', timeZone: 'America/New_York' });
  });

  it('renders a regenerated link message from the new template', async () => {
    const client = await createTestClient({ name: 'Maria Lopez' });
    const appointment = await createTestAppointment({ clientId: client.id, staffMemberId: alex.id });
    await agent.patch('/v1/settings').send({ messageTemplate: 'Hi {client}: {link}' });

    const response = await agent.post(`/v1/appointments/${appointment.id}/link`);

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(`Hi Maria Lopez: ${response.body.confirmationLink}`);
  });
});
