import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import { prisma } from './db.js';
import { ApiError } from './errors.js';
import type { StaffMember } from './generated/prisma/client.js';

declare module 'express-serve-static-core' {
  interface Locals {
    staffMember: StaffMember;
  }
}

export const sessionDurationMs = 12 * 60 * 60 * 1000;

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest();
}

export function createSessionToken(staffId: string, secret: string) {
  const payload = Buffer.from(JSON.stringify({ staffId, expiresAt: Date.now() + sessionDurationMs })).toString(
    'base64url',
  );
  return `${payload}.${sign(payload, secret).toString('base64url')}`;
}

function parsePayload(payload: string): { staffId: string; expiresAt: number } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const { staffId, expiresAt } = (parsed ?? {}) as Record<string, unknown>;
    return typeof staffId === 'string' && typeof expiresAt === 'number' ? { staffId, expiresAt } : null;
  } catch {
    return null;
  }
}

/** Returns the staff id, or null for any malformed, tampered or expired token. */
export function verifySessionToken(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  const expected = sign(payload, secret);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  const parsed = parsePayload(payload);
  if (!parsed || Date.now() >= parsed.expiresAt) {
    return null;
  }
  return parsed.staffId;
}

/** Without `Secure` over http, because supertest and `http://localhost` stacks cannot send Secure cookies (decision 26). */
export function sessionCookie(value: string, maxAgeSeconds: number, publicBaseUrl: string) {
  const secure = publicBaseUrl.startsWith('https:') ? '; Secure' : '';
  return `session=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure}`;
}

function readSessionCookie(cookieHeader: string | undefined) {
  const cookie = cookieHeader
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('session='));
  return cookie?.slice('session='.length);
}

/** Reloads the staff member on every request, so deactivation ends sessions (decision 17). */
export function requireStaff(secret: string): RequestHandler {
  return async (req, res, next) => {
    const token = readSessionCookie(req.headers.cookie);
    const staffId = token === undefined ? null : verifySessionToken(token, secret);
    const staffMember = staffId === null ? null : await prisma.staffMember.findUnique({ where: { id: staffId } });
    if (!staffMember?.isActive) {
      throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
    }
    res.locals.staffMember = staffMember;
    next();
  };
}
