import type { ErrorRequestHandler } from 'express';
import { Prisma } from './generated/prisma/client.js';

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

function toApiError(error: unknown) {
  if (error instanceof ApiError) {
    return error;
  }
  const bodyParserType = (error as { type?: unknown } | null)?.type;
  if (typeof bodyParserType === 'string' && bodyParserType in bodyParserMessages) {
    return validationError(bodyParserMessages[bodyParserType]);
  }
  return null;
}

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
  console.error(`Unhandled error: ${req.method} ${req.route?.path ?? 'unmatched'} ${name}${prismaCode}`);
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong.' } });
};
