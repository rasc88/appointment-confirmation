import './telemetry.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { readConfig } from './config.js';
import { prisma } from './db.js';
import { logger } from './logger.js';
import { ensureBusinessSettings } from './settings.js';

const port = Number(process.env.PORT ?? 3000);

try {
  readConfig();
} catch (error) {
  logger.error((error as Error).message);
  process.exit(1);
}

try {
  await ensureBusinessSettings(prisma);
} catch {
  logger.error('Database is unreachable or not migrated: start it with `docker compose up -d db` and run `npm run db:migrate`');
  process.exit(1);
}

const builtFrontendDir = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
const hasFrontendBuild = existsSync(path.join(builtFrontendDir, 'index.html'));
if (!hasFrontendBuild) {
  logger.info('Frontend build not found (run `npm run build`): serving the API only');
}

createApp({ frontendDir: hasFrontendBuild ? builtFrontendDir : undefined }).listen(port, () => {
  logger.info(`Backend listening on http://localhost:${port}`);
});
