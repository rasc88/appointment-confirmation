import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { prisma } from './db.js';
import { ApiError } from './errors.js';
import { verifyPassword } from './passwords.js';
import { createSessionToken, requireStaff, sessionCookie, sessionDurationMs } from './session.js';
import { createSignInRateLimit } from './sign-in-rate-limit.js';
import { toStaffMember } from './staff-routes.js';
import { parseBody } from './validation.js';

/** Compared against for an unknown email, so timing does not reveal which emails exist. */
const unknownEmailPasswordHash = '$2b$12$P6QbuNcPBwal.DZy5uEwz.4bBulbcMt/Y2NeBLmHLuxJNcO19KgEi';

const loginSchema = z.strictObject({
  email: z.string({ error: 'Enter your email.' }),
  password: z.string({ error: 'Enter your password.' }),
});

export function createAuthRouter(config: Config) {
  const router = Router();
  const signInRateLimit = createSignInRateLimit();

  router.post('/auth/login', async (req, res) => {
    const { email, password } = parseBody(loginSchema, req.body);
    const lowercaseEmail = email.toLowerCase();
    const rateLimitKey = `${req.ip} ${lowercaseEmail}`;
    const retryAfterSeconds = signInRateLimit.retryAfterSeconds(rateLimitKey);
    if (retryAfterSeconds !== null) {
      res.set('Retry-After', String(retryAfterSeconds));
      throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
    }
    const staffMember = await prisma.staffMember.findUnique({ where: { email: lowercaseEmail } });
    const isPasswordCorrect = await verifyPassword(password, staffMember?.passwordHash ?? unknownEmailPasswordHash);
    if (!staffMember || !isPasswordCorrect || !staffMember.isActive) {
      signInRateLimit.recordFailure(rateLimitKey);
      throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    }
    signInRateLimit.clear(rateLimitKey);
    const token = createSessionToken(staffMember.id, config.sessionSecret);
    res.set('Set-Cookie', sessionCookie(token, sessionDurationMs / 1000, config.publicBaseUrl));
    res.json(toStaffMember(staffMember));
  });

  router.post('/auth/logout', (req, res) => {
    res.set('Set-Cookie', sessionCookie('', 0, config.publicBaseUrl));
    res.status(204).end();
  });

  router.get('/auth/me', requireStaff(config.sessionSecret), (req, res) => {
    res.json(toStaffMember(res.locals.staffMember));
  });

  return router;
}
