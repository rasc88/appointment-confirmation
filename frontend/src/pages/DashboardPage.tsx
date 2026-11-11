import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import type { AtRiskReason, DayAppointment, DayView, StaffMember } from '../api/types';
import { statusText } from '../appointment-status';
import { useAuth } from '../auth/auth-context';
import { formatTime } from '../format-date-time';

const refreshIntervalMs = 30_000;

const groupNames = ['At risk', 'Pending', 'Confirmed', 'Cancelled', 'Needs outcome', 'Completed'] as const;

type GroupName = (typeof groupNames)[number];

/** `loadedAt` is the browser time the response arrived, which decides Needs outcome (decision 23). */
type View = { kind: 'loading' } | { kind: 'loaded'; dayView: DayView; loadedAt: number } | { kind: 'error' };

type Action = 'confirm' | 'cancel' | 'attended' | 'no_show' | 'undo';

type RunningAction = { appointmentId: string; action: Action };

/** An action whose request has settled and that ends once the day view has reloaded. */
type PendingAction = { appointmentId: string; alert: string };

const runningLabels: Record<Action, string> = {
  confirm: 'Confirming…',
  cancel: 'Cancelling…',
  attended: 'Saving…',
  no_show: 'Saving…',
  undo: 'Undoing…',
};

const notSavedAlert = 'Could not save. Check your connection and try again.';

const dateInputId = 'dashboard-date';
const keepButtonId = 'dashboard-keep-appointment';

function clientLinkId(appointmentId: string): string {
  return `client-link-${appointmentId}`;
}

function cancelButtonId(appointmentId: string): string {
  return `cancel-button-${appointmentId}`;
}

function focusAppointment(appointmentId: string) {
  (document.getElementById(clientLinkId(appointmentId)) ?? document.getElementById(dateInputId))?.focus();
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function sendAction(api: ApiService, appointmentId: string, action: Action) {
  if (action === 'confirm') {
    return api.confirmAppointment(appointmentId);
  }
  if (action === 'cancel') {
    return api.cancelAppointment(appointmentId);
  }
  if (action === 'undo') {
    return api.undoAppointmentOutcome(appointmentId);
  }
  return api.recordAppointmentOutcome(appointmentId, { outcome: action });
}

/** `null` for a failure that tells the page nothing about the appointment, so there is nothing to reload. */
function alertAfterReload(error: ApiError): string | null {
  if (error.status === 404) {
    return 'That appointment no longer exists. Nothing was saved.';
  }
  if (error.status !== 409) {
    return null;
  }
  if (error.code === 'appointment_started') {
    return 'That appointment has already started. Nothing was saved.';
  }
  if (error.code === 'appointment_not_started') {
    return 'That appointment has not started yet. Nothing was saved.';
  }
  return 'That appointment had already changed. Nothing was saved.';
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

/** The groups before the start, where an appointment can still be edited or cancelled. */
function isUpcoming(group: GroupName): boolean {
  return group === 'At risk' || group === 'Pending' || group === 'Confirmed';
}

function reasonText(reason: AtRiskReason): string {
  return reason.code === 'no_reply' ? 'No reply yet' : `Missed ${reason.noShowCount} before`;
}

type ActionControls = {
  runningAction: RunningAction | null;
  cancelPromptId: string | null;
  runAction(appointmentId: string, action: Action): void;
  openCancelPrompt(appointmentId: string): void;
  keepAppointment(appointmentId: string): void;
};

function AppointmentActions({ appointment, group, controls }: { appointment: DayAppointment; group: GroupName; controls: ActionControls }) {
  const { id, status } = appointment;
  const { runningAction, cancelPromptId } = controls;
  const isBusy = runningAction !== null;

  function actionButton(action: Action, label: string) {
    const isRunning = runningAction?.appointmentId === id && runningAction.action === action;
    return (
      <button key={action} type="button" disabled={isBusy} onClick={() => controls.runAction(id, action)}>
        {isRunning ? runningLabels[action] : label}
      </button>
    );
  }

  if (group === 'Cancelled') {
    return null;
  }
  if (group === 'Completed') {
    return actionButton('undo', 'Undo');
  }
  if (group === 'Needs outcome') {
    return [actionButton('attended', 'Attended'), actionButton('no_show', 'No-show')];
  }
  if (cancelPromptId === id) {
    return (
      <span className="cancel-prompt">
        <span>Cancel this appointment?</span>
        <button type="button" id={keepButtonId} className="secondary" disabled={isBusy} onClick={() => controls.keepAppointment(id)}>
          Keep appointment
        </button>
        {actionButton('cancel', 'Yes, cancel it')}
      </span>
    );
  }
  return (
    <>
      {status === 'pending' && actionButton('confirm', 'Confirm')}
      <button
        type="button"
        id={cancelButtonId(id)}
        className="secondary"
        disabled={isBusy}
        onClick={() => controls.openCancelPrompt(id)}
      >
        Cancel
      </button>
    </>
  );
}

function AppointmentItem({
  appointment,
  group,
  timeZone,
  controls,
}: {
  appointment: DayAppointment;
  group: GroupName;
  timeZone: string;
  controls: ActionControls;
}) {
  const { id, client, staffMember, service, startsAt, durationMinutes, atRiskReasons, isLateCancellation } = appointment;
  return (
    <li className="appointment">
      <span className="appointment-time">{formatTime(startsAt, timeZone)}</span>
      <span>{`${durationMinutes} min`}</span>
      <Link id={clientLinkId(id)} className="appointment-client" to={`/clients/${client.id}`}>
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
      {isUpcoming(group) && <Link to={`/appointments/${id}/edit`}>Edit</Link>}
      <AppointmentActions appointment={appointment} group={group} controls={controls} />
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

function DayGroups({ dayView, groups, controls }: { dayView: DayView; groups: Group[]; controls: ActionControls }) {
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
                <AppointmentItem
                  key={appointment.id}
                  appointment={appointment}
                  group={name}
                  timeZone={dayView.timeZone}
                  controls={controls}
                />
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
  /** `isAfterAction` keeps what is shown if the reload after an action fails, as a refresh does. */
  const [loadRequest, setLoadRequest] = useState({ attempt: 0, isAfterAction: false });
  const [runningAction, setRunningAction] = useState<RunningAction | null>(null);
  const [cancelPromptId, setCancelPromptId] = useState<string | null>(null);
  const [alert, setAlert] = useState('');
  /** Set before the request, so a second click in the same task sees it before any render. */
  const isActionRunningRef = useRef(false);
  const pendingActionRef = useRef<PendingAction | null>(null);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  function finishAction(appointmentId: string, alertText: string) {
    isActionRunningRef.current = false;
    flushSync(() => {
      setRunningAction(null);
      setCancelPromptId(null);
      setAlert(alertText);
    });
    focusAppointment(appointmentId);
  }

  const finishPendingAction = useEffectEvent(() => {
    const pendingAction = pendingActionRef.current;
    if (pendingAction) {
      pendingActionRef.current = null;
      finishAction(pendingAction.appointmentId, pendingAction.alert);
    }
  });

  /** Keeps an open cancel prompt only while its appointment can still be cancelled, and never leaves focus on a removed button. */
  const showDayView = useEffectEvent((dayView: DayView) => {
    const loadedAt = Date.now();
    const focused = document.activeElement;
    const isFocusInPrompt = focused?.closest('.cancel-prompt') != null;
    const promptAppointment = dayView.appointments.find((appointment) => appointment.id === cancelPromptId);
    const isPromptKept = promptAppointment !== undefined && isUpcoming(groupOf(promptAppointment, loadedAt));
    flushSync(() => {
      setView({ kind: 'loaded', dayView, loadedAt });
      setHasRefreshFailed(false);
      if (!isPromptKept) {
        setCancelPromptId(null);
      }
    });
    if (cancelPromptId !== null && isFocusInPrompt && !focused?.isConnected) {
      if (isPromptKept) {
        document.getElementById(keepButtonId)?.focus();
      } else {
        focusAppointment(cancelPromptId);
      }
    }
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
    const hasPendingAction = pendingActionRef.current !== null;
    const params: { date?: string; staffId?: string } = {};
    if (date) {
      params.date = date;
    }
    if (staffId) {
      params.staffId = staffId;
    }

    /** A refresh due while an action runs is skipped; the reload after the action restarts the cycle. */
    function scheduleRefresh() {
      refreshTimer = setTimeout(() => (isActionRunningRef.current ? scheduleRefresh() : load(true)), refreshIntervalMs);
    }

    function load(isRefresh: boolean, shouldFinishAction = false) {
      api.getDayView(params).then(
        (dayView) => {
          if (isCurrent) {
            showDayView(dayView);
            scheduleRefresh();
            if (shouldFinishAction) {
              finishPendingAction();
            }
          }
        },
        (error: unknown) => {
          if (!isCurrent) {
            return;
          }
          if (isUnauthenticated(error)) {
            handleUnauthenticated();
          } else if (isRefresh) {
            setView((current) => (current.kind === 'loaded' ? current : { kind: 'error' }));
            setHasRefreshFailed(true);
            scheduleRefresh();
          } else {
            setView({ kind: 'error' });
          }
          if (shouldFinishAction) {
            finishPendingAction();
          }
        },
      );
    }

    load(loadRequest.isAfterAction, hasPendingAction);
    return () => {
      isCurrent = false;
      clearTimeout(refreshTimer);
    };
  }, [api, date, staffId, loadRequest]);

  /** Also bumps `attempt`, so choosing a value that is already selected still ends the loading state. */
  function reload() {
    setView({ kind: 'loading' });
    setHasRefreshFailed(false);
    setAlert('');
    setLoadRequest(({ attempt }) => ({ attempt: attempt + 1, isAfterAction: false }));
  }

  async function runAction(appointmentId: string, action: Action) {
    if (isActionRunningRef.current) {
      return;
    }
    isActionRunningRef.current = true;
    setAlert('');
    if (action !== 'cancel') {
      setCancelPromptId(null);
    }
    setRunningAction({ appointmentId, action });
    let alertText = '';
    try {
      await sendAction(api, appointmentId, action);
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
        return;
      }
      const reloadAlert = error instanceof ApiError ? alertAfterReload(error) : null;
      if (reloadAlert === null) {
        finishAction(appointmentId, notSavedAlert);
        return;
      }
      alertText = reloadAlert;
    }
    pendingActionRef.current = { appointmentId, alert: alertText };
    setLoadRequest(({ attempt }) => ({ attempt: attempt + 1, isAfterAction: true }));
  }

  function openCancelPrompt(appointmentId: string) {
    setAlert('');
    flushSync(() => setCancelPromptId(appointmentId));
    document.getElementById(keepButtonId)?.focus();
  }

  function keepAppointment(appointmentId: string) {
    flushSync(() => setCancelPromptId(null));
    document.getElementById(cancelButtonId(appointmentId))?.focus();
  }

  const controls: ActionControls = {
    runningAction,
    cancelPromptId,
    runAction: (appointmentId, action) => void runAction(appointmentId, action),
    openCancelPrompt,
    keepAppointment,
  };

  const shownDate = date || (view.kind === 'loaded' ? view.dayView.date : '');
  const groups = view.kind === 'loaded' ? groupAppointments(view.dayView, view.loadedAt) : [];

  return (
    <div className="dashboard">
      <h1>Dashboard</h1>
      <div className="dashboard-bar">
        <div className="dashboard-filters">
          <div className="field">
            <label htmlFor={dateInputId}>Date</label>
            <input
              id={dateInputId}
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
        {alert && (
          <p role="alert" className="form-error">
            {alert}
          </p>
        )}
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
      {view.kind === 'loaded' && <DayGroups dayView={view.dayView} groups={groups} controls={controls} />}
    </div>
  );
}
