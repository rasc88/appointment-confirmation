import { useEffect, useEffectEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { Appointment, ClientDetail } from '../api/types';
import { statusText } from '../appointment-status';
import { useAuth } from '../auth/auth-context';
import { formatDate, formatTime } from '../format-date-time';

/** `loadedAt` is the browser time the response arrived, which decides whether "Edit" shows, as on the dashboard. */
type View =
  | { kind: 'loading' }
  | { kind: 'loaded'; client: ClientDetail; timeZone: string; loadedAt: number }
  | { kind: 'not-found' }
  | { kind: 'error' };

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function HistoryItem({ appointment, timeZone, loadedAt }: { appointment: Appointment; timeZone: string; loadedAt: number }) {
  const { id, staffMember, service, startsAt, durationMinutes, status } = appointment;
  const canEdit = (status === 'pending' || status === 'confirmed') && Date.parse(startsAt) > loadedAt;
  return (
    <li className="appointment">
      <span className="appointment-time">{`${formatDate(startsAt, timeZone)}, ${formatTime(startsAt, timeZone)}`}</span>
      <span>{`${durationMinutes} min`}</span>
      <span>{service}</span>
      <span>{`with ${staffMember.name}`}</span>
      <span>{statusText(appointment)}</span>
      {canEdit && <Link to={`/appointments/${id}/edit`}>Edit</Link>}
    </li>
  );
}

function ClientHistory({ client, timeZone, loadedAt }: { client: ClientDetail; timeZone: string; loadedAt: number }) {
  return (
    <>
      <h1>{client.name}</h1>
      <p className="client-history-meta">{client.phone ?? 'No phone'}</p>
      <p className="client-history-meta">{`No-shows (all time): ${client.noShowCount}`}</p>
      <p className="client-history-meta">{`Times in ${timeZone}`}</p>
      <section className="client-history-appointments" aria-labelledby="client-history-heading">
        <h2 id="client-history-heading">Appointments</h2>
        {client.appointments.length === 0 ? (
          <p>No appointments yet.</p>
        ) : (
          <ul className="appointment-list">
            {client.appointments.map((appointment) => (
              <HistoryItem key={appointment.id} appointment={appointment} timeZone={timeZone} loadedAt={loadedAt} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Keyed by the id, so another client in the URL starts again from "Loading…". */
function ClientHistoryLoader({ id }: { id: string }) {
  const api = useApi();
  const { signOut } = useAuth();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  useEffect(() => {
    let isCurrent = true;
    Promise.all([api.getClient(id), api.getSettings()]).then(
      ([client, settings]) => {
        if (isCurrent) {
          setView({ kind: 'loaded', client, timeZone: settings.timeZone, loadedAt: Date.now() });
        }
      },
      (error: unknown) => {
        if (!isCurrent) {
          return;
        }
        if (isUnauthenticated(error)) {
          handleUnauthenticated();
        } else if (isNotFound(error)) {
          setView({ kind: 'not-found' });
        } else {
          setView({ kind: 'error' });
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [api, id, loadAttempt]);

  function reload() {
    setView({ kind: 'loading' });
    setLoadAttempt((attempt) => attempt + 1);
  }

  return (
    <div className="client-history">
      {view.kind === 'loading' && <p role="status">Loading…</p>}
      {view.kind === 'not-found' && (
        <>
          <h1>Client not found</h1>
          <p>This client does not exist.</p>
          <Link to="/">Back to dashboard</Link>
        </>
      )}
      {view.kind === 'error' && (
        <>
          <p role="alert">Could not load the client. Check your connection and try again.</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </>
      )}
      {view.kind === 'loaded' && <ClientHistory client={view.client} timeZone={view.timeZone} loadedAt={view.loadedAt} />}
    </div>
  );
}

export function ClientHistoryPage() {
  const { id = '' } = useParams();
  return <ClientHistoryLoader key={id} id={id} />;
}
