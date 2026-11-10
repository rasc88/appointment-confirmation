import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './db.js';
import { ensureBusinessSettings } from './settings.js';

describe('ensureBusinessSettings', () => {
  beforeEach(async () => {
    await prisma.businessSettings.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the row with the spec 6.7 defaults when the table is empty', async () => {
    const returned = await ensureBusinessSettings(prisma);

    const rows = await prisma.businessSettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(returned);
    expect(rows[0]).toMatchObject({
      id: 1,
      businessName: 'My Business',
      timeZone: 'UTC',
      noReplyWindowHours: 24,
      noShowThreshold: 1,
      noShowLookbackDays: 180,
      lateCancellationHours: 12,
      defaultDurationMinutes: 30,
      messageTemplate:
        'Hi {client}, this is {business}. Please confirm your {service} appointment on {date} at {time}: {link}',
      updatedByStaffId: null,
    });
  });

  it('leaves an existing row unchanged', async () => {
    await prisma.businessSettings.create({ data: { id: 1, businessName: 'Custom', noShowThreshold: 3 } });

    const returned = await ensureBusinessSettings(prisma);

    expect(returned).toMatchObject({ businessName: 'Custom', noShowThreshold: 3 });
    const rows = await prisma.businessSettings.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ businessName: 'Custom', noShowThreshold: 3 });
  });

  it('leaves exactly one row when called twice', async () => {
    await ensureBusinessSettings(prisma);
    await ensureBusinessSettings(prisma);

    expect(await prisma.businessSettings.count()).toBe(1);
  });
});
