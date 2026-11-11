import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { prisma } from './db.js';
import { validateMessageTemplate } from './message-template.js';
import { requireStaff } from './session.js';
import { ensureBusinessSettings, toBusinessSettings } from './settings.js';
import { parseBody, stringOfLength } from './validation.js';

const timeZoneMessage = 'Must be an IANA time zone, for example Europe/Madrid.';
/** Node 24 leaves `UTC` out of `supportedValuesOf`; `Intl.DateTimeFormat` would also accept `europe/madrid` and `+01:00`. */
const timeZones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);

function wholeNumber(min: number, max: number) {
  const message = `Must be a whole number between ${min} and ${max}.`;
  return z.int({ error: message }).min(min, message).max(max, message).optional();
}

/** Fields are in the order they are checked: `parseBody` reports Zod's first issue. */
const updateSettingsSchema = z
  .strictObject({
    businessName: stringOfLength(1, 80, 'Must be between 1 and 80 characters.').optional(),
    timeZone: z
      .string({ error: timeZoneMessage })
      .refine((timeZone) => timeZones.has(timeZone), timeZoneMessage)
      .optional(),
    noReplyWindowHours: wholeNumber(1, 168),
    noShowThreshold: wholeNumber(1, 10),
    noShowLookbackDays: wholeNumber(7, 730),
    lateCancellationHours: wholeNumber(0, 168),
    defaultDurationMinutes: wholeNumber(5, 480),
    messageTemplate: z
      .string({ error: 'Must be between 1 and 500 characters.' })
      .superRefine((template, context) => {
        const message = validateMessageTemplate(template);
        if (message !== null) {
          context.addIssue({ code: 'custom', message });
        }
      })
      .optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Change at least one setting.');

export function createSettingsRouter(config: Config, now: () => Date) {
  const router = Router();
  const signedIn = requireStaff(config.sessionSecret);

  router.get('/settings', signedIn, async (req, res) => {
    res.json(toBusinessSettings(await ensureBusinessSettings(prisma)));
  });

  router.patch('/settings', signedIn, async (req, res) => {
    const body = parseBody(updateSettingsSchema, req.body);
    await ensureBusinessSettings(prisma);
    const settings = await prisma.businessSettings.update({
      where: { id: 1 },
      data: { ...body, updatedAt: now(), updatedByStaffId: res.locals.staffMember.id },
    });
    res.json(toBusinessSettings(settings));
  });

  return router;
}
