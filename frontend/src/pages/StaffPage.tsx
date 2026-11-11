import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { StaffMember } from '../api/types';
import { useAuth } from '../auth/auth-context';
import { errorProps, FieldError } from '../field-error';

const emailPattern = /^[^\s@]+@[^\s@]+$/;

const staffFields = ['name', 'email', 'password'] as const;

type StaffField = (typeof staffFields)[number];

type FieldErrors = Partial<Record<StaffField, string>>;

type View = { kind: 'loading' } | { kind: 'loaded'; staff: StaffMember[] } | { kind: 'error' };

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isStaffField(field: string | undefined): field is StaffField {
  return staffFields.includes(field as StaffField);
}

interface StaffRowProps {
  member: StaffMember;
  isSelf: boolean;
  isPromptOpen: boolean;
  onOpenPrompt(): void;
  onClosePrompt(): void;
  onUpdate(isActive: boolean): Promise<void>;
}

function StaffRow({ member, isSelf, isPromptOpen, onOpenPrompt, onClosePrompt, onUpdate }: StaffRowProps) {
  const [isUpdating, setIsUpdating] = useState(false);
  const isUpdatingRef = useRef(false);
  const deactivateButtonRef = useRef<HTMLButtonElement>(null);
  const keepButtonRef = useRef<HTMLButtonElement>(null);

  async function update(isActive: boolean) {
    if (isUpdatingRef.current) {
      return;
    }
    isUpdatingRef.current = true;
    setIsUpdating(true);
    await onUpdate(isActive);
    isUpdatingRef.current = false;
    setIsUpdating(false);
  }

  function openPrompt() {
    flushSync(onOpenPrompt);
    keepButtonRef.current?.focus();
  }

  function keepActive() {
    flushSync(onClosePrompt);
    deactivateButtonRef.current?.focus();
  }

  return (
    <li className="staff-row">
      <div className="staff-details">
        <span className="staff-row-name">{isSelf ? `${member.name} (you)` : member.name}</span>
        <span>{member.email}</span>
        {!member.isActive && <span className="flag">Inactive</span>}
      </div>
      {!member.isActive && (
        <button type="button" className="secondary" disabled={isUpdating} onClick={() => update(true)}>
          {isUpdating ? 'Reactivating…' : 'Reactivate'}
        </button>
      )}
      {member.isActive && !isSelf && !isPromptOpen && (
        <button type="button" className="secondary" ref={deactivateButtonRef} onClick={openPrompt}>
          Deactivate
        </button>
      )}
      {member.isActive && !isSelf && isPromptOpen && (
        <div className="staff-prompt">
          <p>{`Deactivate ${member.name}? They are signed out and can no longer sign in.`}</p>
          <div className="button-row">
            <button type="button" className="secondary" ref={keepButtonRef} disabled={isUpdating} onClick={keepActive}>
              Keep active
            </button>
            <button type="button" disabled={isUpdating} onClick={() => update(false)}>
              {isUpdating ? 'Deactivating…' : 'Yes, deactivate'}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

interface StaffValues {
  name: string;
  email: string;
  password: string;
}

const emptyValues: StaffValues = { name: '', email: '', password: '' };

function validate(values: StaffValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.name.trim()) {
    errors.name = 'Enter the name.';
  }
  if (!emailPattern.test(values.email.trim())) {
    errors.email = 'Enter a valid email address.';
  }
  if ([...values.password].length < 8) {
    errors.password = 'Use at least 8 characters.';
  }
  return errors;
}

function AddStaffForm({ onAdded }: { onAdded(member: StaffMember): void }) {
  const api = useApi();
  const { signOut } = useAuth();
  const [values, setValues] = useState(emptyValues);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [status, setStatus] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const isAddingRef = useRef(false);

  function change(update: Partial<StaffValues>) {
    setValues((current) => ({ ...current, ...update }));
  }

  async function add() {
    try {
      const added = await api.createStaffMember({ name: values.name.trim(), email: values.email.trim(), password: values.password });
      onAdded(added);
      setValues(emptyValues);
      setStatus(`${added.name} added. Give them their email and initial password.`);
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'email_taken') {
        setErrors({ email: error.message });
      } else if (error instanceof ApiError && error.status === 422 && isStaffField(error.field)) {
        setErrors({ [error.field]: error.message });
      } else if (error instanceof ApiError && error.status === 422) {
        setFormError(error.message);
      } else {
        setFormError('Could not add the staff member. Check your connection and try again.');
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isAddingRef.current) {
      return;
    }
    const nextErrors = validate(values);
    setErrors(nextErrors);
    setFormError('');
    setStatus('');
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    isAddingRef.current = true;
    setIsAdding(true);
    await add();
    isAddingRef.current = false;
    setIsAdding(false);
  }

  return (
    <section className="add-staff" aria-labelledby="add-staff-heading">
      <h2 id="add-staff-heading">Add staff</h2>
      <form onSubmit={handleSubmit} noValidate>
        <div className="field">
          <label htmlFor="staff-name">Name</label>
          <input
            id="staff-name"
            maxLength={80}
            value={values.name}
            onChange={(event) => change({ name: event.target.value })}
            {...errorProps('staff-name', errors.name)}
          />
          <FieldError id="staff-name" error={errors.name} />
        </div>
        <div className="field">
          <label htmlFor="staff-email">Email</label>
          <input
            id="staff-email"
            type="email"
            maxLength={254}
            autoComplete="off"
            value={values.email}
            onChange={(event) => change({ email: event.target.value })}
            {...errorProps('staff-email', errors.email)}
          />
          <FieldError id="staff-email" error={errors.email} />
        </div>
        <div className="field">
          <label htmlFor="staff-password">Initial password</label>
          <input
            id="staff-password"
            type="password"
            maxLength={72}
            autoComplete="new-password"
            value={values.password}
            onChange={(event) => change({ password: event.target.value })}
            {...errorProps('staff-password', errors.password)}
          />
          <FieldError id="staff-password" error={errors.password} />
        </div>
        {formError && <p role="alert" className="form-error">{formError}</p>}
        {status && <p role="status">{status}</p>}
        <button type="submit" disabled={isAdding}>
          {isAdding ? 'Adding…' : 'Add staff member'}
        </button>
      </form>
    </section>
  );
}

function StaffList({ staff, onChange }: { staff: StaffMember[]; onChange(member: StaffMember): void }) {
  const api = useApi();
  const { staffMember, signOut } = useAuth();
  const [openPromptId, setOpenPromptId] = useState<string | null>(null);
  const [alert, setAlert] = useState('');
  const sortedStaff = [...staff].sort((first, second) => first.name.localeCompare(second.name));

  async function update(member: StaffMember, isActive: boolean) {
    setAlert('');
    try {
      onChange(await api.updateStaffMember(member.id, { isActive }));
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
      } else if (error instanceof ApiError && (error.status === 409 || error.status === 404)) {
        setAlert(error.message);
      } else {
        setAlert(`Could not update ${member.name}. Check your connection and try again.`);
      }
    }
    setOpenPromptId((current) => (current === member.id ? null : current));
  }

  return (
    <>
      {alert && <p role="alert" className="form-error">{alert}</p>}
      <ul className="staff-list">
        {sortedStaff.map((member) => (
          <StaffRow
            key={member.id}
            member={member}
            isSelf={member.id === staffMember?.id}
            isPromptOpen={openPromptId === member.id}
            onOpenPrompt={() => setOpenPromptId(member.id)}
            onClosePrompt={() => setOpenPromptId(null)}
            onUpdate={(isActive) => update(member, isActive)}
          />
        ))}
      </ul>
    </>
  );
}

export function StaffPage() {
  const api = useApi();
  const { signOut } = useAuth();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  useEffect(() => {
    let isCurrent = true;
    api.listStaff().then(
      (staff) => {
        if (isCurrent) {
          setView({ kind: 'loaded', staff });
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

  function replaceMember(updated: StaffMember) {
    setView((current) =>
      current.kind === 'loaded'
        ? { kind: 'loaded', staff: current.staff.map((member) => (member.id === updated.id ? updated : member)) }
        : current,
    );
  }

  function addMember(added: StaffMember) {
    setView((current) => (current.kind === 'loaded' ? { kind: 'loaded', staff: [...current.staff, added] } : current));
  }

  return (
    <div className="staff-page">
      <h1>Staff</h1>
      {view.kind === 'loading' && <p role="status">Loading…</p>}
      {view.kind === 'error' && (
        <>
          <p role="alert">Could not load the staff list. Check your connection and try again.</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </>
      )}
      {view.kind === 'loaded' && (
        <>
          <StaffList staff={view.staff} onChange={replaceMember} />
          <AddStaffForm onAdded={addMember} />
        </>
      )}
    </div>
  );
}
