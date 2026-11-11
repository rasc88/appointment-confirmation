import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/api-error';
import { useApi } from '../api/api-context';
import type { BusinessSettings, UpdateSettingsRequest } from '../api/types';
import { useAuth } from '../auth/auth-context';
import { errorProps, FieldError } from '../field-error';

const numberFields = [
  { id: 'noReplyWindowHours', label: 'No reply window (hours)', min: 1, max: 168 },
  { id: 'noShowThreshold', label: 'No-shows before flagging', min: 1, max: 10 },
  { id: 'noShowLookbackDays', label: 'No-show lookback (days)', min: 7, max: 730 },
  { id: 'lateCancellationHours', label: 'Late cancellation window (hours)', min: 0, max: 168, hint: '0 turns the late cancellation flag off.' },
  { id: 'defaultDurationMinutes', label: 'Default duration (minutes)', min: 5, max: 480 },
] as const;

const templateHint =
  'Must include {link}. You can use {client}, {business}, {service}, {staff}, {date}, {time} and {link}. Up to 500 characters.';

type NumberField = (typeof numberFields)[number]['id'];

const settingFields = ['businessName', 'timeZone', ...numberFields.map((field) => field.id), 'messageTemplate'] as const;

type SettingField = 'businessName' | 'timeZone' | NumberField | 'messageTemplate';

type SettingValues = Record<SettingField, string>;

type FieldErrors = Partial<Record<SettingField, string>>;

type View = { kind: 'loading' } | { kind: 'loaded'; settings: BusinessSettings } | { kind: 'error' };

/** `UTC` is not in `Intl.supportedValuesOf('timeZone')` in Node 24 or Chrome. */
const timeZones = [...new Set([...Intl.supportedValuesOf('timeZone'), 'UTC'])].sort();

function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function isSettingField(field: string | undefined): field is SettingField {
  return settingFields.includes(field as SettingField);
}

function hintedErrorProps(id: string, error: string | undefined) {
  return {
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-hint ${id}-error` : `${id}-hint`,
  };
}

function toValues(settings: BusinessSettings): SettingValues {
  const values = { businessName: settings.businessName, timeZone: settings.timeZone, messageTemplate: settings.messageTemplate };
  return { ...values, ...Object.fromEntries(numberFields.map(({ id }) => [id, String(settings[id])])) } as SettingValues;
}

function validate(values: SettingValues): FieldErrors {
  const errors: FieldErrors = {};
  if (!values.businessName.trim()) {
    errors.businessName = 'Enter the business name.';
  }
  for (const { id, min, max } of numberFields) {
    const number = Number(values[id]);
    if (!values[id].trim() || !Number.isInteger(number) || number < min || number > max) {
      errors[id] = `Enter a whole number from ${min} to ${max}.`;
    }
  }
  if (!values.messageTemplate) {
    errors.messageTemplate = 'Enter the message template.';
  }
  return errors;
}

function changedSettings(values: SettingValues, baseline: BusinessSettings): UpdateSettingsRequest {
  const changes: UpdateSettingsRequest = {};
  const businessName = values.businessName.trim();
  if (businessName !== baseline.businessName) {
    changes.businessName = businessName;
  }
  if (values.timeZone !== baseline.timeZone) {
    changes.timeZone = values.timeZone;
  }
  for (const { id } of numberFields) {
    if (Number(values[id]) !== baseline[id]) {
      changes[id] = Number(values[id]);
    }
  }
  if (values.messageTemplate !== baseline.messageTemplate) {
    changes.messageTemplate = values.messageTemplate;
  }
  return changes;
}

function SettingsForm({ settings }: { settings: BusinessSettings }) {
  const api = useApi();
  const { signOut } = useAuth();
  const [baseline, setBaseline] = useState(settings);
  const [values, setValues] = useState(() => toValues(settings));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState('');
  const [status, setStatus] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const isSavingRef = useRef(false);
  const timeZoneOptions = timeZones.includes(baseline.timeZone) ? timeZones : [...timeZones, baseline.timeZone].sort();

  function change(field: SettingField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setStatus('');
  }

  async function save(body: UpdateSettingsRequest) {
    try {
      const saved = await api.updateSettings(body);
      setBaseline(saved);
      setValues(toValues(saved));
      setStatus('Settings saved.');
    } catch (error) {
      if (isUnauthenticated(error)) {
        void signOut();
      } else if (error instanceof ApiError && error.status === 422 && isSettingField(error.field)) {
        setErrors({ [error.field]: error.message });
      } else if (error instanceof ApiError && error.status === 422) {
        setFormError(error.message);
      } else {
        setFormError('Could not save the settings. Check your connection and try again.');
      }
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSavingRef.current) {
      return;
    }
    const nextErrors = validate(values);
    setErrors(nextErrors);
    setFormError('');
    setStatus('');
    if (Object.keys(nextErrors).length > 0) {
      return;
    }
    const body = changedSettings(values, baseline);
    if (Object.keys(body).length === 0) {
      setStatus('No changes to save.');
      return;
    }
    isSavingRef.current = true;
    setIsSaving(true);
    await save(body);
    isSavingRef.current = false;
    setIsSaving(false);
  }

  return (
    <form className="settings-form" onSubmit={handleSubmit} noValidate>
      <div className="field">
        <label htmlFor="businessName">Business name</label>
        <input
          id="businessName"
          maxLength={80}
          value={values.businessName}
          onChange={(event) => change('businessName', event.target.value)}
          {...errorProps('businessName', errors.businessName)}
        />
        <FieldError id="businessName" error={errors.businessName} />
      </div>
      <div className="field">
        <label htmlFor="timeZone">Time zone</label>
        <select
          id="timeZone"
          value={values.timeZone}
          onChange={(event) => change('timeZone', event.target.value)}
          {...hintedErrorProps('timeZone', errors.timeZone)}
        >
          {timeZoneOptions.map((timeZone) => (
            <option key={timeZone} value={timeZone}>
              {timeZone}
            </option>
          ))}
        </select>
        <p id="timeZone-hint" className="field-hint">
          Changing the time zone does not move appointments. The same times show in the new zone.
        </p>
        <FieldError id="timeZone" error={errors.timeZone} />
      </div>
      {numberFields.map((field) => (
        <div className="field" key={field.id}>
          <label htmlFor={field.id}>{field.label}</label>
          <input
            id={field.id}
            type="number"
            min={field.min}
            max={field.max}
            step={1}
            value={values[field.id]}
            onChange={(event) => change(field.id, event.target.value)}
            {...('hint' in field ? hintedErrorProps(field.id, errors[field.id]) : errorProps(field.id, errors[field.id]))}
          />
          {'hint' in field && (
            <p id={`${field.id}-hint`} className="field-hint">
              {field.hint}
            </p>
          )}
          <FieldError id={field.id} error={errors[field.id]} />
        </div>
      ))}
      <div className="field">
        <label htmlFor="messageTemplate">Message template</label>
        <textarea
          id="messageTemplate"
          rows={4}
          value={values.messageTemplate}
          onChange={(event) => change('messageTemplate', event.target.value)}
          {...hintedErrorProps('messageTemplate', errors.messageTemplate)}
        />
        <p id="messageTemplate-hint" className="field-hint">
          {templateHint}
        </p>
        <FieldError id="messageTemplate" error={errors.messageTemplate} />
      </div>
      {formError && <p role="alert" className="form-error">{formError}</p>}
      {status && <p role="status">{status}</p>}
      <button type="submit" disabled={isSaving}>
        {isSaving ? 'Saving…' : 'Save'}
      </button>
    </form>
  );
}

export function SettingsPage() {
  const api = useApi();
  const { signOut } = useAuth();
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const handleUnauthenticated = useEffectEvent(() => {
    void signOut();
  });

  useEffect(() => {
    let isCurrent = true;
    api.getSettings().then(
      (settings) => {
        if (isCurrent) {
          setView({ kind: 'loaded', settings });
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
    <div className="settings-page">
      <h1>Settings</h1>
      {view.kind === 'loading' && <p role="status">Loading…</p>}
      {view.kind === 'error' && (
        <>
          <p role="alert">Could not load the settings. Check your connection and try again.</p>
          <button type="button" onClick={reload}>
            Try again
          </button>
        </>
      )}
      {view.kind === 'loaded' && <SettingsForm settings={view.settings} />}
    </div>
  );
}
