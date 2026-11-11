import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { prisma } from './db.js';
import { ApiError } from './errors.js';
import { Prisma, type StaffMember } from './generated/prisma/client.js';
import { hashPassword } from './passwords.js';
import { requireStaff } from './session.js';
import { parseBody, stringOfLength } from './validation.js';

export function toStaffMember({ id, name, email, isActive, createdAt }: StaffMember) {
  return { id, name, email, isActive, createdAt: createdAt.toISOString() };
}

const emailPattern = /^[^\s@]+@[^\s@]+$/;
const emailMessage = 'Enter a valid email address.';
const nameSchema = stringOfLength(1, 80, 'Must be between 1 and 80 characters.');

const createStaffMemberSchema = z.strictObject({
  name: nameSchema,
  email: z
    .string({ error: emailMessage })
    .refine((email) => [...email].length <= 254 && emailPattern.test(email), emailMessage),
  password: stringOfLength(8, 72, 'Must be between 8 and 72 characters.'),
});

const updateStaffMemberSchema = z
  .strictObject({
    name: nameSchema.optional(),
    isActive: z.boolean({ error: 'Must be true or false.' }).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one field.');

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function createStaffRouter(config: Config) {
  const router = Router();
  const signedIn = requireStaff(config.sessionSecret);

  router.get('/staff', signedIn, async (req, res) => {
    const staff = await prisma.staffMember.findMany({ orderBy: [{ createdAt: 'asc' }, { email: 'asc' }] });
    res.json(staff.map(toStaffMember));
  });

  router.post('/staff', signedIn, async (req, res) => {
    const { name, email, password } = parseBody(createStaffMemberSchema, req.body);
    try {
      const staffMember = await prisma.staffMember.create({
        data: { name, email: email.toLowerCase(), passwordHash: await hashPassword(password) },
      });
      res.status(201).json(toStaffMember(staffMember));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiError(409, 'email_taken', 'Another staff account already has this email.');
      }
      throw error;
    }
  });

  router.patch('/staff/:id', signedIn, async (req, res) => {
    const { id } = req.params as { id: string };
    if (!(await prisma.staffMember.findUnique({ where: { id } }))) {
      throw new ApiError(404, 'not_found', 'Not found.');
    }
    const body = parseBody(updateStaffMemberSchema, req.body);
    if (body.isActive === false && id === res.locals.staffMember.id) {
      throw new ApiError(409, 'cannot_deactivate_self', 'You cannot deactivate your own account.');
    }
    res.json(toStaffMember(await prisma.staffMember.update({ where: { id }, data: body })));
  });

  return router;
}
