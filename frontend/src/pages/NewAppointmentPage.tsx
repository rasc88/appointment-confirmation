import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { AppointmentWithLink, BusinessSettings, Client, StaffMember } from '../api/types';
import { useAuth } from '../auth/auth-context';
import { ConfirmationLink } from '../ConfirmationLink';
import { errorProps, FieldError } from '../field-error';
import { formatDate, formatTime, wallTimeToUtc } from '../format-date-time';

const maxSearchResults = 20;

const phonePattern = /^[0-9+() -]+$/;

const appointmentFields = ['clientId', 'staffMemberId', 'service', 'startsAt', 'durationMinutes'] as const;

type AppointmentField = (typeof appointmentFields)[number];

export type FieldErrors = Partial<Record<AppointmentField, string>>;

type View =
  | { kind: 'loading' }
  | { kind: 'loaded'; settings: BusinessSettings; activeStaff: StaffMember[] }
  | { kind: 'error' };

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function isAppointmentField(field: string | undefined): field is AppointmentField {
  return appointmentFields.includes(field as AppointmentField);
}

function ClientSearch({ error, onChoose }: { error: string | undefined; onChoose(client: Client): void }) {
  const api = useApi();
  const { signOut } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Client[] | null>(null);
  const [hasSearchFailed, setHasSearchFailed] = useState(false);
  const latestSearch = useRef(0);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const search = ++latestSearch.current;
    const trimmed = query.trim();
    try {
      const clients = await api.searchClients(trimmed || undefined);
      if (search === latestSearch.current) {
        setResults(clients);
        setHasSearchFailed(false);
      }
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
      } else if (search === latestSearch.current) {
        setResults(null);
        setHasSearchFailed(true);
      }
    }
  }

  return (
    <>
      <form role="search" className="inline-form" onSubmit={handleSearch} noValidate>
        <div className="field">
          <label htmlFor="client-search">Search clients</label>
          <input
            id="client-search"
            type="search"
            maxLength={80}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            {...errorProps('clientId', error)}
          />
        </div>
        <button type="submit">Search</button>
      </form>
      {hasSearchFailed && <p role="alert">Could not search. Check your connection and try again.</p>}
      {results?.length === 0 && <p>No clients match. Create a new client instead.</p>}
      {results && results.length > 0 && (
        <ul className="client-results">
          {results.map((client) => (
            <li key={client.id}>
              <button type="button" className="secondary" onClick={() => onChoose(client)}>
                <span className="client-result-name">{client.name}</span> <span>{client.phone ?? 'No phone'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {results?.length === maxSearchResults && <p>Showing the first 20 matches. Search for more of the name or phone.</p>}
    </>
  );
}

function NewClientForm({ onCreated }: { onCreated(client: Client): void }) {
  const api = useApi();
  const { signOut } = useAuth();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [nameError, setNameError] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    const nextNameError = trimmedName ? '' : "Enter the client's name.";
    const nextPhoneError = !trimmedPhone || phonePattern.test(trimmedPhone) ? '' : 'Use only digits, spaces, +, ( ) and -.';
    setNameError(nextNameError);
    setPhoneError(nextPhoneError);
    setFormError('');
    if (nextNameError || nextPhoneError || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      onCreated(await api.createClient(trimmedPhone ? { name: trimmedName, phone: trimmedPhone } : { name: trimmedName }));
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
      } else if (error instanceof ApiError && error.status === 422 && error.field === 'name') {
        setNameError(error.message);
      } else if (error instanceof ApiError && error.status === 422 && error.field === 'phone') {
        setPhoneError(error.message);
      } else {
        setFormError('Could not create the client. Check your connection and try again.');
      }
      setIsSubmitting(false);
    }
  }

  return (
    <form className="new-client" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="client-name">Name</label>
        <input
          id="client-name"
          maxLength={80}
          value={name}
          onChange={(event) => setName(event.target.value)}
          {...errorProps('client-name', nameError)}
        />
        <FieldError id="client-name" error={nameError} />
      </div>
      <div className="field">
        <label htmlFor="client-phone">Phone (optional)</label>
        <input
          id="client-phone"
          type="tel"
          maxLength={30}
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          {...errorProps('client-phone', phoneError)}
        />
        <FieldError id="client-phone" error={phoneError} />
      </div>
      {formError && <p role="alert">{formError}</p>}
      <button type="submit" disabled={isSubmitting}>
        Create client
      </button>
    </form>
  );
}

function ClientSection({ client, error, onChange }: { client: Client | null; error: string | undefined; onChange(client: Client | null): void }) {
  const [isCreatingClient, setIsCreatingClient] = useState(false);

  return (
    <section className="client-section" aria-labelledby="client-heading">
      <h2 id="client-heading">Client</h2>
      {client ? (
        <div className="button-row">
          <p className="chosen-client">{client.phone ? `Client: ${client.name}, ${client.phone}` : `Client: ${client.name}`}</p>
          <button type="button" className="secondary" onClick={() => onChange(null)}>
            Change client
          </button>
        </div>
      ) : (
        <>
          <ClientSearch error={error} onChoose={onChange} />
          {isCreatingClient ? (
            <NewClientForm onCreated={onChange} />
          ) : (
            <button type="button" className="secondary" onClick={() => setIsCreatingClient(true)}>
              New client
            </button>
          )}
        </>
      )}
      <FieldError id="clientId" error={error} />
    </section>
  );
}

export interface AppointmentFieldValues {
  staffMemberId: string;
  service: string;
  startsAtLocal: string;
  duration: string;
}

interface AppointmentValues extends AppointmentFieldValues {
  client: Client | null;
}

/** A start time equal to `unchangedStartsAtLocal` is not checked against now, so an edit can keep a past start. */
export function validateFields(values: AppointmentFieldValues, timeZone: string, unchangedStartsAtLocal?: string): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.service.trim()) {
    errors.service = 'Enter the service.';
  }
  const startsAt = wallTimeToUtc(values.startsAtLocal, timeZone);
  if (!values.startsAtLocal) {
    errors.startsAt = 'Enter the date and time.';
  } else if (!startsAt) {
    errors.startsAt = `That time does not exist in ${timeZone} because the clocks change. Choose another time.`;
  } else if (values.startsAtLocal !== unchangedStartsAtLocal && Date.parse(startsAt) <= Date.now()) {
    errors.startsAt = 'Choose a time in the future.';
  }
  const duration = Number(values.duration);
  if (!values.duration || !Number.isInteger(duration) || duration < 5 || duration > 480) {
    errors.durationMinutes = 'Enter a duration from 5 to 480 minutes.';
  }
  return errors;
}

function validate(values: AppointmentValues, timeZone: string): FieldErrors {
  const errors = validateFields(values, timeZone);
  if (!values.client) {
    errors.clientId = 'Choose or create a client.';
  }
  return errors;
}

export function AppointmentFields({
  values,
  errors,
  timeZone,
  staffOptions,
  onChange,
}: {
  values: AppointmentFieldValues;
  errors: FieldErrors;
  timeZone: string;
  staffOptions: { id: string; name: string }[];
  onChange(update: Partial<AppointmentFieldValues>): void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="staffMemberId">Staff</label>
        <select
          id="staffMemberId"
          value={values.staffMemberId}
          onChange={(event) => onChange({ staffMemberId: event.target.value })}
          {...errorProps('staffMemberId', errors.staffMemberId)}
        >
          {staffOptions.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <FieldError id="staffMemberId" error={errors.staffMemberId} />
      </div>
      <div className="field">
        <label htmlFor="service">Service</label>
        <input
          id="service"
          maxLength={80}
          value={values.service}
          onChange={(event) => onChange({ service: event.target.value })}
          {...errorProps('service', errors.service)}
        />
        <FieldError id="service" error={errors.service} />
      </div>
      <div className="field">
        <label htmlFor="startsAt">Date and time</label>
        <input
          id="startsAt"
          type="datetime-local"
          value={values.startsAtLocal}
          onChange={(event) => onChange({ startsAtLocal: event.target.value })}
          aria-invalid={errors.startsAt ? true : undefined}
          aria-describedby={errors.startsAt ? 'startsAt-hint startsAt-error' : 'startsAt-hint'}
        />
        <p id="startsAt-hint" className="field-hint">{`Times in ${timeZone}`}</p>
        <FieldError id="startsAt" error={errors.startsAt} />
      </div>
      <div className="field">
        <label htmlFor="durationMinutes">Duration (minutes)</label>
        <input
          id="durationMinutes"
          type="number"
          min={5}
          max={480}
          step={1}
          value={values.duration}
          onChange={(event) => onChange({ duration: event.target.value })}
          {...errorProps('durationMinutes', errors.durationMinutes)}
        />
        <FieldError id="durationMinutes" error={errors.durationMinutes} />
      </div>
    </>
  );
}

function AppointmentForm({
  settings,
  activeStaff,
  onCreated,
}: {
  settings: BusinessSettings;
  activeStaff: StaffMember[];
  onCreated(created: AppointmentWithLink): void;
}) {
  const api = useApi();
  const { staffMember, signOut } = useAuth();
  const [values, setValues] = useState<AppointmentValues>({
    client: null,
    staffMemberId: staffMember?.id ?? '',
    service: '',
    startsAtLocal: '',
    duration: String(settings.defaultDurationMinutes),
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** Set before the request, so a second submit in the same task sees it before any render. */
  const isSubmittingRef = useRef(false);
  const { timeZone } = settings;

  function change(update: Partial<AppointmentValues>) {
    setValues((current) => ({ ...current, ...update }));
  }

  function changeClient(client: Client | null) {
    change({ client });
    setErrors((current) => ({ ...current, clientId: undefined }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmittingRef.current) {
      return;
    }
    const nextErrors = validate(values, timeZone);
    setErrors(nextErrors);
    setFormError('');
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    isSubmittingRef.current = true;
    setIsSubmitting(true);
    try {
      onCreated(
        await api.createAppointment({
          clientId: values.client!.id,
          staffMemberId: values.staffMemberId,
          service: values.service.trim(),
          startsAt: wallTimeToUtc(values.startsAtLocal, timeZone)!,
          durationMinutes: Number(values.duration),
        }),
      );
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
      } else if (error instanceof ApiError && error.status === 422 && isAppointmentField(error.field)) {
        setErrors({ [error.field]: error.message });
      } else if (error instanceof ApiError && error.status === 422) {
        setFormError(error.message);
      } else {
        setFormError('Could not create the appointment. Check your connection and try again.');
      }
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <ClientSection client={values.client} error={errors.clientId} onChange={changeClient} />
      <form className="appointment-form" onSubmit={handleSubmit} noValidate>
        <AppointmentFields values={values} errors={errors} timeZone={timeZone} staffOptions={activeStaff} onChange={change} />
        {formError && <p role="alert" className="form-error">{formError}</p>}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create appointment'}
        </button>
      </form>
    </>
  );
}

function CreatedPanel({
  created,
  timeZone,
  onCreateAnother,
}: {
  created: AppointmentWithLink;
  timeZone: string;
  onCreateAnother(): void;
}) {
  const { client, service, staffMember, startsAt, durationMinutes } = created.appointment;
  return (
    <section className="created-panel" aria-labelledby="created-heading">
      <h2 id="created-heading">Appointment created</h2>
      <dl className="created-details">
        <dt>Client</dt>
        <dd>
          <Link to={`/clients/${client.id}`}>{client.name}</Link>
        </dd>
        <dt>Service</dt>
        <dd>{service}</dd>
        <dt>Staff</dt>
        <dd>{staffMember.name}</dd>
        <dt>Date and time</dt>
        <dd>{`${formatDate(startsAt, timeZone)}, ${formatTime(startsAt, timeZone)}`}</dd>
        <dt>Duration</dt>
        <dd>{`${durationMinutes} min`}</dd>
      </dl>
      <ConfirmationLink confirmationLink={created.confirmationLink} message={created.message} />
      <p>This link is shown only now. If it is lost, regenerate it from the appointment's edit page.</p>
      <div className="button-row">
        <button type="button" onClick={onCreateAnother}>
          Create another appointment
        </button>
        <Link to="/">Back to dashboard</Link>
      </div>
    </section>
  );
}

export function NewAppointmentPage() {
  const api = useApi();
  const { signOut } = useAuth();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [created, setCreated] = useState<AppointmentWithLink | null>(null);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  useEffect(() => {
    let isCurrent = true;
    Promise.all([api.getSettings(), api.listStaff()]).then(
      ([settings, staff]) => {
        if (isCurrent) {
          setView({ kind: 'loaded', settings, activeStaff: staff.filter((entry) => entry.isActive) });
        }
      },
      (error: unknown) => {
        if (!isCurrent) {
          return;
        }
        if (isUnauthenticated(error)) {
          handleUnauthenticated();
        } else {
          setView({ kind: 'error' });
        }
      },
    );
    return () => {
      isCurrent = false;
    };
  }, [api, loadAttempt]);

  function reload() {
    setView({ kind: 'loading' });
    setLoadAttempt((attempt) => attempt + 1);
  }

  return (
    <div className="new-appointment">
      <h1>New appointment</h1>
      {view.kind === 'loading' && <p role="status">Loading…</p>}
      {view.kind === 'error' && (
        <>
          <p role="alert">Could not load the form. Check your connection and try again.</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </>
      )}
      {view.kind === 'loaded' &&
        (created ? (
          <CreatedPanel created={created} timeZone={view.settings.timeZone} onCreateAnother={() => setCreated(null)} />
        ) : (
          <AppointmentForm settings={view.settings} activeStaff={view.activeStaff} onCreated={setCreated} />
        ))}
    </div>
  );
}
