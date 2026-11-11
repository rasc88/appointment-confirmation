import express, { type RequestHandler } from 'express';
import { createAppointmentRouter } from './appointment-routes.js';
import { createAuthRouter } from './auth-routes.js';
import { createClientRouter } from './client-routes.js';
import { readConfig } from './config.js';
import { ApiError, errorHandler } from './errors.js';
import { createFrontendRouter } from './frontend.js';
import { createHealthRouter } from './health-routes.js';
import { createPublicRouter } from './public-routes.js';
import { recordRequestTelemetry } from './request-telemetry.js';
import { createSettingsRouter } from './settings-routes.js';
import { createStaffRouter } from './staff-routes.js';

const checkedMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
};

const setSecurityHeaders: RequestHandler = (req, res, next) => {
  res.set(securityHeaders);
  next();
};

/** A missing `Origin` passes: browsers send it on every cross-site write (decision 26). */
function rejectCrossSiteRequests(appOrigin: string): RequestHandler {
  return (req, res, next) => {
    const origin = req.headers.origin;
    const isChecked = checkedMethods.has(req.method) && !req.path.startsWith('/public/');
    if (isChecked && origin !== undefined && origin !== appOrigin) {
      throw new ApiError(403, 'cross_site_request', 'Cross-site requests are not allowed.');
    }
    next();
  };
}

/** Builds a fresh app, with fresh rate-limit state, on each call. Sessions and the rate limit ignore `now`. */
export function createApp(options: { now?: () => Date; frontendDir?: string } = {}) {
  const { now = () => new Date(), frontendDir } = options;
  const config = readConfig();
  const app = express();
  app.set('trust proxy', 1);
  app.use(recordRequestTelemetry);
  app.use(setSecurityHeaders);

  const v1 = express.Router();
  v1.use(createHealthRouter(config));
  v1.use(rejectCrossSiteRequests(new URL(config.publicBaseUrl).origin));
  v1.use(createPublicRouter(now));
  v1.use(express.json({ limit: '100kb', strict: false }));
  v1.use(createAuthRouter(config));
  v1.use(createStaffRouter(config));
  v1.use(createClientRouter(config));
  v1.use(createAppointmentRouter(config, now));
  v1.use(createSettingsRouter(config, now));
  v1.use(() => {
    throw new ApiError(404, 'not_found', 'Not found.');
  });
  v1.use(errorHandler);

  app.use('/v1', v1);
  if (frontendDir !== undefined) {
    app.use(createFrontendRouter(frontendDir));
  }
  return app;
}
