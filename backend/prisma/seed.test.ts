import bcrypt from 'bcryptjs';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db.js';
import type { Appointment } from '../src/generated/prisma/client.js';
import { seedDemoData } from './seed.js';

const now = new Date('2026-03-10T10:07:00Z');
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;

function hoursUntilStart(appointment: Appointment) {
  return (appointment.startsAt.getTime() - now.getTime()) / hourMs;
}

function countRows() {
  return Promise.all([
    prisma.staffMember.count(),
    prisma.client.count(),
    prisma.appointment.count(),
    prisma.businessSettings.count(),
  ]);
}

describe('seedDemoData', { timeout: 30_000 }, () => {
  let appointments: Appointment[];

  beforeAll(async () => {
    await seedDemoData(prisma, now);
    appointments = await prisma.appointment.findMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('sets the demo business settings and leaves the rest at their defaults', async () => {
    const settings = await prisma.businessSettings.findUniqueOrThrow({ where: { id: 1 } });

    expect(settings).toMatchObject({
      businessName: 'Demo Studio',
      timeZone: 'Europe/Madrid',
      noReplyWindowHours: 24,
      noShowThreshold: 1,
      noShowLookbackDays: 180,
      lateCancellationHours: 12,
      defaultDurationMinutes: 30,
      updatedByStaffId: null,
    });
  });

  it('creates two active staff members who sign in with demo1234', async () => {
    const staff = await prisma.staffMember.findMany({ orderBy: { email: 'asc' } });

    expect(staff.map(({ name, email, isActive }) => ({ name, email, isActive }))).toEqual([
      { name: 'Alex', email: 'alex@demo.test', isActive: true },
      { name: 'Sam', email: 'sam@demo.test', isActive: true },
    ]);
    for (const member of staff) {
      expect(await bcrypt.compare('demo1234', member.passwordHash)).toBe(true);
    }
  });

  it('creates eight clients, at least one without a phone', async () => {
    const clients = await prisma.client.findMany();

    expect(clients).toHaveLength(8);
    expect(clients.some((client) => client.phone === null)).toBe(true);
  });

  it('gives every appointment its own token hash', () => {
    const hashes = new Set(appointments.map((appointment) => appointment.tokenHash));

    expect(hashes.size).toBe(appointments.length);
    for (const hash of hashes) {
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('starts every appointment on a 15-minute mark', () => {
    for (const appointment of appointments) {
      expect(appointment.startsAt.getTime() % (15 * 60_000)).toBe(0);
    }
  });

  it('covers every status', () => {
    const statuses = new Set(appointments.map((appointment) => appointment.status));

    expect([...statuses].sort()).toEqual(['attended', 'cancelled', 'confirmed', 'no_show', 'pending']);
  });

  it('covers every dashboard case', () => {
    const pending = appointments.filter((appointment) => appointment.status === 'pending');
    const confirmed = appointments.filter((appointment) => appointment.status === 'confirmed');
    const cancelled = appointments.filter((appointment) => appointment.status === 'cancelled');
    const hoursCancelledBeforeStart = (appointment: Appointment) =>
      (appointment.startsAt.getTime() - appointment.statusChangedAt.getTime()) / hourMs;
    const startsToday = (appointment: Appointment) =>
      appointment.startsAt.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);

    expect(pending.some((appointment) => hoursUntilStart(appointment) > 0 && hoursUntilStart(appointment) <= 24)).toBe(true);
    expect(pending.some((appointment) => hoursUntilStart(appointment) > 24)).toBe(true);
    expect(confirmed.some((appointment) => appointment.confirmedBy === 'client')).toBe(true);
    expect(confirmed.some((appointment) => appointment.confirmedBy === 'staff')).toBe(true);
    expect(
      cancelled.some((appointment) => appointment.cancelledBy === 'client' && hoursCancelledBeforeStart(appointment) < 12),
    ).toBe(true);
    expect(
      cancelled.some((appointment) => appointment.cancelledBy === 'staff' && hoursCancelledBeforeStart(appointment) > 12),
    ).toBe(true);
    expect(appointments.some((appointment) => appointment.status === 'attended' && startsToday(appointment))).toBe(true);
    expect(appointments.some((appointment) => appointment.status === 'no_show' && startsToday(appointment))).toBe(true);
    expect([...pending, ...confirmed].some((appointment) => hoursUntilStart(appointment) < 0)).toBe(true);
  });

  it('has a client with one and a client with two recent no-shows, each with an upcoming appointment', () => {
    const lookbackStart = now.getTime() - 180 * dayMs;
    const noShowsByClient = new Map<string, number>();
    for (const appointment of appointments) {
      if (appointment.status === 'no_show' && appointment.startsAt.getTime() >= lookbackStart) {
        noShowsByClient.set(appointment.clientId, (noShowsByClient.get(appointment.clientId) ?? 0) + 1);
      }
    }
    const hasUpcoming = (clientId: string) =>
      appointments.some(
        (appointment) =>
          appointment.clientId === clientId &&
          (appointment.status === 'pending' || appointment.status === 'confirmed') &&
          hoursUntilStart(appointment) > 0,
      );
    const counts = [...noShowsByClient].filter(([clientId]) => hasUpcoming(clientId)).map(([, count]) => count);

    expect(counts).toContain(1);
    expect(counts).toContain(2);
  });

  it('keeps every appointment consistent with the state machine', () => {
    for (const appointment of appointments) {
      expect(appointment.statusChangedAt.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(appointment.createdAt.getTime()).toBeLessThanOrEqual(now.getTime());
      if (appointment.status === 'pending') {
        expect(appointment.confirmedBy).toBeNull();
        expect(appointment.cancelledBy).toBeNull();
      }
      if (appointment.status === 'confirmed') {
        expect(appointment.confirmedBy).not.toBeNull();
      }
      if (appointment.status === 'cancelled') {
        expect(appointment.cancelledBy).not.toBeNull();
      }
      if (appointment.status === 'attended' || appointment.status === 'no_show') {
        expect(hoursUntilStart(appointment)).toBeLessThan(0);
      }
    }
  });

  it('gives the same row counts when run twice', async () => {
    const before = await countRows();

    await seedDemoData(prisma, now);

    expect(await countRows()).toEqual(before);
  });

  it('refuses to run with APP_ENV=production and changes nothing', async () => {
    const before = await countRows();

    expect(() =>
      execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
        cwd: `${import.meta.dirname}/..`,
        env: { ...process.env, APP_ENV: 'production' },
        stdio: 'pipe',
      }),
    ).toThrow(/Refusing to seed: APP_ENV is production/);
    expect(await countRows()).toEqual(before);
  });
});
