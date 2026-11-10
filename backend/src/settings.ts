import type { PrismaClient } from './generated/prisma/client.js';

/** The column defaults in `schema.prisma` are the spec 6.7 defaults. */
export function ensureBusinessSettings(prisma: PrismaClient) {
  return prisma.businessSettings.upsert({
    where: { id: 1 },
    create: { id: 1 },
    update: {},
  });
}
