import { app } from './app.js';
import { prisma } from './db.js';
import { ensureBusinessSettings } from './settings.js';

const port = Number(process.env.PORT ?? 3000);

try {
  await ensureBusinessSettings(prisma);
} catch {
  console.error('Database is unreachable or not migrated: start it with `docker compose up -d db` and run `npm run db:migrate`');
  process.exit(1);
}

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
