import type { Actor, Appointment, AppointmentStatus, BusinessSettings, Client, StaffMember } from './types';

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const quarterHourMs = 15 * minuteMs;

export interface DemoStaffMember extends StaffMember {
  password: string;
}

/** Stores ids rather than the embedded client and staff member, so renames show everywhere. */
export interface DemoAppointment extends Omit<Appointment, 'client' | 'staffMember'> {
  clientId: string;
  staffMemberId: string;
  token: string;
}

export interface DemoData {
  settings: BusinessSettings;
  staff: DemoStaffMember[];
  clients: Client[];
  appointments: DemoAppointment[];
}

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

interface SeedAppointment {
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

/** The same rows as `backend/prisma/seed.ts`. Offsets are from `now` rounded down to a 15-minute mark. */
const seedAppointments: SeedAppointment[] = [
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

function statusChangedAt(appointment: SeedAppointment, startsAtMs: number, createdAtMs: number) {
  if (appointment.statusChangedInMs !== undefined) {
    return startsAtMs - appointment.startsInMs + appointment.statusChangedInMs;
  }
  if (appointment.status === 'attended' || appointment.status === 'no_show') {
    return startsAtMs + appointment.durationMinutes * minuteMs;
  }
  if (appointment.status === 'confirmed') {
    return createdAtMs + hourMs;
  }
  return createdAtMs;
}

export function buildDemoData(now: Date): DemoData {
  const base = Math.floor(now.getTime() / quarterHourMs) * quarterHourMs;
  const nowIso = now.toISOString();
  const settings: BusinessSettings = {
    businessName: 'Demo Studio',
    timeZone: 'Europe/Madrid',
    noReplyWindowHours: 24,
    noShowThreshold: 1,
    noShowLookbackDays: 180,
    lateCancellationHours: 12,
    defaultDurationMinutes: 30,
    messageTemplate: 'Hi {client}, this is {business}. Please confirm your {service} appointment on {date} at {time}: {link}',
    updatedAt: nowIso,
  };
  const staff: DemoStaffMember[] = ['Alex', 'Sam'].map((name) => ({
    id: crypto.randomUUID(),
    name,
    email: `${name.toLowerCase()}@demo.test`,
    isActive: true,
    createdAt: nowIso,
    password: 'demo1234',
  }));
  const clients: Client[] = clientNames.map((name, index) => ({
    id: crypto.randomUUID(),
    name,
    phone: index === 3 ? null : `+34 600 000 0${index}0`,
    createdAt: nowIso,
  }));
  const appointments: DemoAppointment[] = seedAppointments.map((appointment, index) => {
    const startsAtMs = base + appointment.startsInMs;
    const createdAtMs = startsAtMs - 3 * dayMs;
    return {
      id: crypto.randomUUID(),
      clientId: clients[appointment.client].id,
      staffMemberId: staff[appointment.staff].id,
      service: appointment.service,
      startsAt: new Date(startsAtMs).toISOString(),
      durationMinutes: appointment.durationMinutes,
      status: appointment.status,
      confirmedBy: appointment.confirmedBy ?? null,
      cancelledBy: appointment.cancelledBy ?? null,
      statusChangedAt: new Date(statusChangedAt(appointment, startsAtMs, createdAtMs)).toISOString(),
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: nowIso,
      token: `demo-${index + 1}`,
    };
  });
  return { settings, staff, clients, appointments };
}
