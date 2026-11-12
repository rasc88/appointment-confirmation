import { metrics, type Attributes } from '@opentelemetry/api';

export type ResponseAction = 'confirm' | 'cancel';
export type ResponseActor = 'client' | 'staff';

const durationBucketsSeconds = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
const responseActions: ResponseAction[] = ['confirm', 'cancel'];
const responseActors: ResponseActor[] = ['client', 'staff'];

/** The same values `/v1/health` reports. On every data point, because Grafana Cloud keeps resource attributes only in `target_info`. */
export function deploymentAttributes() {
  return { environment: process.env.APP_ENV ?? 'unknown', version: process.env.APP_VERSION ?? 'unknown' };
}

/** Looked up on each use: a meter taken before the SDK starts stays a no-op, and the SDK returns the same instrument for the same name. */
function meter() {
  return metrics.getMeter('appointment-confirmation');
}

function addOne(name: string, attributes: Attributes = {}) {
  meter()
    .createCounter(name)
    .add(1, { ...attributes, ...deploymentAttributes() });
}

export function countAppointmentCreated() {
  addOne('appointments_created_total');
}

export function countAppointmentResponse(action: ResponseAction, actor: ResponseActor) {
  addOne('appointment_responses_total', { action, actor });
}

export function countAppointmentResponseFailure(action: ResponseAction, actor: ResponseActor) {
  addOne('appointment_response_failures_total', { action, actor });
}

/** Gives every version a 0 sample, so `increase()` counts its first failures (decision 36). */
export function zeroResponseFailures() {
  const counter = meter().createCounter('appointment_response_failures_total');
  for (const action of responseActions) {
    for (const actor of responseActors) {
      counter.add(0, { action, actor, ...deploymentAttributes() });
    }
  }
}

export function countAppointmentOutcome(outcome: 'attended' | 'no_show') {
  addOne('appointment_outcomes_total', { outcome });
}

export function recordRequestDuration(seconds: number, attributes: Attributes) {
  meter()
    .createHistogram('http.server.request.duration', {
      unit: 's',
      advice: { explicitBucketBoundaries: durationBucketsSeconds },
    })
    .record(seconds, { ...attributes, ...deploymentAttributes() });
}
