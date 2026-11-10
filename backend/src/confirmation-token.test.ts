import { describe, expect, it } from 'vitest';
import { generateConfirmationToken, hashConfirmationToken } from './confirmation-token.js';

describe('confirmation tokens', () => {
  it('generates a 22-character base64url token and its 64-character hex SHA-256', () => {
    const { token, tokenHash } = generateConfirmationToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes a token to the hash it was generated with', () => {
    const { token, tokenHash } = generateConfirmationToken();

    expect(hashConfirmationToken(token)).toBe(tokenHash);
  });

  it('returns a different token on each call', () => {
    expect(generateConfirmationToken().token).not.toBe(generateConfirmationToken().token);
  });
});
