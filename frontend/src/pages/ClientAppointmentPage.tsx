import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useParams } from 'react-router';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { PublicAppointment } from '../api/types';
import { formatDate, formatTime } from '../format-date-time';

type View =
  | { kind: 'loading' }
  | { kind: 'loaded'; appointment: PublicAppointment }
  | { kind: 'invalid' }
  | { kind: 'error' };

type Action = 'confirm' | 'cancel';

const changedAlert = 'Your answer was not saved because this appointment had already changed.';
const notSavedAlert = 'Your answer was not saved. Check your connection and try again.';

function viewForLoadError(error: unknown): View {
  return error instanceof ApiError && error.status === 404 ? { kind: 'invalid' } : { kind: 'error' };
}

function statusHeading({ status, hasStarted }: PublicAppointment): string {
  if (status === 'cancelled') {
    return 'This appointment is cancelled';
  }
  if (hasStarted || status === 'attended' || status === 'no_show') {
    return 'This appointment has passed';
  }
  return status === 'pending' ? 'Please confirm your appointment' : 'Your appointment is confirmed';
}

function AppointmentDetails({ appointment }: { appointment: PublicAppointment }) {
  const { service, staffName, startsAt, timeZone, durationMinutes } = appointment;
  return (
    <dl className="client-details">
      <dt>Service</dt>
      <dd>{service}</dd>
      <dt>With</dt>
      <dd>{staffName}</dd>
      <dt>Date</dt>
      <dd>{formatDate(startsAt, timeZone)}</dd>
      <dt>Time</dt>
      <dd>{`${formatTime(startsAt, timeZone)}, ${timeZone}`}</dd>
      <dt>Duration</dt>
      <dd>{`${durationMinutes} minutes`}</dd>
    </dl>
  );
}

export function ClientAppointmentPage() {
  const api = useApi();
  const { token = '' } = useParams();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [runningAction, setRunningAction] = useState<Action | null>(null);
  const [isCancelPromptOpen, setIsCancelPromptOpen] = useState(false);
  const [alert, setAlert] = useState('');
  const keepButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let isCurrent = true;
    api.getPublicAppointment(token).then(
      (appointment) => {
        if (isCurrent) {
          setView({ kind: 'loaded', appointment });
        }
      },
      (error: unknown) => {
        if (isCurrent) {
          setView(viewForLoadError(error));
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [api, token, loadAttempt]);

  function retryLoad() {
    setView({ kind: 'loading' });
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function reloadAfterConflict() {
    try {
      setView({ kind: 'loaded', appointment: await api.getPublicAppointment(token) });
      setAlert(changedAlert);
    } catch (error) {
      setView(viewForLoadError(error));
    }
  }

  async function runAction(action: Action) {
    setAlert('');
    setRunningAction(action);
    try {
      const send = action === 'confirm' ? api.confirmPublicAppointment : api.cancelPublicAppointment;
      setView({ kind: 'loaded', appointment: await send(token) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setView({ kind: 'invalid' });
      } else if (error instanceof ApiError && error.status === 409) {
        await reloadAfterConflict();
      } else {
        setAlert(notSavedAlert);
      }
    }
    setIsCancelPromptOpen(false);
    setRunningAction(null);
  }

  function openCancelPrompt() {
    setAlert('');
    flushSync(() => setIsCancelPromptOpen(true));
    keepButtonRef.current?.focus();
  }

  function keepAppointment() {
    flushSync(() => setIsCancelPromptOpen(false));
    cancelButtonRef.current?.focus();
  }

  if (view.kind === 'loading') {
    return (
      <main className="client-page">
        <p role="status">Loading your appointment…</p>
      </main>
    );
  }

  if (view.kind === 'invalid') {
    return (
      <main className="client-page">
        <div className="client-card">
          <h1>This link is not valid</h1>
          <p>It may have been replaced by a newer link. Contact the business that sent it.</p>
        </div>
      </main>
    );
  }

  if (view.kind === 'error') {
    return (
      <main className="client-page">
        <div className="client-card">
          <h1>Something went wrong</h1>
          <p role="alert">We could not load your appointment. Check your connection and try again.</p>
          <button type="button" onClick={retryLoad}>
            Try again
          </button>
        </div>
      </main>
    );
  }

  const { appointment } = view;
  const heading = statusHeading(appointment);
  const canConfirm = heading === 'Please confirm your appointment';
  const canCancel = canConfirm || heading === 'Your appointment is confirmed';
  const isBusy = runningAction !== null;

  return (
    <main className="client-page">
      <div className="client-card">
        <h1>{appointment.businessName}</h1>
        <div role="status">
          <h2>{heading}</h2>
        </div>
        {appointment.status === 'cancelled' && <p>{`To book again, contact ${appointment.businessName}.`}</p>}
        {heading === 'This appointment has passed' && <p>This link can no longer confirm or cancel it.</p>}
        <AppointmentDetails appointment={appointment} />
        {alert && <p role="alert" className="form-error">{alert}</p>}
        {canCancel && isCancelPromptOpen && (
          <div className="client-actions">
            <p>Cancel this appointment?</p>
            <button type="button" className="secondary" ref={keepButtonRef} disabled={isBusy} onClick={keepAppointment}>
              Keep appointment
            </button>
            <button type="button" disabled={isBusy} onClick={() => runAction('cancel')}>
              {runningAction === 'cancel' ? 'Cancelling…' : 'Yes, cancel it'}
            </button>
          </div>
        )}
        {canCancel && !isCancelPromptOpen && (
          <div className="client-actions">
            {canConfirm && (
              <button type="button" disabled={isBusy} onClick={() => runAction('confirm')}>
                {runningAction === 'confirm' ? 'Confirming…' : 'Confirm appointment'}
              </button>
            )}
            <button type="button" className="secondary" ref={cancelButtonRef} disabled={isBusy} onClick={openCancelPrompt}>
              Cancel appointment
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
