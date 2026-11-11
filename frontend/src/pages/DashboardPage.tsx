import { useEffect, useEffectEvent, useState } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { AtRiskReason, DayAppointment, DayView, StaffMember } from '../api/types';
import { statusText } from '../appointment-status';
import { useAuth } from '../auth/auth-context';
import { formatTime } from '../format-date-time';

const refreshIntervalMs = 30_000;

const groupNames = ['At risk', 'Pending', 'Confirmed', 'Cancelled', 'Needs outcome', 'Completed'] as const;

type GroupName = (typeof groupNames)[number];

/** `loadedAt` is the browser time the response arrived, which decides Needs outcome (decision 23). */
type View = { kind: 'loading' } | { kind: 'loaded'; dayView: DayView; loadedAt: number } | { kind: 'error' };

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function groupOf(appointment: DayAppointment, now: number): GroupName {
  const { status } = appointment;
  if (status === 'cancelled') {
    return 'Cancelled';
  }
  if (status === 'attended' || status === 'no_show') {
    return 'Completed';
  }
  if (Date.parse(appointment.startsAt) <= now) {
    return 'Needs outcome';
  }
  if (appointment.atRiskReasons.length > 0) {
    return 'At risk';
  }
  return status === 'pending' ? 'Pending' : 'Confirmed';
}

function reasonText(reason: AtRiskReason): string {
  return reason.code === 'no_reply' ? 'No reply yet' : `Missed ${reason.noShowCount} before`;
}

function AppointmentItem({ appointment, group, timeZone }: { appointment: DayAppointment; group: GroupName; timeZone: string }) {
  const { id, client, staffMember, service, startsAt, durationMinutes, atRiskReasons, isLateCancellation } = appointment;
  const canEdit = group === 'At risk' || group === 'Pending' || group === 'Confirmed';
  return (
    <li className="appointment">
      <span className="appointment-time">{formatTime(startsAt, timeZone)}</span>
      <span>{`${durationMinutes} min`}</span>
      <Link className="appointment-client" to={`/clients/${client.id}`}>
        {client.name}
      </Link>
      <span>{service}</span>
      <span>{`with ${staffMember.name}`}</span>
      <span>{statusText(appointment)}</span>
      {group === 'At risk' &&
        atRiskReasons.map((reason) => (
          <span key={reason.code} className="flag">
            {reasonText(reason)}
          </span>
        ))}
      {group === 'Cancelled' && isLateCancellation && <span className="flag">Late cancellation</span>}
      {canEdit && <Link to={`/appointments/${id}/edit`}>Edit</Link>}
    </li>
  );
}

type Group = { name: GroupName; appointments: DayAppointment[] };

function groupAppointments(dayView: DayView, loadedAt: number): Group[] {
  return groupNames.map((name) => ({
    name,
    appointments: dayView.appointments.filter((appointment) => groupOf(appointment, loadedAt) === name),
  }));
}

function DayGroups({ dayView, groups }: { dayView: DayView; groups: Group[] }) {
  return (
    <>
      {dayView.appointments.length === 0 && <p>No appointments on this day.</p>}
      {groups.map(({ name, appointments }) => (
        <details key={name} open className="dashboard-group">
          <summary>{`${name} (${appointments.length})`}</summary>
          {appointments.length === 0 ? (
            <p>No appointments.</p>
          ) : (
            <ul className="appointment-list">
              {appointments.map((appointment) => (
                <AppointmentItem key={appointment.id} appointment={appointment} group={name} timeZone={dayView.timeZone} />
              ))}
            </ul>
          )}
        </details>
      ))}
    </>
  );
}

export function DashboardPage() {
  const api = useApi();
  const { signOut } = useAuth();
  const [date, setDate] = useState('');
  const [staffId, setStaffId] = useState('');
  const [activeStaff, setActiveStaff] = useState<StaffMember[]>([]);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [hasRefreshFailed, setHasRefreshFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  useEffect(() => {
    let isCurrent = true;
    api.listStaff().then(
      (staff) => {
        if (isCurrent) {
          setActiveStaff(staff.filter((staffMember) => staffMember.isActive));
        }
      },
      (error: unknown) => {
        if (isCurrent && isUnauthenticated(error)) {
          handleUnauthenticated();
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [api]);

  useEffect(() => {
    let isCurrent = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const params: { date?: string; staffId?: string } = {};
    if (date) {
      params.date = date;
    }
    if (staffId) {
      params.staffId = staffId;
    }

    function scheduleRefresh() {
      refreshTimer = setTimeout(() => load(true), refreshIntervalMs);
    }

    function load(isRefresh: boolean) {
      api.getDayView(params).then(
        (dayView) => {
          if (isCurrent) {
            setView({ kind: 'loaded', dayView, loadedAt: Date.now() });
            setHasRefreshFailed(false);
            scheduleRefresh();
          }
        },
        (error: unknown) => {
          if (!isCurrent) {
            return;
          }
          if (isUnauthenticated(error)) {
            handleUnauthenticated();
          } else if (isRefresh) {
            setHasRefreshFailed(true);
            scheduleRefresh();
          } else {
            setView({ kind: 'error' });
          }
        },
      );
    }

    load(false);
    return () => {
      isCurrent = false;
      clearTimeout(refreshTimer);
    };
  }, [api, date, staffId, loadAttempt]);

  /** Also bumps `loadAttempt`, so choosing a value that is already selected still ends the loading state. */
  function reload() {
    setView({ kind: 'loading' });
    setHasRefreshFailed(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  const shownDate = date || (view.kind === 'loaded' ? view.dayView.date : '');
  const groups = view.kind === 'loaded' ? groupAppointments(view.dayView, view.loadedAt) : [];

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>
      <div className="dashboard-bar">
        <div className="dashboard-filters">
          <div className="field">
            <label htmlFor="dashboard-date">Date</label>
            <input
              id="dashboard-date"
              type="date"
              value={shownDate}
              onChange={(event) => {
                setDate(event.target.value);
                reload();
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="dashboard-staff">Staff</label>
            <select
              id="dashboard-staff"
              value={staffId}
              onChange={(event) => {
                setStaffId(event.target.value);
                reload();
              }}
            >
              <option value="">All staff</option>
              {activeStaff.map((staffMember) => (
                <option key={staffMember.id} value={staffMember.id}>
                  {staffMember.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {view.kind === 'loaded' && (
          <>
            <p className="dashboard-meta">{`Times in ${view.dayView.timeZone}`}</p>
            <p className="dashboard-meta">
              {groups.map(({ name, appointments }) => `${name} ${appointments.length}`).join(', ')}
            </p>
          </>
        )}
        {view.kind === 'loaded' && hasRefreshFailed && <p role="status">Could not refresh. Trying again in 30 seconds.</p>}
      </div>
      {view.kind === 'loading' && <p role="status">Loading appointments…</p>}
      {view.kind === 'error' && (
        <>
          <p role="alert">Could not load appointments. Check your connection and try again.</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </>
      )}
      {view.kind === 'loaded' && <DayGroups dayView={view.dayView} groups={groups} />}
    </div>
  );
}
