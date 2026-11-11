import express, { type Response } from 'express';
import path from 'node:path';

function revalidate(res: Response) {
  res.setHeader('Cache-Control', 'no-cache');
}

/** Hashed assets never fall back to `index.html`, so a stale tab after a deploy gets a 404, not HTML parsed as JavaScript. */
export function createFrontendRouter(frontendDir: string) {
  const router = express.Router();
  router.use(
    '/assets',
    express.static(path.join(frontendDir, 'assets'), { index: false, fallthrough: false, maxAge: '1y', immutable: true }),
  );
  router.use(express.static(frontendDir, { index: false, setHeaders: revalidate }));
  router.get('/{*splat}', (req, res) => {
    revalidate(res);
    res.sendFile('index.html', { root: frontendDir });
  });
  return router;
}
