import type { Express } from 'express';
import request from 'supertest';
import { prisma } from './db.js';
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

/** Returns an agent that carries the session cookie. */
export async function signIn(app: Express, email: string, password = testPassword) {
  const agent = request.agent(app);
  const response = await agent.post('/v1/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`Sign-in failed with ${response.status}`);
  }
  return agent;
}
