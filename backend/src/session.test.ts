import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionToken, sessionCookie, sessionDurationMs, verifySessionToken } from './session.js';

const secret = 'a'.repeat(32);
const staffId = '0b8f6a52-3c1e-4d7a-9f20-6e5b1c2d3a41';

function encode(value: unknown) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}

function sign(payload: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

describe('session tokens', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies a valid token and returns its staff id', () => {
    expect(verifySessionToken(createSessionToken(staffId, secret), secret)).toBe(staffId);
  });

  it('is base64url JSON with staffId and expiresAt 12 hours ahead, then a signature', () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T09:00:00Z'), toFake: ['Date'] });
    const [payload, signature] = createSessionToken(staffId, secret).split('.');

    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      staffId,
      expiresAt: Date.parse('2026-11-10T21:00:00Z'),
    });
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('accepts a payload signed the same way, so the format is the documented one', () => {
    const payload = encode({ staffId, expiresAt: Date.now() + sessionDurationMs });

    expect(verifySessionToken(`${payload}.${sign(payload)}`, secret)).toBe(staffId);
  });

  it('rejects a changed payload', () => {
    const [, signature] = createSessionToken(staffId, secret).split('.');
    const payload = encode({ staffId: 'someone-else', expiresAt: Date.now() + sessionDurationMs });

    expect(verifySessionToken(`${payload}.${signature}`, secret)).toBeNull();
  });

  it('rejects a changed signature', () => {
    const [payload, signature] = createSessionToken(staffId, secret).split('.');
    const changed = `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`;

    expect(verifySessionToken(`${payload}.${changed}`, secret)).toBeNull();
    expect(verifySessionToken(`${payload}.${signature}x`, secret)).toBeNull();
    expect(verifySessionToken(`${payload}.`, secret)).toBeNull();
  });

  it('rejects a token signed with another secret', () => {
    expect(verifySessionToken(createSessionToken(staffId, 'b'.repeat(32)), secret)).toBeNull();
  });

  it.each(['', 'no-dot', 'a.b.c', `${createSessionToken(staffId, secret)}.extra`])('rejects the token %j', (token) => {
    expect(verifySessionToken(token, secret)).toBeNull();
  });

  it.each([
    'not json',
    'null',
    '[]',
    '"text"',
    JSON.stringify({ staffId }),
    JSON.stringify({ staffId: 1, expiresAt: Date.now() + sessionDurationMs }),
    JSON.stringify({ staffId, expiresAt: String(Date.now() + sessionDurationMs) }),
  ])('rejects the correctly signed payload %j without throwing', (json) => {
    const payload = encode(json);

    expect(verifySessionToken(`${payload}.${sign(payload)}`, secret)).toBeNull();
  });

  it('rejects the token once 12 hours have passed', () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T09:00:00Z'), toFake: ['Date'] });
    const token = createSessionToken(staffId, secret);

    vi.setSystemTime(Date.parse('2026-11-10T21:00:00Z') - 1);
    expect(verifySessionToken(token, secret)).toBe(staffId);
    vi.setSystemTime(Date.parse('2026-11-10T21:00:00Z'));
    expect(verifySessionToken(token, secret)).toBeNull();
  });
});

describe('sessionCookie', () => {
  it('adds Secure only for an https PUBLIC_BASE_URL', () => {
    expect(sessionCookie('t', 43200, 'http://localhost:5173')).toBe(
      'session=t; Path=/; Max-Age=43200; HttpOnly; SameSite=Lax',
    );
    expect(sessionCookie('', 0, 'https://d111111abcdef8.cloudfront.net')).toBe(
      'session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure',
    );
  });
});
