import { createHash, randomBytes } from 'node:crypto';

export function hashConfirmationToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function generateConfirmationToken() {
  const token = randomBytes(16).toString('base64url');
  return { token, tokenHash: hashConfirmationToken(token) };
}
