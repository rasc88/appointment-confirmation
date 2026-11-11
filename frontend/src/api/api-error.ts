import type { ErrorCode } from './types';

export class ApiError extends Error {
  status: number;
  code: ErrorCode;
  field?: string;

  constructor(status: number, code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}
