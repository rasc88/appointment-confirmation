import express, { type ErrorRequestHandler } from 'express';
import { STATUS_CODES } from 'node:http';
import path from 'node:path';

/** Like `errors.ts`: a 4xx (missing asset, blocked traversal, malformed URL) prints nothing; anything else logs no message or stack. */
const plainTextErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  void next;
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status <= 499) {
    res.status(status).type('text/plain').send(STATUS_CODES[status]);
    return;
  }
  console.error(`Unhandled error: ${req.method} frontend ${error instanceof Error ? error.name : typeof error}`);
  res.status(500).type('text/plain').send(STATUS_CODES[500]);
};

/**
 * Hashed assets never fall back to `index.html`, so a stale tab after a deploy gets a 404, not HTML parsed as JavaScript.
 * Everything else is `no-store`, so Back after sign-out cannot restore a signed-in page from the back/forward cache.
 */
export function createFrontendRouter(frontendDir: string) {
  const router = express.Router();
  router.use(
    '/assets',
    express.static(path.join(frontendDir, 'assets'), { index: false, fallthrough: false, maxAge: '1y', immutable: true }),
  );
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.use(express.static(frontendDir, { index: false, cacheControl: false }));
  router.get('/{*splat}', (req, res) => {
    if (path.posix.basename(req.path).includes('.')) {
      res.status(404).type('text/plain').send(STATUS_CODES[404]);
      return;
    }
    res.sendFile('index.html', { root: frontendDir, cacheControl: false });
  });
  router.use(plainTextErrorHandler);
  return router;
}
