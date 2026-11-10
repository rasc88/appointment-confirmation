import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { hashPassword } from './passwords.js';

describe('hashPassword', () => {
  it('produces a bcrypt hash that accepts only the original password', async () => {
    const hash = await hashPassword('correct horse');

    expect(hash.startsWith('$2')).toBe(true);
    expect(await bcrypt.compare('correct horse', hash)).toBe(true);
    expect(await bcrypt.compare('wrong horse', hash)).toBe(false);
  });
});
