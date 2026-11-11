import bcrypt from 'bcryptjs';

const bcryptCost = 12;

export function hashPassword(password: string) {
  return bcrypt.hash(password, bcryptCost);
}

export function verifyPassword(password: string, passwordHash: string) {
  return bcrypt.compare(password, passwordHash);
}
