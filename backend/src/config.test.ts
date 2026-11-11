import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

const valid = { SESSION_SECRET: 's'.repeat(32), PUBLIC_BASE_URL: 'http://localhost:5173' };

describe('readConfig', () => {
  it('returns both values when they are valid', () => {
    expect(readConfig(valid)).toEqual({ sessionSecret: 's'.repeat(32), publicBaseUrl: 'http://localhost:5173' });
    expect(readConfig({ ...valid, PUBLIC_BASE_URL: 'https://d111111abcdef8.cloudfront.net' }).publicBaseUrl).toBe(
      'https://d111111abcdef8.cloudfront.net',
    );
  });

  it.each([undefined, '', 's'.repeat(31)])('rejects SESSION_SECRET %j', (secret) => {
    expect(() => readConfig({ ...valid, SESSION_SECRET: secret })).toThrow(
      'SESSION_SECRET must be set to at least 32 characters',
    );
  });

  it.each([undefined, '', 'localhost:5173', 'ftp://example.test', 'not a url'])('rejects PUBLIC_BASE_URL %j', (url) => {
    expect(() => readConfig({ ...valid, PUBLIC_BASE_URL: url })).toThrow(
      'PUBLIC_BASE_URL must be set to an http: or https: URL',
    );
  });
});

describe('server start-up', () => {
  it.each([
    ['SESSION_SECRET', 'short-secret-value', 'SESSION_SECRET must be set'],
    ['PUBLIC_BASE_URL', 'ftp://hidden-value.test', 'PUBLIC_BASE_URL must be set'],
  ])('exits with code 1 naming %s but not its value', (name, value, message) => {
    const result = spawnSync('npx', ['tsx', 'src/server.ts'], {
      cwd: `${import.meta.dirname}/..`,
      env: { ...process.env, [name]: value, PORT: '0' },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stderr).not.toContain(value);
  });
});
