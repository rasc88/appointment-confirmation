import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

const indexHtml = '<!doctype html><title>Fixture</title><div id="root"></div>';
const assetJs = 'console.log("fixture");';
const immutable = 'public, max-age=31536000, immutable';
const contentSecurityPolicy =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";

let frontendDir: string;

beforeAll(async () => {
  frontendDir = await mkdtemp(path.join(tmpdir(), 'frontend-fixture-'));
  await mkdir(path.join(frontendDir, 'assets'));
  await writeFile(path.join(frontendDir, 'index.html'), indexHtml);
  await writeFile(path.join(frontendDir, 'assets', 'index-abc123.js'), assetJs);
  await writeFile(path.join(frontendDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(async () => {
  await rm(frontendDir, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Express prints unhandled errors only outside `NODE_ENV=test`, so the logging checks build the app as in production. */
function createProductionApp() {
  vi.stubEnv('NODE_ENV', 'production');
  return createApp({ frontendDir });
}

function expectSecurityHeaders(response: request.Response) {
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  expect(response.headers['content-security-policy']).toBe(contentSecurityPolicy);
}

describe('serving the built frontend', () => {
  it.each([
    '/',
    '/sign-in',
    '/settings',
    '/staff',
    '/appointments/new',
    '/appointments/9f6c2a1e-0000-4000-8000-000000000000/edit',
    '/clients/9f6c2a1e-0000-4000-8000-000000000000',
    '/c/abcDEF123_-abcDEF123_-',
    '/nope',
    '/index.html',
  ])('answers GET %s with index.html, never stored', async (url) => {
    const response = await request(createApp({ frontendDir })).get(url);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.text).toBe(indexHtml);
  });

  it('answers HEAD on a client-side route like GET, without a body', async () => {
    const response = await request(createApp({ frontendDir })).head('/c/abcDEF123_-abcDEF123_-');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
  });

  it('serves a hashed asset as JavaScript, cached as immutable for a year', async () => {
    const response = await request(createApp({ frontendDir })).get('/assets/index-abc123.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/javascript/);
    expect(response.headers['cache-control']).toBe(immutable);
    expect(response.text).toBe(assetJs);
  });

  it('serves another static file with its own type, never stored', async () => {
    const response = await request(createApp({ frontendDir })).get('/favicon.svg');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it.each(['/assets/index-old.js', '/assets/nested/missing.css', '/favicon.ico', '/robots.txt', '/c/abc.def'])(
    'answers %s with 404, not index.html, and logs nothing',
    async (url) => {
      const consoleError = vi.spyOn(console, 'error');
      const consoleLog = vi.spyOn(console, 'log');

      const response = await request(createProductionApp()).get(url);

      expect(response.status).toBe(404);
      expect(response.text).not.toContain('Fixture');
      expect(consoleError).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    },
  );

  it.each(['/assets/index-old.js', '/favicon.ico'])('answers %s with a short plain-text body', async (url) => {
    const response = await request(createApp({ frontendDir })).get(url);

    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('Not Found');
  });

  it.each([
    ['/assets/..%2f..%2fpackage.json', [403, 404]],
    ['/assets/%2e%2e/%2e%2e/package.json', [403, 404]],
    ['/..%2f..%2fpackage.json', [403, 404]],
    ['/assets/%E0%A4%A', [400]],
    ['/sign-in/%E0%A4%A', [400]],
  ] as const)('answers %s with %j and logs nothing', async (url, statuses) => {
    const consoleError = vi.spyOn(console, 'error');
    const consoleLog = vi.spyOn(console, 'log');

    const response = await request(createProductionApp()).get(url);

    expect(statuses).toContain(response.status);
    expect(response.text).not.toContain('Fixture');
    expect(response.text).not.toContain('"private"');
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it.each(['/v1/nope', '/v1/c/abc'])('keeps the JSON 404 for %s', async (url) => {
    const response = await request(createApp({ frontendDir })).get(url);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
  });

  it.each(['post', 'put', 'patch', 'delete'] as const)('does not answer %s /settings with index.html', async (method) => {
    const response = await request(createApp({ frontendDir }))[method]('/settings');

    expect(response.status).toBe(404);
    expect(response.text).not.toContain('Fixture');
  });

  it('sets the security headers on index.html, on an asset and on an API response', async () => {
    const app = createApp({ frontendDir });

    expectSecurityHeaders(await request(app).get('/c/abcDEF123_-abcDEF123_-'));
    expectSecurityHeaders(await request(app).get('/assets/index-abc123.js'));
    expectSecurityHeaders(await request(app).get('/v1/nope'));
  });

  it('serves no frontend without frontendDir', async () => {
    const app = createApp();

    for (const url of ['/', '/sign-in', '/assets/index-abc123.js']) {
      const response = await request(app).get(url);
      expect(response.status).toBe(404);
      expect(response.text).not.toContain('Fixture');
    }
    expectSecurityHeaders(await request(app).get('/v1/nope'));
  });
});
