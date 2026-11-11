import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { logs, metrics, NodeSDK, tracing } from '@opentelemetry/sdk-node';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import type { Client, StaffMember } from './generated/prisma/client.js';
import { shutdownTelemetry } from './telemetry.js';
import { createTestAppointment, createTestClient, createTestStaff, resetDatabase, signIn } from './test-helpers.js';

const spanExporter = new tracing.InMemorySpanExporter();
const metricExporter = new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.DELTA);
const metricReader = new metrics.PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 3_600_000 });
const logExporter = new logs.InMemoryLogRecordExporter();
const deployment = { environment: 'test-env', version: 'v9.9.9' };
const startsAt = new Date('2026-11-11T09:30:00Z');

let now: Date;
let app: ReturnType<typeof createApp>;
let alex: StaffMember;
let maria: Client;

beforeAll(() => {
  new NodeSDK({
    autoDetectResources: false,
    spanProcessors: [new tracing.SimpleSpanProcessor(spanExporter)],
    metricReaders: [metricReader],
    logRecordProcessors: [new logs.SimpleLogRecordProcessor({ exporter: logExporter })],
  }).start();
});

beforeEach(async () => {
  vi.stubEnv('APP_ENV', deployment.environment);
  vi.stubEnv('APP_VERSION', deployment.version);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await resetDatabase();
  now = new Date('2026-11-10T10:07:00Z');
  app = createApp({ now: () => now });
  await prisma.businessSettings.create({ data: { id: 1, businessName: 'Demo Studio', timeZone: 'Europe/Madrid' } });
  alex = await createTestStaff({ name: 'Alex', email: 'alex@demo.test' });
  maria = await createTestClient({ name: 'Maria Lopez', phone: '+34 600 123 456' });
  await metricReader.forceFlush();
  metricExporter.reset();
  spanExporter.reset();
  logExporter.reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await shutdownTelemetry();
  await prisma.$disconnect();
});

/** The span and log line are written when the response closes, just after supertest has the response. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function requestSpans() {
  await settle();
  return spanExporter.getFinishedSpans().filter((span) => span.kind === SpanKind.SERVER);
}

async function onlySpan() {
  const spans = await requestSpans();
  expect(spans).toHaveLength(1);
  return spans[0];
}

function loggedLines() {
  return [vi.mocked(console.log), vi.mocked(console.error)].flatMap((spy) =>
    spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>),
  );
}

function requestLines() {
  return loggedLines().filter((line) => line.msg === 'request');
}

/** Data points since the last call, as `{ attributes, value }`. */
async function dataPoints(name: string) {
  await metricReader.forceFlush();
  return metricExporter
    .getMetrics()
    .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
    .flatMap((scopeMetrics) => scopeMetrics.metrics)
    .filter((metric) => metric.descriptor.name === name)
    .flatMap((metric): metrics.DataPoint<unknown>[] => metric.dataPoints)
    .map(({ attributes, value }) => ({ attributes, value }));
}

async function counterTotal(name: string) {
  return (await dataPoints(name)).reduce((total, point) => total + Number(point.value), 0);
}

function appointmentFor(options: Partial<Parameters<typeof createTestAppointment>[0]> = {}) {
  return createTestAppointment({ clientId: maria.id, staffMemberId: alex.id, startsAt, ...options });
}

function publicAction(action: 'confirm' | 'cancel', token: string, ip = '203.0.113.1') {
  return request(app).post(`/v1/public/appointments/${token}/${action}`).set('X-Forwarded-For', ip);
}

describe('request span', () => {
  it('is a new root SERVER span named by the route template, with only method, route and status', async () => {
    const response = await request(app)
      .get('/v1/clients?q=secret')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');

    expect(response.status).toBe(401);
    const span = await onlySpan();
    expect(span.name).toBe('GET /v1/clients');
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).not.toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/v1/clients',
      'http.response.status_code': 401,
    });
    expect(span.status).toEqual({ code: SpanStatusCode.UNSET });
    expect(span.events).toEqual([]);
    expect(span.links).toEqual([]);
  });

  it('keeps the route template on a public 429', async () => {
    for (let count = 0; count < 31; count += 1) {
      await request(app).get('/v1/public/appointments/x').set('X-Forwarded-For', '198.51.100.7');
    }

    const spans = await requestSpans();
    expect(spans.at(-1)?.name).toBe('GET /v1/public/appointments/:token');
    expect(spans.at(-1)?.attributes['http.response.status_code']).toBe(429);
  });

  it.each([
    ['GET', '/v1/nope', 404],
    ['POST', '/v1/clients', 403],
  ])('is named %s only for an unmatched %s, with no route', async (method, url, status) => {
    const pending = method === 'GET' ? request(app).get(url) : request(app).post(url).set('Origin', 'https://evil.test');

    expect((await pending).status).toBe(status);
    const span = await onlySpan();
    expect(span.name).toBe(method);
    expect(span.attributes).toEqual({ 'http.request.method': method, 'http.response.status_code': status });
  });

  it('records an unknown method as _OTHER', async () => {
    await request(app).search('/v1/clients');

    const span = await onlySpan();
    expect(span.name).toBe('_OTHER');
    expect(span.attributes['http.request.method']).toBe('_OTHER');
  });

  it('records a /c/{token} page load as /{*splat}', async () => {
    const frontendDir = await mkdtemp(path.join(tmpdir(), 'telemetry-frontend-'));
    await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>Fixture</title>');

    const response = await request(createApp({ frontendDir })).get('/c/abcdefghijklmnopqrstuv');
    await rm(frontendDir, { recursive: true });

    expect(response.status).toBe(200);
    const span = await onlySpan();
    expect(span.name).toBe('GET /{*splat}');
    expect(span.attributes['http.route']).toBe('/{*splat}');
  });

  it('marks a 5xx as ERROR with no message, and the error log line carries its trace', async () => {
    const appointment = await appointmentFor();
    vi.spyOn(prisma.appointment, 'findUnique').mockRejectedValueOnce(new TypeError('boom'));

    const response = await request(app).get(`/v1/public/appointments/${appointment.token}`);

    expect(response.status).toBe(500);
    const span = await onlySpan();
    expect(span.name).toBe('GET /v1/public/appointments/:token');
    expect(span.attributes['http.response.status_code']).toBe(500);
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR });
    const ids = { trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId };
    expect(loggedLines()).toEqual([
      expect.objectContaining({ level: 'error', msg: 'Unhandled error: GET /public/appointments/:token TypeError', ...ids }),
      expect.objectContaining({ level: 'error', msg: 'request', status: 500, ...ids }),
    ]);
  });

  it('keeps the trace on an error after the JSON body is read', async () => {
    const agent = await signIn(app, alex.email);
    spanExporter.reset();
    vi.mocked(console.error).mockClear();
    vi.spyOn(prisma.appointment, 'create').mockRejectedValueOnce(new TypeError('boom'));

    const response = await agent
      .post('/v1/appointments')
      .send({ clientId: maria.id, staffMemberId: alex.id, service: 'Haircut', startsAt: '2026-11-12T10:00:00Z' });

    expect(response.status).toBe(500);
    const span = await onlySpan();
    expect(loggedLines()).toContainEqual(
      expect.objectContaining({
        msg: 'Unhandled error: POST /appointments TypeError',
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
      }),
    );
  });
});

describe('request log line', () => {
  it('has exactly the documented fields, with the trace of its span', async () => {
    await request(app).get('/v1/clients');

    const span = await onlySpan();
    const [line] = requestLines();
    expect(Object.keys(line)).toEqual(['time', 'level', 'msg', 'method', 'route', 'status', 'durationMs', 'trace_id', 'span_id']);
    expect(line).toMatchObject({
      level: 'info',
      msg: 'request',
      method: 'GET',
      route: '/v1/clients',
      status: 401,
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
    expect(new Date(String(line.time)).toISOString()).toBe(line.time);
    expect(Number.isInteger(line.durationMs)).toBe(true);
  });

  it('leaves out the route when none matched', async () => {
    await request(app).get('/v1/nope?q=secret');
    await settle();

    expect(requestLines()).toEqual([expect.objectContaining({ level: 'info', method: 'GET', status: 404 })]);
    expect(requestLines()[0]).not.toHaveProperty('route');
  });

  it('is also an OTLP log record with severity, body, attributes and the span context', async () => {
    await request(app).get('/v1/clients');

    const span = await onlySpan();
    const record = logExporter.getFinishedLogRecords().find((logRecord) => logRecord.body === 'request');
    expect(record?.severityText).toBe('INFO');
    expect(record?.attributes).toMatchObject({ method: 'GET', route: '/v1/clients', status: 401 });
    expect(Object.keys(record?.attributes ?? {})).toEqual(['method', 'route', 'status', 'durationMs']);
    expect(record?.spanContext?.spanId).toBe(span.spanContext().spanId);
  });
});

describe('http.server.request.duration', () => {
  it('is recorded in seconds with method, route, status, environment and version, and fixed buckets', async () => {
    await request(app).get('/v1/clients');
    await settle();

    const [point] = await dataPoints('http.server.request.duration');
    expect(point.attributes).toEqual({
      'http.request.method': 'GET',
      'http.route': '/v1/clients',
      'http.response.status_code': 401,
      ...deployment,
    });
    expect((point.value as { buckets: { boundaries: number[] } }).buckets.boundaries).toEqual([
      0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5,
    ]);
    expect((point.value as { sum: number }).sum).toBeLessThan(5);
  });
});

describe('application counters', () => {
  it('counts a created appointment, not a rejected one', async () => {
    const agent = await signIn(app, alex.email);
    const body = { clientId: maria.id, staffMemberId: alex.id, service: 'Haircut', startsAt: '2026-11-12T10:00:00Z' };

    expect((await agent.post('/v1/appointments').send(body)).status).toBe(201);
    expect((await agent.post('/v1/appointments').send({ ...body, service: '' })).status).toBe(422);

    expect(await dataPoints('appointments_created_total')).toEqual([{ attributes: deployment, value: 1 }]);
  });

  it('counts a client confirm and cancel, but not a repeat confirm, 404, 409 or 429', async () => {
    const first = await appointmentFor();
    const second = await appointmentFor();

    expect((await publicAction('confirm', first.token)).status).toBe(200);
    expect((await publicAction('confirm', first.token)).status).toBe(200);
    expect((await publicAction('cancel', second.token)).status).toBe(200);
    expect((await publicAction('cancel', second.token)).status).toBe(409);
    expect((await publicAction('confirm', 'abcdefghijklmnopqrstuvwxyz')).status).toBe(404);
    for (let count = 0; count < 31; count += 1) {
      await publicAction('confirm', first.token, '198.51.100.9');
    }

    expect(await dataPoints('appointment_responses_total')).toEqual(
      expect.arrayContaining([
        { attributes: { action: 'confirm', actor: 'client', ...deployment }, value: 1 },
        { attributes: { action: 'cancel', actor: 'client', ...deployment }, value: 1 },
      ]),
    );
    expect(await counterTotal('appointment_response_failures_total')).toBe(0);
  });

  it('counts a staff confirm and cancel, but not a repeat confirm or a 409', async () => {
    const agent = await signIn(app, alex.email);
    const first = await appointmentFor();
    const second = await appointmentFor();

    expect((await agent.post(`/v1/appointments/${first.id}/confirm`)).status).toBe(200);
    expect((await agent.post(`/v1/appointments/${first.id}/confirm`)).status).toBe(200);
    expect((await agent.post(`/v1/appointments/${second.id}/cancel`)).status).toBe(200);
    expect((await agent.post(`/v1/appointments/${second.id}/cancel`)).status).toBe(409);
    expect((await agent.post(`/v1/appointments/${second.id}/confirm`)).status).toBe(409);

    const points = await dataPoints('appointment_responses_total');
    expect(points).toHaveLength(2);
    expect(points).toEqual(
      expect.arrayContaining([
        { attributes: { action: 'confirm', actor: 'staff', ...deployment }, value: 1 },
        { attributes: { action: 'cancel', actor: 'staff', ...deployment }, value: 1 },
      ]),
    );
  });

  it.each([
    ['confirm', 'client'],
    ['cancel', 'client'],
    ['confirm', 'staff'],
    ['cancel', 'staff'],
  ] as const)('counts a 5xx on a %s by %s as a failure', async (action, actor) => {
    const agent = await signIn(app, alex.email);
    const appointment = await appointmentFor();
    vi.spyOn(prisma.appointment, 'update').mockRejectedValueOnce(new TypeError('boom'));

    const response =
      actor === 'client'
        ? await publicAction(action, appointment.token)
        : await agent.post(`/v1/appointments/${appointment.id}/${action}`);

    expect(response.status).toBe(500);
    expect(await dataPoints('appointment_response_failures_total')).toEqual([
      { attributes: { action, actor, ...deployment }, value: 1 },
    ]);
    expect(await counterTotal('appointment_responses_total')).toBe(0);
  });

  it('counts no failure for a 5xx elsewhere', async () => {
    const appointment = await appointmentFor();
    vi.spyOn(prisma.appointment, 'findUnique').mockRejectedValueOnce(new TypeError('boom'));

    expect((await request(app).get(`/v1/public/appointments/${appointment.token}`)).status).toBe(500);

    expect(await counterTotal('appointment_response_failures_total')).toBe(0);
  });

  it('counts an outcome, but neither a 422 nor an undo', async () => {
    const agent = await signIn(app, alex.email);
    const appointment = await appointmentFor({ startsAt: new Date('2026-11-10T09:00:00Z') });
    const appointmentPath = `/v1/appointments/${appointment.id}`;

    expect((await agent.post(`${appointmentPath}/outcome`).send({ outcome: 'maybe' })).status).toBe(422);
    expect((await agent.post(`${appointmentPath}/outcome`).send({ outcome: 'no_show' })).status).toBe(200);
    expect((await agent.post(`${appointmentPath}/undo-outcome`)).status).toBe(200);

    expect(await dataPoints('appointment_outcomes_total')).toEqual([
      { attributes: { outcome: 'no_show', ...deployment }, value: 1 },
    ]);
  });

  it('defaults environment and version to unknown', async () => {
    vi.unstubAllEnvs();
    const agent = await signIn(app, alex.email);

    await agent.post(`/v1/appointments/${(await appointmentFor()).id}/confirm`);

    expect(await dataPoints('appointment_responses_total')).toEqual([
      { attributes: { action: 'confirm', actor: 'staff', environment: 'unknown', version: 'unknown' }, value: 1 },
    ]);
  });
});
