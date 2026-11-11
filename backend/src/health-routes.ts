import { Router } from 'express';
import type { Config } from './config.js';
import { prisma } from './db.js';
import { logger } from './logger.js';

/** Logs only the error name: Prisma and `pg` messages can include the host or the query. */
export function createHealthRouter({ environment, version }: Config) {
  const router = Router();

  router.get('/health', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', environment, version });
    } catch (error) {
      logger.error(`Health check failed: ${error instanceof Error ? error.name : typeof error}`);
      res.status(503).json({ status: 'unavailable', environment, version });
    }
  });

  return router;
}
