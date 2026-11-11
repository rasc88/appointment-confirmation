import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemoData } from '../prisma/seed.js';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { createSessionToken } from './session.js';
import { createTestStaff, resetDatabase, signIn, testPassword } from './test-helpers.js';

const sessionSecret = process.env.SESSION_SECRET!;
const invalidCredentials = { error: { code: 'invalid_credentials', message: 'Email or password is incorrect.' } };
const unauthenticated = { error: { code: 'unauthenticated', message: 'Sign in to continue.' } };
const rateLimited = { error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } };

const base64urlAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The signature's last character carries 2 unused bits, so this still decodes to the same bytes. */
function flipUnusedBit(token: string) {
  const last = base64urlAlphabet.indexOf(token.at(-1)!);
  return `${token.slice(0, -1)}${base64urlAlphabet[last ^ 1]}`;
}

function login(app: ReturnType<typeof createApp>, body: object, ip = '203.0.113.1') {
  return request(app).post('/v1/auth/login').set('X-Forwarded-For', ip).send(body);
}

beforeEach(async () => {
  await resetDatabase();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /v1/auth/login', () => {
  it('signs in a seeded demo account, and me returns it', { timeout: 30_000 }, async () => {
    await seedDemoData(prisma);
    const agent = await signIn(createApp(), 'alex@demo.test', 'demo1234');

    const response = await agent.get('/v1/auth/me');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ name: 'Alex', email: 'alex@demo.test', isActive: true });
  });

  it('returns exactly the StaffMember fields and sets the session cookie', async () => {
    const staffMember = await createTestStaff({ name: 'Kim', email: 'kim@test.test' });

    const response = await login(createApp(), { email: 'kim@test.test', password: testPassword });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: staffMember.id,
      name: 'Kim',
      email: 'kim@test.test',
      isActive: true,
      createdAt: staffMember.createdAt.toISOString(),
    });
    expect(response.body.createdAt).toMatch(/Z$/);
    expect(response.headers['set-cookie']).toEqual([
      expect.stringMatching(/^session=[\w-]+\.[\w-]+; Path=\/; Max-Age=43200; HttpOnly; SameSite=Lax$/),
    ]);
  });

  it('adds Secure when PUBLIC_BASE_URL is https', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://d111111abcdef8.cloudfront.net');
    await createTestStaff({ email: 'kim@test.test' });

    const response = await login(createApp(), { email: 'kim@test.test', password: testPassword });

    expect(response.headers['set-cookie'][0]).toMatch(/; Secure$/);
    expect(response.headers['set-cookie'][0]).not.toContain('Domain');
  });

  it('lowercases the email before the lookup', async () => {
    await createTestStaff({ email: 'alex@demo.test' });

    expect((await login(createApp(), { email: 'ALEX@Demo.TEST', password: testPassword })).status).toBe(200);
  });

  it('gives the same 401 for a wrong email, a wrong password and an inactive account', async () => {
    await createTestStaff({ email: 'kim@test.test' });
    await createTestStaff({ email: 'off@test.test', isActive: false });
    const app = createApp();

    for (const body of [
      { email: 'nobody@test.test', password: testPassword },
      { email: 'kim@test.test', password: 'wrong-password' },
      { email: 'off@test.test', password: testPassword },
    ]) {
      const response = await login(app, body);
      expect(response.status).toBe(401);
      expect(response.body).toEqual(invalidCredentials);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
  });

  it('runs one bcrypt compare against a cost-12 hash for an unknown email', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');

    await login(createApp(), { email: 'nobody@test.test', password: testPassword });

    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare.mock.calls[0][1]).toMatch(/^\$2b\$12\$/);
  });

  it.each([
    [{ password: 'x' }, 'email', 'Enter your email.'],
    [{ email: 1, password: 'x' }, 'email', 'Enter your email.'],
    [{ email: 'a@b' }, 'password', 'Enter your password.'],
    [{ email: 'a@b', password: null }, 'password', 'Enter your password.'],
    [{ email: 'a@b', password: 'x', remember: true }, 'remember', 'Unknown field.'],
  ])('rejects %j with 422 on %s', async (body, field, message) => {
    const response = await login(createApp(), body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: 'validation_error', message, field } });
  });

  it('accepts empty strings as a wrong sign-in, since the contract has no length rules', async () => {
    expect((await login(createApp(), { email: '', password: '' })).status).toBe(401);
  });

  it('returns 422 for a NUL in the email, logs nothing, and does not count it as a failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp();
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await login(app, { email: 'kim\u0000@test.test', password: 'x' });

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        error: { code: 'validation_error', message: 'Text must not contain the NUL character.' },
      });
    }

    expect(consoleError).not.toHaveBeenCalled();
  });

  it('writes no log line on sign-in', async () => {
    await createTestStaff({ email: 'kim@test.test' });
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const app = createApp();

    await login(app, { email: 'kim@test.test', password: testPassword });
    await login(app, { email: 'kim@test.test', password: 'wrong-password' });

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('sign-in rate limit', { timeout: 60_000 }, () => {
  const wrong = { email: 'kim@test.test', password: 'wrong-password' };
  const right = { email: 'kim@test.test', password: testPassword };

  async function failTimes(app: ReturnType<typeof createApp>, count: number, body = wrong, ip?: string) {
    for (let attempt = 0; attempt < count; attempt += 1) {
      expect((await login(app, body, ip)).status).toBe(401);
    }
  }

  beforeEach(async () => {
    await createTestStaff({ email: 'kim@test.test' });
  });

  it('returns 429 with Retry-After on the 11th attempt, even with the right password', async () => {
    const app = createApp();
    await failTimes(app, 10);
    const compare = vi.spyOn(bcrypt, 'compare');

    const eleventh = await login(app, wrong);
    const withRightPassword = await login(app, right);

    for (const response of [eleventh, withRightPassword]) {
      expect(response.status).toBe(429);
      expect(response.body).toEqual(rateLimited);
      expect(Number(response.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(response.headers['retry-after'])).toBeLessThanOrEqual(900);
    }
    expect(compare).not.toHaveBeenCalled();
  });

  it('keys by IP and email: another IP or another email is not limited', async () => {
    await createTestStaff({ email: 'sam@test.test' });
    const app = createApp();
    await failTimes(app, 10);

    expect((await login(app, right, '198.51.100.7')).status).toBe(200);
    expect((await login(app, { email: 'sam@test.test', password: testPassword })).status).toBe(200);
  });

  it('shares one counter between case variants of the email', async () => {
    const app = createApp();
    await failTimes(app, 5, wrong);
    await failTimes(app, 5, { ...wrong, email: 'KIM@Test.Test' });

    expect((await login(app, right)).status).toBe(429);
  });

  it('does not count 422s', async () => {
    const app = createApp();
    await failTimes(app, 9);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await login(app, { email: 'kim@test.test' })).status).toBe(422);
    }

    expect((await login(app, right)).status).toBe(200);
  });

  it('lets sign-in work again once the 15-minute window from the first failure ends', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T09:00:00Z'), toFake: ['Date'] });
    const app = createApp();
    await failTimes(app, 10);

    vi.setSystemTime(new Date('2026-11-10T09:14:59.500Z'));
    const lastMoment = await login(app, right);
    expect(lastMoment.status).toBe(429);
    expect(lastMoment.headers['retry-after']).toBe('1');
    vi.setSystemTime(new Date('2026-11-10T09:15:00Z'));
    expect((await login(app, right)).status).toBe(200);
  });

  it('resets the count after a successful sign-in', async () => {
    const app = createApp();
    await failTimes(app, 9);
    expect((await login(app, right)).status).toBe(200);
    await failTimes(app, 9);

    expect((await login(app, right)).status).toBe(200);
  });

  it('gives each app its own counters', async () => {
    await failTimes(createApp(), 10);

    expect((await login(createApp(), right)).status).toBe(200);
  });
});

describe('POST /v1/auth/logout', () => {
  it('clears the cookie and ends the session for the agent', async () => {
    const staffMember = await createTestStaff();
    const agent = await signIn(createApp(), staffMember.email);

    const response = await agent.post('/v1/auth/logout');

    expect(response.status).toBe(204);
    expect(response.headers['set-cookie']).toEqual(['session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax']);
    expect((await agent.get('/v1/auth/me')).status).toBe(401);
  });

  it('returns 204 with no cookie and with a tampered one', async () => {
    const app = createApp();

    expect((await request(app).post('/v1/auth/logout')).status).toBe(204);
    expect((await request(app).post('/v1/auth/logout').set('Cookie', 'session=abc.def')).status).toBe(204);
  });

  it('returns 204 with an expired session and with an inactive account', async () => {
    const staffMember = await createTestStaff({ isActive: false });
    vi.useFakeTimers({ now: new Date('2020-01-01T00:00:00Z'), toFake: ['Date'] });
    const expiredToken = createSessionToken(staffMember.id, sessionSecret);
    vi.useRealTimers();
    const inactiveToken = createSessionToken(staffMember.id, sessionSecret);
    const app = createApp();

    for (const token of [expiredToken, inactiveToken]) {
      expect((await request(app).post('/v1/auth/logout').set('Cookie', `session=${token}`)).status).toBe(204);
    }
  });

  it('adds Secure under https', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://d111111abcdef8.cloudfront.net');

    const response = await request(createApp()).post('/v1/auth/logout');

    expect(response.headers['set-cookie']).toEqual(['session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure']);
  });
});

describe('GET /v1/auth/me', () => {
  it('reflects a rename made since sign-in', async () => {
    const staffMember = await createTestStaff({ name: 'Kim' });
    const agent = await signIn(createApp(), staffMember.email);
    await prisma.staffMember.update({ where: { id: staffMember.id }, data: { name: 'Kimberly' } });

    const response = await agent.get('/v1/auth/me');

    expect(response.body).toEqual({
      id: staffMember.id,
      name: 'Kimberly',
      email: staffMember.email,
      isActive: true,
      createdAt: staffMember.createdAt.toISOString(),
    });
  });

  it('reads the session cookie among other cookies', async () => {
    const staffMember = await createTestStaff();
    const token = createSessionToken(staffMember.id, sessionSecret);

    const response = await request(createApp())
      .get('/v1/auth/me')
      .set('Cookie', `theme=dark; session=${token}; other=1`);

    expect(response.status).toBe(200);
  });

  it.each([
    ['no cookie', () => undefined],
    ['a malformed token', () => 'session=not-a-token'],
    ['a tampered token', (id: string) => `session=${createSessionToken(id, sessionSecret)}x`],
    ['another secret', (id: string) => `session=${createSessionToken(id, 'z'.repeat(32))}`],
    ['an unknown id', () => `session=${createSessionToken('00000000-0000-4000-8000-000000000000', sessionSecret)}`],
    ['an empty session cookie', () => 'session='],
    ['a signature with = appended', (id: string) => `session=${createSessionToken(id, sessionSecret)}=`],
    ['a signature changed in its unused bits', (id: string) => `session=${flipUnusedBit(createSessionToken(id, sessionSecret))}`],
  ])('returns 401 for %s', async (_label, cookieFor) => {
    const staffMember = await createTestStaff();
    const cookie = cookieFor(staffMember.id);
    const pending = request(createApp()).get('/v1/auth/me');

    const response = await (cookie ? pending.set('Cookie', cookie) : pending);

    expect(response.status).toBe(401);
    expect(response.body).toEqual(unauthenticated);
  });

  it('returns 401 once the 12 hours from sign-in have passed', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T09:00:00Z'), toFake: ['Date'] });
    const staffMember = await createTestStaff();
    const app = createApp();
    const signedIn = await login(app, { email: staffMember.email, password: testPassword });
    const cookie = signedIn.headers['set-cookie'][0].split(';')[0];

    vi.setSystemTime(new Date('2026-11-10T20:59:59Z'));
    expect((await request(app).get('/v1/auth/me').set('Cookie', cookie)).status).toBe(200);
    vi.setSystemTime(new Date('2026-11-10T21:00:00Z'));
    expect((await request(app).get('/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
  });
});
