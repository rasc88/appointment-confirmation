import { Router, type RequestHandler } from 'express';
import { hashConfirmationToken } from './confirmation-token.js';
import { prisma } from './db.js';
import { ApiError } from './errors.js';
import { Prisma, type AppointmentStatus } from './generated/prisma/client.js';
import { countAppointmentResponse } from './metrics.js';
import { createPublicRateLimit } from './public-rate-limit.js';
import { ensureBusinessSettings } from './settings.js';

const tokenPattern = /^[A-Za-z0-9_-]{22,128}$/;
const finalStatuses: AppointmentStatus[] = ['cancelled', 'attended', 'no_show'];

/** Never `client`, so client data cannot reach the response. */
const publicInclude = { staffMember: true } satisfies Prisma.AppointmentInclude;

type PublicAppointmentRow = Prisma.AppointmentGetPayload<{ include: typeof publicInclude }>;

function invalidTransition() {
  return new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.');
}

async function toPublicAppointment(appointment: PublicAppointmentRow, now: Date) {
  const settings = await ensureBusinessSettings(prisma);
  return {
    businessName: settings.businessName,
    timeZone: settings.timeZone,
    service: appointment.service,
    staffName: appointment.staffMember.name,
    startsAt: appointment.startsAt.toISOString(),
    durationMinutes: appointment.durationMinutes,
    status: appointment.status,
    hasStarted: now >= appointment.startsAt,
  };
}

/** A malformed token is the same 404 as an unknown one, without hashing or a query. */
async function findByToken(token: string) {
  const appointment = tokenPattern.test(token)
    ? await prisma.appointment.findUnique({
        where: { tokenHash: hashConfirmationToken(token) },
        include: publicInclude,
      })
    : null;
  if (!appointment) {
    throw new ApiError(404, 'not_found', 'This link is not valid.');
  }
  return appointment;
}

/** Spec 12.2 order: a final status before a started one. */
function assertClientCanChange(appointment: PublicAppointmentRow, now: Date) {
  if (finalStatuses.includes(appointment.status)) {
    throw invalidTransition();
  }
  if (now >= appointment.startsAt) {
    throw new ApiError(409, 'appointment_started', 'This appointment has already started.');
  }
}

/** The status in `where` turns a change since the lookup into a 409, not a lost write. */
async function updateIfStatus(
  where: Prisma.AppointmentWhereUniqueInput,
  data: Prisma.AppointmentUncheckedUpdateInput,
) {
  try {
    return await prisma.appointment.update({ where, data, include: publicInclude });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      throw invalidTransition();
    }
    throw error;
  }
}

/** Mounted before the JSON parser, so no body is ever read. */
export function createPublicRouter(now: () => Date) {
  const router = Router();
  const publicRateLimit = createPublicRateLimit();

  const limitRequests: RequestHandler = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const retryAfterSeconds = publicRateLimit.recordRequest(req.ip ?? '');
    if (retryAfterSeconds !== null) {
      res.set('Retry-After', String(retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
    }
    next();
  };

  router.get('/public/appointments/:token', limitRequests, async (req, res) => {
    const requestTime = now();
    res.json(await toPublicAppointment(await findByToken((req.params as { token: string }).token), requestTime));
  });

  router.post('/public/appointments/:token/confirm', limitRequests, async (req, res) => {
    const requestTime = now();
    const appointment = await findByToken((req.params as { token: string }).token);
    assertClientCanChange(appointment, requestTime);
    const isPending = appointment.status === 'pending';
    const confirmed = isPending
      ? await updateIfStatus(
          { tokenHash: appointment.tokenHash, status: 'pending' },
          { status: 'confirmed', confirmedBy: 'client', statusChangedAt: requestTime },
        )
      : appointment;
    if (isPending) {
      countAppointmentResponse('confirm', 'client');
    }
    res.json(await toPublicAppointment(confirmed, requestTime));
  });

  router.post('/public/appointments/:token/cancel', limitRequests, async (req, res) => {
    const requestTime = now();
    const appointment = await findByToken((req.params as { token: string }).token);
    assertClientCanChange(appointment, requestTime);
    const cancelled = await updateIfStatus(
      { tokenHash: appointment.tokenHash, status: { in: ['pending', 'confirmed'] } },
      { status: 'cancelled', cancelledBy: 'client', statusChangedAt: requestTime },
    );
    countAppointmentResponse('cancel', 'client');
    res.json(await toPublicAppointment(cancelled, requestTime));
  });

  return router;
}
