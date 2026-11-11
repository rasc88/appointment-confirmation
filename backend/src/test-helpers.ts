import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import { generateConfirmationToken } from './confirmation-token.js';
import { prisma } from './db.js';
import type { Actor, AppointmentStatus } from './generated/prisma/client.js';
import { hashPassword } from './passwords.js';

export const testPassword = 'password123';

/** Cached per password, so each test file hashes at cost 12 once, not once per test. */
const passwordHashes = new Map<string, Promise<string>>();
let staffCount = 0;

function cachedPasswordHash(password: string) {
  if (!passwordHashes.has(password)) {
    passwordHashes.set(password, hashPassword(password));
  }
  return passwordHashes.get(password)!;
}

/** Deletes every row in foreign-key order, as `seedDemoData` does. */
export async function resetDatabase() {
  await prisma.$transaction([
    prisma.appointment.deleteMany(),
    prisma.businessSettings.deleteMany(),
    prisma.client.deleteMany(),
    prisma.staffMember.deleteMany(),
  ]);
}

export async function createTestStaff(
  options: { name?: string; email?: string; password?: string; isActive?: boolean } = {},
) {
  staffCount += 1;
  const { name = `Staff ${staffCount}`, email = `staff-${staffCount}@test.test`, password = testPassword } = options;
  return prisma.staffMember.create({
    data: { name, email, passwordHash: await cachedPasswordHash(password), isActive: options.isActive },
  });
}

export function createTestClient(options: { name?: string; phone?: string | null } = {}) {
  const { name = 'Maria Lopez', phone = null } = options;
  return prisma.client.create({ data: { name, phone } });
}

/** Any status and any `startsAt`, including the past; returns the row with its token. */
export async function createTestAppointment(options: {
  clientId: string;
  staffMemberId: string;
  service?: string;
  startsAt?: Date;
  durationMinutes?: number;
  status?: AppointmentStatus;
  confirmedBy?: Actor | null;
  cancelledBy?: Actor | null;
  statusChangedAt?: Date;
}) {
  const { token, tokenHash } = generateConfirmationToken();
  const {
    service = 'Haircut',
    startsAt = new Date('2026-11-11T09:30:00Z'),
    durationMinutes = 30,
    status = 'pending',
    ...rest
  } = options;
  const appointment = await prisma.appointment.create({
    data: { ...rest, service, startsAt, durationMinutes, status, tokenHash },
  });
  return { ...appointment, token };
}

/** Returns an agent that carries the session cookie. */
export async function signIn(app: Express, email: string, password = testPassword) {
  const agent = request.agent(app);
  const response = await agent.post('/v1/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`Sign-in failed with ${response.status}`);
  }
  return agent;
}

/** Parses every logger line written through the spied `console` methods. */
export function loggedLines(spies: { mock: { calls: unknown[][] } }[]) {
  return spies.flatMap((spy) => spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>));
}

/** Checks the kind of line, not the count: a request line is written when its response closes. */
export function expectOnlyRequestLines(spies: { mock: { calls: unknown[][] } }[]) {
  for (const line of loggedLines(spies)) {
    expect(line).toMatchObject({ level: 'info', msg: 'request' });
  }
}
