import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { errorHandler } from './errors.js';
import { createTestStaff, loggedLines, resetDatabase, signIn } from './test-helpers.js';

const notFound = { error: { code: 'not_found', message: 'Not found.' } };
const crossSite = { error: { code: 'cross_site_request', message: 'Cross-site requests are not allowed.' } };

function validation(message: string) {
  return { error: { code: 'validation_error', message } };
}

beforeEach(async () => {
  await resetDatabase();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('/v1 routing', () => {
  it.each([
    ['get', '/v1/unknown'],
    ['post', '/v1/unknown'],
    ['delete', '/v1/staff'],
    ['put', '/v1/auth/me'],
    ['get', '/v1/staff/some-id/extra'],
  ] as const)('returns the JSON 404 for %s %s', async (method, path) => {
    const response = await request(createApp())[method](path);

    expect(response.status).toBe(404);
    expect(response.body).toEqual(notFound);
  });
});

describe('Origin check', () => {
  it.each(['post', 'put', 'patch', 'delete'] as const)('rejects %s with a foreign Origin before auth', async (method) => {
    const response = await request(createApp())[method]('/v1/staff').set('Origin', 'https://evil.test');

    expect(response.status).toBe(403);
    expect(response.body).toEqual(crossSite);
  });

  it.each(['null', 'http://localhost:5173.evil.test', 'http://localhost:3000', 'https://localhost:5173'])(
    'rejects Origin %j',
    async (origin) => {
      const response = await request(createApp()).post('/v1/auth/logout').set('Origin', origin);

      expect(response.status).toBe(403);
    },
  );

  it('checks the Origin before parsing the body', async () => {
    const response = await request(createApp())
      .post('/v1/auth/login')
      .set('Origin', 'https://evil.test')
      .set('Content-Type', 'application/json')
      .send('{not json');

    expect(response.status).toBe(403);
  });

  it('passes the app origin and a request without Origin', async () => {
    const app = createApp();

    expect((await request(app).post('/v1/auth/logout').set('Origin', 'http://localhost:5173')).status).toBe(204);
    expect((await request(app).post('/v1/auth/logout')).status).toBe(204);
  });

  it('never checks GET', async () => {
    const response = await request(createApp()).get('/v1/auth/me').set('Origin', 'https://evil.test');

    expect(response.status).toBe(401);
  });

  it('does not check /v1/public paths', async () => {
    const response = await request(createApp()).post('/v1/public/appointments/x/confirm').set('Origin', 'https://evil.test');

    expect(response.status).toBe(404);
  });

  it('compares with the origin of PUBLIC_BASE_URL, ignoring its path', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://d111111abcdef8.cloudfront.net/app/');
    try {
      const app = createApp();

      const response = await request(app).post('/v1/auth/logout').set('Origin', 'https://d111111abcdef8.cloudfront.net');

      expect(response.status).toBe(204);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('request bodies', () => {
  it('returns 422 without field for malformed JSON', async () => {
    const response = await request(createApp())
      .post('/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email":');

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Request body must be valid JSON.'));
  });

  it('returns 422 without field for a body over 100 kB', async () => {
    const response = await request(createApp())
      .post('/v1/auth/login')
      .send({ email: 'x'.repeat(101 * 1024), password: 'x' });

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Request body is too large.'));
  });

  it.each(['[]', '"text"', '42', 'null', 'true'])('returns 422 without field for the JSON body %s', async (body) => {
    const response = await request(createApp())
      .post('/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(response.status).toBe(422);
    expect(response.body).toEqual(validation('Request body must be a JSON object.'));
  });

  it('treats a missing body as {}', async () => {
    const response = await request(createApp()).post('/v1/auth/login');

    expect(response.status).toBe(422);
    expect(response.body).toEqual({ error: { code: 'validation_error', message: 'Enter your email.', field: 'email' } });
  });

  it('treats a non-JSON content type as {}', async () => {
    const response = await request(createApp())
      .post('/v1/auth/login')
      .set('Content-Type', 'text/plain')
      .send('{"email":"a","password":"b"}');

    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ error: { field: 'email' } });
  });

  it('reports the first unknown key last, after the contract fields', async () => {
    const app = createApp();

    const unknownOnly = await request(app).post('/v1/auth/login').send({ email: 'a', password: 'b', extra: 1, more: 2 });
    const withBadField = await request(app).post('/v1/auth/login').send({ extra: 1, email: 'a', password: 2 });

    expect(unknownOnly.body).toEqual({ error: { code: 'validation_error', message: 'Unknown field.', field: 'extra' } });
    expect(withBadField.body).toMatchObject({ error: { field: 'password' } });
  });
});

describe('errorHandler', () => {
  it('returns a generic 500 and logs no message, stack, URL or body', async () => {
    const app = express();
    app.post('/boom/:id', () => {
      throw new Error('secret-detail');
    });
    app.use(errorHandler);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(app).post('/boom/secret-id?q=secret-query').send({ secret: 'secret-body' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: { code: 'internal_error', message: 'Something went wrong.' } });
      expect(response.text).not.toContain('secret');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret');
      expect(loggedLines([consoleError])).toEqual([
        { time: expect.any(String), level: 'error', msg: 'Unhandled error: POST /boom/:id Error' },
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs the Prisma code of a database error, and unmatched without a route', async () => {
    const app = express();
    app.use(async () => {
      await prisma.staffMember.create({ data: { name: 'A', email: 'dup@test.test', passwordHash: 'x' } });
      await prisma.staffMember.create({ data: { name: 'B', email: 'dup@test.test', passwordHash: 'x' } });
    });
    app.use(errorHandler);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await request(app).get('/anything');

      expect(response.status).toBe(500);
      expect(response.text).not.toContain('dup@test.test');
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('dup@test.test');
      expect(loggedLines([consoleError])).toEqual([
        { time: expect.any(String), level: 'error', msg: 'Unhandled error: GET unmatched PrismaClientKnownRequestError P2002' },
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('test helpers', () => {
  it('signs in a created staff member and carries the cookie', async () => {
    const staffMember = await createTestStaff({ name: 'Kim' });
    const agent = await signIn(createApp(), staffMember.email);

    const response = await agent.get('/v1/auth/me');

    expect(response.body).toMatchObject({ id: staffMember.id, name: 'Kim' });
  });
});
