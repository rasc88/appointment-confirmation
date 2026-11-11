import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /v1/health', () => {
  it('returns 200 with the environment and version, without a session', async () => {
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('APP_VERSION', 'v1.2.3');

    const response = await request(createApp()).get('/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', environment: 'local', version: 'v1.2.3' });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('reports unknown for an unset environment and version', async () => {
    vi.stubEnv('APP_ENV', undefined);
    vi.stubEnv('APP_VERSION', undefined);

    const response = await request(createApp()).get('/v1/health');

    expect(response.body).toEqual({ status: 'ok', environment: 'unknown', version: 'unknown' });
  });

  it('returns 503 when the database query fails, logging only the error name', async () => {
    vi.stubEnv('APP_ENV', 'local');
    vi.stubEnv('APP_VERSION', 'v1.2.3');
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('connect ECONNREFUSED secret-host:5432'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await request(createApp()).get('/v1/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable', environment: 'local', version: 'v1.2.3' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith('Health check failed: Error');
  });

  it('answers with JSON, not index.html, when the frontend is served', async () => {
    const frontendDir = await mkdtemp(path.join(tmpdir(), 'health-frontend-'));
    await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>Fixture</title>');

    const response = await request(createApp({ frontendDir })).get('/v1/health');
    await rm(frontendDir, { recursive: true });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body.status).toBe('ok');
  });
});
