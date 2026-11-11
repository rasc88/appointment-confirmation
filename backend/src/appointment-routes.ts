import { Router } from 'express';
import { z } from 'zod';
import { appointmentInclude, loadAppointment, toAppointment, toAppointmentWithLink } from './appointments.js';
import type { Config } from './config.js';
import { generateConfirmationToken } from './confirmation-token.js';
import { prisma } from './db.js';
import { ApiError, validationError } from './errors.js';
import { Prisma, type AppointmentStatus } from './generated/prisma/client.js';
import { requireStaff } from './session.js';
import { ensureBusinessSettings } from './settings.js';
import { parseBody, stringOfLength, uuidString } from './validation.js';

const changeableStatuses: AppointmentStatus[] = ['pending', 'confirmed'];
const durationMessage = 'Enter a duration from 5 to 480 minutes.';

const staffMemberIdSchema = uuidString('Choose an active staff member.');
const serviceSchema = stringOfLength(1, 80, 'Enter the service, up to 80 characters.');
const startsAtSchema = z.iso.datetime({ offset: true, error: 'Enter a valid date and time.' });
const durationMinutesSchema = z.int({ error: durationMessage }).min(5, durationMessage).max(480, durationMessage);

const createAppointmentSchema = z.strictObject({
  clientId: uuidString('Choose a client.'),
  staffMemberId: staffMemberIdSchema,
  service: serviceSchema,
  startsAt: startsAtSchema,
  durationMinutes: durationMinutesSchema.optional(),
});

const updateAppointmentSchema = z
  .strictObject({
    staffMemberId: staffMemberIdSchema.optional(),
    service: serviceSchema.optional(),
    startsAt: startsAtSchema.optional(),
    durationMinutes: durationMinutesSchema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field.');

function invalidTransition() {
  return new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.');
}

function assertChangeable({ status }: { status: AppointmentStatus }) {
  if (!changeableStatuses.includes(status)) {
    throw invalidTransition();
  }
}

async function assertActiveStaffMember(id: string) {
  const staffMember = await prisma.staffMember.findUnique({ where: { id } });
  if (!staffMember?.isActive) {
    throw validationError('Choose an active staff member.', 'staffMemberId');
  }
}

function assertInFuture(startsAt: Date, now: Date) {
  if (startsAt <= now) {
    throw validationError('Choose a time in the future.', 'startsAt');
  }
}

/** Filters on the checked statuses, so a status changed since the check is a 409, not a lost write. */
async function updateChangeable(id: string, data: Prisma.AppointmentUncheckedUpdateInput) {
  try {
    return await prisma.appointment.update({
      where: { id, status: { in: changeableStatuses } },
      data,
      include: appointmentInclude,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw invalidTransition();
    }
    throw error;
  }
}

export function createAppointmentRouter(config: Config, now: () => Date) {
  const router = Router();
  const signedIn = requireStaff(config.sessionSecret);

  router.post('/appointments', signedIn, async (req, res) => {
    const requestTime = now();
    const body = parseBody(createAppointmentSchema, req.body);
    if (!(await prisma.client.findUnique({ where: { id: body.clientId } }))) {
      throw validationError('Choose a client.', 'clientId');
    }
    await assertActiveStaffMember(body.staffMemberId);
    const startsAt = new Date(body.startsAt);
    assertInFuture(startsAt, requestTime);
    const settings = await ensureBusinessSettings(prisma);
    const { token, tokenHash } = generateConfirmationToken();
    const appointment = await prisma.appointment.create({
      data: {
        ...body,
        startsAt,
        durationMinutes: body.durationMinutes ?? settings.defaultDurationMinutes,
        status: 'pending',
        statusChangedAt: requestTime,
        tokenHash,
      },
      include: appointmentInclude,
    });
    res.status(201).json(toAppointmentWithLink(appointment, token, settings, config.publicBaseUrl));
  });

  router.get('/appointments/:id', signedIn, async (req, res) => {
    res.json(toAppointment(await loadAppointment((req.params as { id: string }).id)));
  });

  router.patch('/appointments/:id', signedIn, async (req, res) => {
    const requestTime = now();
    const appointment = await loadAppointment((req.params as { id: string }).id);
    assertChangeable(appointment);
    const { startsAt: startsAtText, ...body } = parseBody(updateAppointmentSchema, req.body);
    if (body.staffMemberId !== undefined) {
      await assertActiveStaffMember(body.staffMemberId);
    }
    const startsAt = startsAtText === undefined ? undefined : new Date(startsAtText);
    const isStartChanged = startsAt !== undefined && startsAt.getTime() !== appointment.startsAt.getTime();
    if (isStartChanged) {
      assertInFuture(startsAt, requestTime);
    }
    const startChange = isStartChanged
      ? {
          startsAt,
          status: 'pending' as const,
          confirmedBy: null,
          ...(appointment.status === 'confirmed' ? { statusChangedAt: requestTime } : {}),
        }
      : {};
    res.json(toAppointment(await updateChangeable(appointment.id, { ...body, ...startChange })));
  });

  router.post('/appointments/:id/link', signedIn, async (req, res) => {
    const requestTime = now();
    const appointment = await loadAppointment((req.params as { id: string }).id);
    assertChangeable(appointment);
    if (requestTime >= appointment.startsAt) {
      throw new ApiError(409, 'appointment_started', 'This appointment has already started.');
    }
    const settings = await ensureBusinessSettings(prisma);
    const { token, tokenHash } = generateConfirmationToken();
    const updated = await updateChangeable(appointment.id, { tokenHash });
    res.json(toAppointmentWithLink(updated, token, settings, config.publicBaseUrl));
  });

  return router;
}
