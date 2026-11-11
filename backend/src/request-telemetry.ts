import { context, SpanKind, SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';
import type { Request, RequestHandler } from 'express';
import { logger } from './logger.js';
import { recordRequestDuration } from './metrics.js';

const knownMethods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

function normalizeMethod(method: string) {
  return knownMethods.has(method) ? method : '_OTHER';
}

/** Express's own template, read when the response closes, so `/c/{token}` is `/{*splat}` and never its raw path. */
function routeTemplate(req: Request) {
  const routePath: string | undefined = req.route?.path;
  return routePath === undefined ? undefined : req.baseUrl + routePath;
}

/**
 * Mounted first. A new root span per request, so an incoming `traceparent` is ignored. Only the attributes set here are
 * recorded: no header, raw path, or query.
 */
export const recordRequestTelemetry: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  const method = normalizeMethod(req.method);
  const span = trace
    .getTracer('appointment-confirmation')
    .startSpan(method, { kind: SpanKind.SERVER, root: true, attributes: { 'http.request.method': method } });
  const spanContext = trace.setSpan(context.active(), span);

  res.once(
    'close',
    context.bind(spanContext, () => {
      const durationMs = performance.now() - startedAt;
      const route = routeTemplate(req);
      const status = res.statusCode;
      const isServerError = status >= 500;
      const attributes: Attributes = {
        'http.request.method': method,
        ...(route === undefined ? {} : { 'http.route': route }),
        'http.response.status_code': status,
      };
      span.setAttributes(attributes);
      span.updateName(route === undefined ? method : `${method} ${route}`);
      if (isServerError) {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      const fields = { method, ...(route === undefined ? {} : { route }), status, durationMs: Math.round(durationMs) };
      if (isServerError) {
        logger.error('request', fields);
      } else {
        logger.info('request', fields);
      }
      span.end();
      recordRequestDuration(durationMs / 1000, attributes);
    }),
  );
  context.with(spanContext, next);
};
