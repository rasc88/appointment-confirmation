import { trace } from '@opentelemetry/api';
import { metrics, NodeSDK } from '@opentelemetry/sdk-node';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { prisma } from './db.js';
import { zeroResponseFailures } from './metrics.js';
import { shutdownTelemetry, startTelemetry } from './telemetry.js';
import { createTestStaff, resetDatabase, signIn } from './test-helpers.js';

interface Export {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const clientName = 'Zebedee Privacymarker';
const clientPhone = '+34 699 000 111';
const searchTerm = 'Privacymarker';

let receiver: Server;
let exports: Export[];
let frontendDir: string;

/** Answers every OTLP POST with an empty success, as a collector does. */
function startReceiver() {
  exports = [];
  receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      exports.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'Content-Type': 'application/x-protobuf' }).end();
    });
  });
  return new Promise<string>((resolve) => {
    receiver.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(receiver.address() as AddressInfo).port}`));
  });
}

function bodiesFor(signal: 'traces' | 'metrics' | 'logs') {
  return exports.filter((received) => received.path === `/v1/${signal}`).map((received) => received.body.toString('utf8'));
}

beforeAll(async () => {
  frontendDir = await mkdtemp(path.join(tmpdir(), 'telemetry-frontend-'));
  await writeFile(path.join(frontendDir, 'index.html'), '<!doctype html><title>Fixture</title>');
});

afterAll(async () => {
  await shutdownTelemetry();
  vi.unstubAllEnvs();
  await new Promise((resolve) => receiver?.close(resolve));
  await rm(frontendDir, { recursive: true });
  await prisma.$disconnect();
});

describe('with no endpoint', () => {
  it.each([undefined, ''])('does not start the SDK when the endpoint is %j', (endpoint) => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', endpoint);
    const log = vi.spyOn(console, 'log');
    const error = vi.spyOn(console, 'error');

    expect(startTelemetry()).toBe(false);

    expect(trace.getTracer('x').startSpan('y').isRecording()).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
});

describe('with an endpoint', () => {
  let token: string;
  let traceBodies: string[];
  let metricBodies: string[];
  let logBodies: string[];

  /** The privacy flow of spec §16 criterion 12, exported for real to the local receiver. */
  beforeAll(async () => {
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', await startReceiver());
    vi.stubEnv('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Basic%20dGVzdDp0ZXN0,X-Extra=yes');
    vi.stubEnv('APP_ENV', 'privacy-env');
    vi.stubEnv('APP_VERSION', 'v7.7.7');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(startTelemetry()).toBe(true);

    await resetDatabase();
    const staff = await createTestStaff();
    const app = createApp();
    const agent = await signIn(app, staff.email);
    const client = await agent.post('/v1/clients').send({ name: clientName, phone: clientPhone });
    expect((await agent.get(`/v1/clients?q=${searchTerm}`)).body).toHaveLength(1);
    const created = await agent.post('/v1/appointments').send({
      clientId: client.body.id,
      staffMemberId: staff.id,
      service: 'Haircut',
      startsAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(created.status).toBe(201);
    token = new URL(created.body.confirmationLink).pathname.split('/').at(-1)!;
    expect((await request(app).get(`/v1/public/appointments/${token}`)).status).toBe(200);
    const confirmed = await request(app)
      .post(`/v1/public/appointments/${token}/confirm`)
      .set('Referer', `http://localhost:5173/c/${token}`);
    expect(confirmed.status).toBe(200);
    expect((await request(createApp({ frontendDir })).get(`/c/${token}`)).status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await shutdownTelemetry();
    vi.restoreAllMocks();
    traceBodies = bodiesFor('traces');
    metricBodies = bodiesFor('metrics');
    logBodies = bodiesFor('logs');
  });

  it('POSTs protobuf to /v1/traces, /v1/metrics and /v1/logs with every configured header', () => {
    expect(new Set(exports.map((received) => received.path))).toEqual(new Set(['/v1/traces', '/v1/metrics', '/v1/logs']));
    for (const received of exports) {
      expect(received.headers['content-type']).toBe('application/x-protobuf');
      expect(received.headers.authorization).toBe('Basic dGVzdDp0ZXN0');
      expect(received.headers['x-extra']).toBe('yes');
    }
  });

  it('sends what the flow produced', () => {
    expect(traceBodies.join('')).toContain('/v1/public/appointments/:token/confirm');
    expect(traceBodies.join('')).toContain('/{*splat}');
    expect(metricBodies.join('')).toContain('appointment_responses_total');
    expect(metricBodies.join('')).toContain('appointments_created_total');
    expect(metricBodies.join('')).toContain('appointment_response_failures_total');
    expect(logBodies.join('')).toContain('request');
  });

  it('records no token, client name, phone, search term or /c/ path', () => {
    const forbidden = [token, clientName, ...clientName.split(' '), clientPhone, searchTerm, '/c/'];
    for (const body of [...traceBodies, ...metricBodies, ...logBodies]) {
      for (const value of forbidden) {
        expect(body).not.toContain(value);
      }
    }
  });

  it('describes the service and environment, with no detected resource attributes', () => {
    for (const received of exports) {
      const body = received.body.toString('utf8');
      for (const value of ['service.name', 'appointment-confirmation', 'service.version', 'v7.7.7']) {
        expect(body).toContain(value);
      }
      expect(body).toContain('deployment.environment.name');
      expect(body).toContain('privacy-env');
      expect(body).toContain('telemetry.sdk.language');
      for (const detected of ['host.', 'process.', 'os.']) {
        expect(body).not.toContain(detected);
      }
    }
  });
});

describe('the response failure counter', () => {
  it('starts at 0 for every action and actor, with environment and version', async () => {
    vi.stubEnv('APP_ENV', 'zero-env');
    vi.stubEnv('APP_VERSION', 'v0.0.1');
    const exporter = new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE);
    const reader = new metrics.PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
    const sdk = new NodeSDK({ autoDetectResources: false, metricReaders: [reader] });
    sdk.start();

    zeroResponseFailures();
    await reader.forceFlush();

    const points = exporter
      .getMetrics()
      .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
      .flatMap((scopeMetrics) => scopeMetrics.metrics)
      .filter((metric) => metric.descriptor.name === 'appointment_response_failures_total')
      .flatMap((metric) => metric.dataPoints)
      .map((point) => ({ attributes: point.attributes, value: point.value }));
    const deployment = { environment: 'zero-env', version: 'v0.0.1' };
    expect(points).toHaveLength(4);
    expect(points).toEqual(
      expect.arrayContaining([
        { attributes: { action: 'confirm', actor: 'client', ...deployment }, value: 0 },
        { attributes: { action: 'confirm', actor: 'staff', ...deployment }, value: 0 },
        { attributes: { action: 'cancel', actor: 'client', ...deployment }, value: 0 },
        { attributes: { action: 'cancel', actor: 'staff', ...deployment }, value: 0 },
      ]),
    );
    await sdk.shutdown();
    await shutdownTelemetry();
    vi.unstubAllEnvs();
  });
});
