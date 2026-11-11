import { z } from 'zod';
import { validationError } from './errors.js';

/** Code points, as JSON Schema counts them, not UTF-16 units. */
export function hasLength(value: string, min: number, max: number) {
  const length = [...value].length;
  return length >= min && length <= max;
}

/** A missing or wrongly typed value gets the same message as a wrong length. */
export function stringOfLength(min: number, max: number, message: string) {
  return z.string({ error: message }).refine((value) => hasLength(value, min, max), message);
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checked before querying, so a malformed id, even one with a NUL, is a 404 or names its field. */
export function isUuidShaped(value: string) {
  return uuidPattern.test(value);
}

export function uuidString(message: string) {
  return z.string({ error: message }).regex(uuidPattern, message);
}

/** Only the first failing field is reported; unknown keys come after the contract's fields. */
export function parseBody<Schema extends z.ZodType>(schema: Schema, body: unknown): z.output<Schema> {
  const value = body === undefined ? {} : body;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw validationError('Request body must be a JSON object.');
  }
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const [issue] = result.error.issues;
  if (issue.code === 'unrecognized_keys') {
    throw validationError('Unknown field.', issue.keys[0]);
  }
  throw validationError(issue.message, issue.path.length > 0 ? String(issue.path[0]) : undefined);
}
