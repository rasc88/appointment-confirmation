import { isSpanContextValid, trace } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

type LogFields = Record<string, string | number>;

/** Without an exporter the OTLP logger is a no-op and the active span is never valid, so trace IDs only appear with export on. */
function write(level: 'info' | 'error', msg: string, fields: LogFields) {
  const spanContext = trace.getActiveSpan()?.spanContext();
  const traceFields =
    spanContext && isSpanContextValid(spanContext) ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields, ...traceFields });
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  logs.getLogger('appointment-confirmation').emit({
    severityNumber: level === 'error' ? SeverityNumber.ERROR : SeverityNumber.INFO,
    severityText: level.toUpperCase(),
    body: msg,
    attributes: fields,
  });
}

/** Field values must never hold a header, raw path, query, body, IP, staff identity, or error message (AGENTS.md). */
export const logger = {
  info: (msg: string, fields: LogFields = {}) => write('info', msg, fields),
  error: (msg: string, fields: LogFields = {}) => write('error', msg, fields),
};
