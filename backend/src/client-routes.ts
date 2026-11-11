import { Router } from 'express';
import { z } from 'zod';
import { toAppointment } from './appointments.js';
import type { Config } from './config.js';
import { prisma } from './db.js';
import { ApiError, validationError } from './errors.js';
import type { Client } from './generated/prisma/client.js';
import { requireStaff } from './session.js';
import { hasLength, isUuidShaped, parseBody, stringOfLength } from './validation.js';

const maxSearchResults = 20;
const phoneMessage = 'Use only digits, spaces, +, ( ) and -, up to 30 characters.';

const createClientSchema = z.strictObject({
  name: stringOfLength(1, 80, "Enter the client's name, up to 80 characters."),
  phone: stringOfLength(1, 30, phoneMessage)
    .regex(/^[0-9+() -]+$/, phoneMessage)
    .nullable()
    .optional(),
});

function toClient({ id, name, phone, createdAt }: Client) {
  return { id, name, phone, createdAt: createdAt.toISOString() };
}

/** Prisma passes `contains` to `LIKE` unescaped, so `%` and `_` would match anything. */
function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function readSearchTerm(q: unknown) {
  if (q !== undefined && (typeof q !== 'string' || !hasLength(q, 1, 80))) {
    throw validationError('Enter 1 to 80 characters to search.', 'q');
  }
  return q;
}

export function createClientRouter(config: Config) {
  const router = Router();
  const signedIn = requireStaff(config.sessionSecret);

  router.get('/clients', signedIn, async (req, res) => {
    const q = readSearchTerm(req.query.q);
    const contains = q === undefined ? undefined : { contains: escapeLikePattern(q), mode: 'insensitive' as const };
    const clients = await prisma.client.findMany({
      where: contains === undefined ? {} : { OR: [{ name: contains }, { phone: contains }] },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: maxSearchResults,
    });
    res.json(clients.map(toClient));
  });

  router.post('/clients', signedIn, async (req, res) => {
    const { name, phone = null } = parseBody(createClientSchema, req.body);
    res.status(201).json(toClient(await prisma.client.create({ data: { name, phone } })));
  });

  router.get('/clients/:id', signedIn, async (req, res) => {
    const { id } = req.params as { id: string };
    const client = isUuidShaped(id) ? await prisma.client.findUnique({ where: { id } }) : null;
    if (!client) {
      throw new ApiError(404, 'not_found', 'Not found.');
    }
    const appointments = await prisma.appointment.findMany({
      where: { clientId: id },
      include: { staffMember: true },
      orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
    });
    res.json({
      ...toClient(client),
      noShowCount: appointments.filter(({ status }) => status === 'no_show').length,
      appointments: appointments.map((appointment) => toAppointment({ ...appointment, client })),
    });
  });

  return router;
}
