import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link, useParams } from 'react-router';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type {
  Appointment,
  AppointmentStatus,
  AppointmentWithLink,
  BusinessSettings,
  StaffMember,
  UpdateAppointmentRequest,
} from '../api/types';
import { statusText } from '../appointment-status';
import { useAuth } from '../auth/auth-context';
import { ConfirmationLink } from '../ConfirmationLink';
import { formatDate, formatTime, utcToWallTime, wallTimeToUtc } from '../format-date-time';
import { AppointmentFields, validateFields, type AppointmentFieldValues, type FieldErrors } from './NewAppointmentPage';

/** `loadedAt` is the browser time the appointment arrived, which decides whether it can still be edited (decision 31). */
interface Loaded {
  appointment: Appointment;
  settings: BusinessSettings;
  staff: StaffMember[];
  loadedAt: number;
}

type View = { kind: 'loading' } | ({ kind: 'loaded' } & Loaded) | { kind: 'not-found' } | { kind: 'error' };

type Action = 'save' | 'regenerate';

const editableFields = ['staffMemberId', 'service', 'startsAt', 'durationMinutes'] as const;

type EditableField = (typeof editableFields)[number];

const saveButtonId = 'save-changes';
const regenerateButtonId = 'regenerate-link';
const clientLinkId = 'client-link';
const saveFailedAlert = 'Could not save. Check your connection and try again.';
const regenerateFailedAlert = 'Could not make a new link. Check your connection and try again.';

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409;
}

function isEditableField(field: string | undefined): field is EditableField {
  return editableFields.includes(field as EditableField);
}

function isEditable({ status, startsAt }: Appointment, loadedAt: number): boolean {
  return (status === 'pending' || status === 'confirmed') && Date.parse(startsAt) > loadedAt;
}

function readOnlyReason(status: AppointmentStatus): string {
  if (status === 'cancelled') {
    return 'This appointment is cancelled, so it can no longer be edited.';
  }
  if (status === 'attended' || status === 'no_show') {
    return 'This appointment is complete, so it can no longer be edited.';
  }
  return 'This appointment has started. Record the outcome from the dashboard.';
}

function valuesFrom(appointment: Appointment, timeZone: string): AppointmentFieldValues {
  return {
    staffMemberId: appointment.staffMember.id,
    service: appointment.service,
    startsAtLocal: utcToWallTime(appointment.startsAt, timeZone),
    duration: String(appointment.durationMinutes),
  };
}

/** Only what differs, so an unchanged inactive staff member or past start is not checked again. */
function changedFields(values: AppointmentFieldValues, appointment: Appointment, timeZone: string): UpdateAppointmentRequest {
  const body: UpdateAppointmentRequest = {};
  if (values.staffMemberId !== appointment.staffMember.id) {
    body.staffMemberId = values.staffMemberId;
  }
  const service = values.service.trim();
  if (service !== appointment.service) {
    body.service = service;
  }
  if (values.startsAtLocal !== utcToWallTime(appointment.startsAt, timeZone)) {
    body.startsAt = wallTimeToUtc(values.startsAtLocal, timeZone)!;
  }
  const durationMinutes = Number(values.duration);
  if (durationMinutes !== appointment.durationMinutes) {
    body.durationMinutes = durationMinutes;
  }
  return body;
}

function staffOptionsFor(staff: StaffMember[], { staffMember }: Appointment) {
  const options = staff.filter((entry) => entry.isActive).map(({ id, name }) => ({ id, name }));
  return options.some((option) => option.id === staffMember.id)
    ? options
    : [...options, { id: staffMember.id, name: `${staffMember.name} (inactive)` }];
}

function focusFirst(ids: string[]) {
  ids.map((id) => document.getElementById(id)).find((element) => element !== null)?.focus();
}

function ClientLine({ client }: { client: Appointment['client'] }) {
  return (
    <>
      <p className="chosen-client">
        {'Client: '}
        <Link id={clientLinkId} to={`/clients/${client.id}`}>
          {client.name}
        </Link>
        {client.phone && `, ${client.phone}`}
      </p>
      <p>The client cannot be changed. To book someone else, cancel this appointment and create a new one.</p>
    </>
  );
}

function ReadOnlyDetails({ appointment, timeZone }: { appointment: Appointment; timeZone: string }) {
  const { service, staffMember, startsAt, durationMinutes, status } = appointment;
  return (
    <section aria-label="Appointment details">
      <p>{readOnlyReason(status)}</p>
      <dl className="appointment-details">
        <dt>Service</dt>
        <dd>{service}</dd>
        <dt>Staff</dt>
        <dd>{staffMember.name}</dd>
        <dt>Date and time</dt>
        <dd>{`${formatDate(startsAt, timeZone)}, ${formatTime(startsAt, timeZone)}`}</dd>
        <dt>Duration</dt>
        <dd>{`${durationMinutes} min`}</dd>
      </dl>
    </section>
  );
}

function AppointmentEditor({ loaded, onNotFound }: { loaded: Loaded; onNotFound(): void }) {
  const api = useApi();
  const { signOut } = useAuth();
  const { timeZone } = loaded.settings;
  const [appointment, setAppointment] = useState(loaded.appointment);
  const [loadedAt, setLoadedAt] = useState(loaded.loadedAt);
  const [values, setValues] = useState(() => valuesFrom(loaded.appointment, timeZone));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [alert, setAlert] = useState('');
  const [notice, setNotice] = useState('');
  const [link, setLink] = useState<AppointmentWithLink | null>(null);
  const [runningAction, setRunningAction] = useState<Action | null>(null);
  /** One guard for Save and Regenerate, set before the request so a second one in the same task sees it before any render. */
  const isActionRunningRef = useRef(false);
  const linkPanelRef = useRef<HTMLDivElement>(null);
  const loadedValues = valuesFrom(appointment, timeZone);
  const isRunning = runningAction !== null;

  function show(next: Appointment) {
    setAppointment(next);
    setLoadedAt(Date.now());
    setValues(valuesFrom(next, timeZone));
    setErrors({});
  }

  function startAction(action: Action) {
    isActionRunningRef.current = true;
    setRunningAction(action);
    setErrors({});
    setFormError('');
    setAlert('');
    setNotice('');
  }

  function finishAction(update: () => void, focusIds: string[]) {
    isActionRunningRef.current = false;
    flushSync(() => {
      setRunningAction(null);
      update();
    });
    focusFirst(focusIds);
  }

  function handleFailure(error: unknown, failureAlert: string, focusIds: string[]) {
    if (isUnauthenticated(error)) {
      isActionRunningRef.current = false;
      void signOut();
    } else if (isNotFound(error)) {
      isActionRunningRef.current = false;
      onNotFound();
    } else {
      finishAction(() => setAlert(failureAlert), focusIds);
    }
  }

  /** The edits were based on an appointment that has changed, so the form is filled again from the server. */
  async function reloadAfterConflict(conflictAlert: string, failureAlert: string, focusIds: string[]) {
    try {
      const reloaded = await api.getAppointment(appointment.id);
      finishAction(() => {
        show(reloaded);
        setAlert(conflictAlert);
      }, focusIds);
    } catch (error) {
      handleFailure(error, failureAlert, focusIds);
    }
  }

  function change(update: Partial<AppointmentFieldValues>) {
    setValues((current) => ({ ...current, ...update }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isActionRunningRef.current) {
      return;
    }
    const nextErrors = validateFields(values, timeZone, loadedValues.startsAtLocal);
    setErrors(nextErrors);
    setFormError('');
    setAlert('');
    setNotice('');
    const firstError = editableFields.find((field) => nextErrors[field]);
    if (firstError) {
      document.getElementById(firstError)?.focus();
      return;
    }
    const body = changedFields(values, appointment, timeZone);
    if (Object.keys(body).length === 0) {
      setNotice('Nothing to change.');
      return;
    }
    startAction('save');
    const focusIds = [saveButtonId, clientLinkId];
    try {
      const updated = await api.updateAppointment(appointment.id, body);
      const sentences = ['Changes saved.'];
      if (body.startsAt !== undefined) {
        sentences.push("The client's link now shows the new time. Regenerate the link below to copy a message with the new time.");
      }
      if (appointment.status === 'confirmed' && updated.status === 'pending') {
        sentences.push('It is pending again until the client confirms.');
      }
      finishAction(() => {
        show(updated);
        setNotice(sentences.join(' '));
      }, focusIds);
    } catch (error) {
      if (error instanceof ApiError && error.status === 422 && isEditableField(error.field)) {
        const field = error.field;
        finishAction(() => setErrors({ [field]: error.message }), [field]);
      } else if (error instanceof ApiError && error.status === 422) {
        finishAction(() => setFormError(error.message), focusIds);
      } else if (isConflict(error)) {
        await reloadAfterConflict('This appointment had already changed. Nothing was saved.', saveFailedAlert, focusIds);
      } else {
        handleFailure(error, saveFailedAlert, focusIds);
      }
    }
  }

  async function regenerate() {
    if (isActionRunningRef.current) {
      return;
    }
    startAction('regenerate');
    const focusIds = [regenerateButtonId, clientLinkId];
    try {
      const regenerated = await api.regenerateAppointmentLink(appointment.id);
      isActionRunningRef.current = false;
      flushSync(() => {
        setRunningAction(null);
        setAppointment(regenerated.appointment);
        setLink(regenerated);
      });
      linkPanelRef.current?.querySelector('button')?.focus();
    } catch (error) {
      if (isConflict(error)) {
        await reloadAfterConflict('This appointment had already changed. No new link was made.', regenerateFailedAlert, focusIds);
      } else {
        handleFailure(error, regenerateFailedAlert, focusIds);
      }
    }
  }

  return (
    <>
      <ClientLine client={appointment.client} />
      <p>{`Status: ${statusText(appointment)}`}</p>
      {alert && <p role="alert">{alert}</p>}
      {notice && <p role="status">{notice}</p>}
      {isEditable(appointment, loadedAt) ? (
        <>
          <form className="appointment-form" onSubmit={save} noValidate>
            <AppointmentFields
              values={values}
              errors={errors}
              timeZone={timeZone}
              staffOptions={staffOptionsFor(loaded.staff, appointment)}
              onChange={change}
            />
            {appointment.status === 'confirmed' && values.startsAtLocal !== loadedValues.startsAtLocal && (
              <p>Saving a new time sets this appointment back to pending. The client will need to confirm again.</p>
            )}
            {formError && (
              <p role="alert" className="form-error">
                {formError}
              </p>
            )}
            <button id={saveButtonId} type="submit" disabled={isRunning}>
              {runningAction === 'save' ? 'Saving…' : 'Save changes'}
            </button>
          </form>
          <section aria-labelledby="confirmation-link-heading">
            <h2 id="confirmation-link-heading">Confirmation link</h2>
            <p>
              The link was shown when the appointment was created. If it was lost, get a new one. The old link stops
              working. Save changes first if you edited the appointment.
            </p>
            <button id={regenerateButtonId} type="button" onClick={regenerate} disabled={isRunning}>
              {runningAction === 'regenerate' ? 'Regenerating…' : 'Regenerate link'}
            </button>
            {link && (
              <div ref={linkPanelRef}>
                <ConfirmationLink key={link.confirmationLink} confirmationLink={link.confirmationLink} message={link.message} />
                <p>This link is shown only now.</p>
              </div>
            )}
          </section>
        </>
      ) : (
        <ReadOnlyDetails appointment={appointment} timeZone={timeZone} />
      )}
    </>
  );
}

/** Keyed by the id, so another appointment in the URL starts again from "Loading…". */
function EditAppointmentLoader({ id }: { id: string }) {
  const api = useApi();
  const { signOut } = useAuth();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const backLinkRef = useRef<HTMLAnchorElement>(null);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  useEffect(() => {
    let isCurrent = true;
    Promise.all([api.getAppointment(id), api.getSettings(), api.listStaff()]).then(
      ([appointment, settings, staff]) => {
        if (isCurrent) {
          setView({ kind: 'loaded', appointment, settings, staff, loadedAt: Date.now() });
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

  function showNotFound() {
    flushSync(() => setView({ kind: 'not-found' }));
    backLinkRef.current?.focus();
  }

  return (
    <>
      {view.kind === 'loading' && <p role="status">Loading…</p>}
      {view.kind === 'not-found' && (
        <>
          <p>This appointment does not exist.</p>
          <Link ref={backLinkRef} to="/">
            Back to dashboard
          </Link>
        </>
      )}
      {view.kind === 'error' && (
        <>
          <p role="alert">Could not load the appointment. Check your connection and try again.</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </>
      )}
      {view.kind === 'loaded' && <AppointmentEditor loaded={view} onNotFound={showNotFound} />}
    </>
  );
}

export function EditAppointmentPage() {
  const { id = '' } = useParams();
  return (
    <div className="edit-appointment">
      <h1>Edit appointment</h1>
      <EditAppointmentLoader key={id} id={id} />
    </div>
  );
}
