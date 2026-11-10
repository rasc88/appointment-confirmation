import bcrypt from 'bcryptjs';

const bcryptCost = 12;

export function hashPassword(password: string) {
  return bcrypt.hash(password, bcryptCost);
}
