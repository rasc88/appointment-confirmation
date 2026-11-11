import type { ErrorRequestHandler } from 'express';
import { Prisma } from './generated/prisma/client.js';
import { logger } from './logger.js';
import { countAppointmentResponseFailure, type ResponseAction, type ResponseActor } from './metrics.js';

export type ErrorCode =
  | 'unauthenticated'
  | 'invalid_credentials'
  | 'cross_site_request'
  | 'not_found'
  | 'invalid_transition'
  | 'appointment_started'
  | 'appointment_not_started'
  | 'email_taken'
  | 'cannot_deactivate_self'
  | 'validation_error'
  | 'rate_limited'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export function validationError(message: string, field?: string) {
  return new ApiError(422, 'validation_error', message, field);
}

const bodyParserMessages: Record<string, string> = {
  'entity.parse.failed': 'Request body must be valid JSON.',
  'entity.too.large': 'Request body is too large.',
};

/** body-parser throws `http-errors` with a 4xx `status`, for example for an unsupported charset or encoding. */
function isClientHttpError(error: unknown) {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status <= 499;
}

function toApiError(error: unknown) {
  if (error instanceof ApiError) {
    return error;
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2039') {
    return validationError('Text must not contain the NUL character.');
  }
  const bodyParserType = (error as { type?: unknown } | null)?.type;
  if (typeof bodyParserType === 'string' && bodyParserType in bodyParserMessages) {
    return validationError(bodyParserMessages[bodyParserType]);
  }
  if (isClientHttpError(error)) {
    return validationError('Request body could not be read.');
  }
  return null;
}

/** Keyed by the route template relative to `/v1`, as `req.route.path` holds it in this handler. */
const responseRoutes: Record<string, { action: ResponseAction; actor: ResponseActor }> = {
  '/public/appointments/:token/confirm': { action: 'confirm', actor: 'client' },
  '/public/appointments/:token/cancel': { action: 'cancel', actor: 'client' },
  '/appointments/:id/confirm': { action: 'confirm', actor: 'staff' },
  '/appointments/:id/cancel': { action: 'cancel', actor: 'staff' },
};

/** Logs no message or stack: Prisma messages echo query arguments (AGENTS.md logging rule). */
export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  void next;
  const apiError = toApiError(error);
  if (apiError) {
    const { code, message, field } = apiError;
    res.status(apiError.status).json({ error: field === undefined ? { code, message } : { code, message, field } });
    return;
  }
  const name = error instanceof Error ? error.name : typeof error;
  const prismaCode = error instanceof Prisma.PrismaClientKnownRequestError ? ` ${error.code}` : '';
  const routePath: string | undefined = req.route?.path;
  logger.error(`Unhandled error: ${req.method} ${routePath ?? 'unmatched'} ${name}${prismaCode}`);
  const responseRoute = routePath === undefined ? undefined : responseRoutes[routePath];
  if (responseRoute) {
    countAppointmentResponseFailure(responseRoute.action, responseRoute.actor);
  }
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong.' } });
};
