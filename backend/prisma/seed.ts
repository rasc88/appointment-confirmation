import { generateConfirmationToken } from '../src/confirmation-token.js';
import { prisma as defaultPrisma } from '../src/db.js';
import type { Actor, AppointmentStatus, PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/passwords.js';

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const quarterHourMs = 15 * minuteMs;

const clientNames = [
  'Ana Torres',
  'Ben Carter',
  'Chloe Martin',
  'David Ruiz',
  'Elena Sousa',
  'Felix Novak',
  'Grace Lee',
  'Hugo Blanc',
];

interface DemoAppointment {
  client: number;
  staff: number;
  service: string;
  startsInMs: number;
  durationMinutes: number;
  status: AppointmentStatus;
  confirmedBy?: Actor;
  cancelledBy?: Actor;
  /** Only cancellations set it; otherwise derived from the status. */
  statusChangedInMs?: number;
}

/** Offsets are from `now` rounded down to a 15-minute mark. */
const demoAppointments: DemoAppointment[] = [
  { client: 0, staff: 0, service: 'Haircut', startsInMs: 2 * hourMs, durationMinutes: 30, status: 'pending' },
  { client: 1, staff: 1, service: 'Massage', startsInMs: 26 * hourMs, durationMinutes: 60, status: 'pending' },
  { client: 2, staff: 0, service: 'Colour', startsInMs: 3 * hourMs, durationMinutes: 90, status: 'confirmed', confirmedBy: 'client' },
  { client: 3, staff: 1, service: 'Haircut', startsInMs: 27 * hourMs, durationMinutes: 30, status: 'confirmed', confirmedBy: 'staff' },
  { client: 6, staff: 0, service: 'Manicure', startsInMs: 4 * hourMs, durationMinutes: 45, status: 'cancelled', cancelledBy: 'client', statusChangedInMs: -hourMs },
  { client: 7, staff: 1, service: 'Massage', startsInMs: 28 * hourMs, durationMinutes: 60, status: 'cancelled', cancelledBy: 'staff', statusChangedInMs: -hourMs },
  { client: 6, staff: 1, service: 'Haircut', startsInMs: -3 * hourMs, durationMinutes: 30, status: 'attended' },
  { client: 4, staff: 0, service: 'Colour', startsInMs: -2 * hourMs, durationMinutes: 60, status: 'no_show' },
  { client: 1, staff: 0, service: 'Haircut', startsInMs: -hourMs, durationMinutes: 30, status: 'pending' },
  { client: 4, staff: 1, service: 'Haircut', startsInMs: 25 * hourMs, durationMinutes: 30, status: 'confirmed', confirmedBy: 'client' },
  { client: 5, staff: 0, service: 'Massage', startsInMs: -20 * dayMs, durationMinutes: 60, status: 'no_show' },
  { client: 5, staff: 1, service: 'Massage', startsInMs: -60 * dayMs, durationMinutes: 60, status: 'no_show' },
  { client: 5, staff: 0, service: 'Manicure', startsInMs: 5 * hourMs, durationMinutes: 45, status: 'pending' },
];

function statusChangedAt(appointment: DemoAppointment, startsAt: Date, createdAt: Date) {
  if (appointment.statusChangedInMs !== undefined) {
    return new Date(startsAt.getTime() - appointment.startsInMs + appointment.statusChangedInMs);
  }
  if (appointment.status === 'attended' || appointment.status === 'no_show') {
    return new Date(startsAt.getTime() + appointment.durationMinutes * minuteMs);
  }
  if (appointment.status === 'confirmed') {
    return new Date(createdAt.getTime() + hourMs);
  }
  return createdAt;
}

export async function seedDemoData(prisma: PrismaClient, now = new Date()) {
  const base = Math.floor(now.getTime() / quarterHourMs) * quarterHourMs;
  const [alexHash, samHash] = await Promise.all([hashPassword('demo1234'), hashPassword('demo1234')]);

  await prisma.$transaction(async (tx) => {
    await tx.appointment.deleteMany();
    await tx.businessSettings.deleteMany();
    await tx.client.deleteMany();
    await tx.staffMember.deleteMany();

    await tx.businessSettings.create({
      data: { id: 1, businessName: 'Demo Studio', timeZone: 'Europe/Madrid' },
    });
    const staff = await tx.staffMember.createManyAndReturn({
      data: [
        { name: 'Alex', email: 'alex@demo.test', passwordHash: alexHash },
        { name: 'Sam', email: 'sam@demo.test', passwordHash: samHash },
      ],
    });
    const clients = await tx.client.createManyAndReturn({
      data: clientNames.map((name, index) => ({
        name,
        phone: index === 3 ? null : `+34 600 000 0${index}0`,
      })),
    });

    await tx.appointment.createMany({
      data: demoAppointments.map((appointment) => {
        const startsAt = new Date(base + appointment.startsInMs);
        const createdAt = new Date(startsAt.getTime() - 3 * dayMs);
        return {
          clientId: clients[appointment.client].id,
          staffMemberId: staff[appointment.staff].id,
          service: appointment.service,
          startsAt,
          durationMinutes: appointment.durationMinutes,
          status: appointment.status,
          confirmedBy: appointment.confirmedBy,
          cancelledBy: appointment.cancelledBy,
          statusChangedAt: statusChangedAt(appointment, startsAt, createdAt),
          tokenHash: generateConfirmationToken().tokenHash,
          createdAt,
        };
      }),
    });
  });
}

async function runSeed() {
  if (process.env.APP_ENV === 'production') {
    console.error('Refusing to seed: APP_ENV is production');
    process.exit(1);
  }
  await seedDemoData(defaultPrisma);
  const databaseUrl = new URL(process.env.DATABASE_URL ?? '');
  console.log(`Seeded demo data into ${databaseUrl.pathname.slice(1)} on ${databaseUrl.host}`);
  await defaultPrisma.$disconnect();
}

if (import.meta.main) {
  await runSeed();
}
