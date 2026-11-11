import { createApp } from './app.js';
import { readConfig } from './config.js';
import { prisma } from './db.js';
import { ensureBusinessSettings } from './settings.js';

const port = Number(process.env.PORT ?? 3000);

try {
  readConfig();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

try {
  await ensureBusinessSettings(prisma);
} catch {
  console.error('Database is unreachable or not migrated: start it with `docker compose up -d db` and run `npm run db:migrate`');
  process.exit(1);
}

createApp().listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
