import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { createMockApi } from '../api/mock-api';
import type { BusinessSettings } from '../api/types';
import { App } from '../App';

const now = new Date('2026-11-10T10:07:00Z');

const networkError = new TypeError('Failed to fetch');

const unauthenticated = new ApiError(401, 'unauthenticated', 'Sign in to continue.');

const templateHint =
  'Must include {link}. You can use {client}, {business}, {service}, {staff}, {date}, {time} and {link}. Up to 500 characters.';

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createSignedInApi() {
  const api = createMockApi({ now });
  await api.login({ email: 'alex@demo.test', password: 'demo1234' });
  return api;
}

function renderPage(api: ApiService, path = '/settings') {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <ApiProvider api={api}>
          <App />
        </ApiProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

async function renderLoaded(api: ApiService) {
  const view = renderPage(api);
  await screen.findByLabelText('Business name');
  return view;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function replace(user: UserEvent, label: string, text: string) {
  await user.clear(screen.getByLabelText(label));
  if (text) {
    await user.type(screen.getByLabelText(label), text);
  }
}

function save(user: UserEvent) {
  return user.click(screen.getByRole('button', { name: 'Save' }));
}

function expectFieldError(label: string, message: string) {
  const control = screen.getByLabelText(label);
  expect(control).toHaveAttribute('aria-invalid', 'true');
  expect(control.getAttribute('aria-describedby')!.split(' ')).toContain(screen.getByText(message).id);
}

describe('SettingsPage loading', () => {
  it('shows the loading status, then the form', async () => {
    const api = await createSignedInApi();
    const settings = await api.getSettings();
    const pending = deferred<BusinessSettings>();
    vi.spyOn(api, 'getSettings').mockReturnValue(pending.promise);
    renderPage(api);

    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    await act(async () => pending.resolve(settings));

    expect(screen.getByLabelText('Business name')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows an alert when loading fails and loads again on Try again', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'getSettings').mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);
    renderPage(api);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the settings. Check your connection and try again.');
    expect(screen.queryByLabelText('Business name')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Business name')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows sign-in when loading returns 401', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'getSettings').mockRejectedValue(unauthenticated);
    renderPage(api);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('is reached from the header link', async () => {
    renderPage(await createSignedInApi(), '/');
    await screen.findByRole('heading', { name: 'Dashboard' });

    await userEvent.setup().click(screen.getByRole('link', { name: 'Settings' }));

    expect(await screen.findByLabelText('Business name')).toHaveValue('Demo Studio');
  });
});

describe('SettingsPage form', () => {
  it('prefills every setting with the contract limits and hints', async () => {
    await renderLoaded(await createSignedInApi());

    expect(screen.getByLabelText('Business name')).toHaveAttribute('id', 'businessName');
    expect(screen.getByLabelText('Business name')).toHaveAttribute('maxLength', '80');
    expect(screen.getByLabelText('Business name')).toHaveValue('Demo Studio');
    expect(screen.getByLabelText('Time zone')).toHaveAttribute('id', 'timeZone');
    expect(screen.getByLabelText('Time zone')).toHaveValue('Europe/Madrid');
    for (const [label, id, min, max, value] of [
      ['No reply window (hours)', 'noReplyWindowHours', 1, 168, 24],
      ['No-shows before flagging', 'noShowThreshold', 1, 10, 1],
      ['No-show lookback (days)', 'noShowLookbackDays', 7, 730, 180],
      ['Late cancellation window (hours)', 'lateCancellationHours', 0, 168, 12],
      ['Default duration (minutes)', 'defaultDurationMinutes', 5, 480, 30],
    ] as const) {
      const input = screen.getByLabelText(label);
      expect(input).toHaveAttribute('id', id);
      expect(input).toHaveAttribute('type', 'number');
      expect(input).toHaveAttribute('step', '1');
      expect(input).toHaveAttribute('min', String(min));
      expect(input).toHaveAttribute('max', String(max));
      expect(input).toHaveValue(value);
    }
    const template = screen.getByLabelText('Message template');
    expect(template.tagName).toBe('TEXTAREA');
    expect(template).toHaveAttribute('id', 'messageTemplate');
    expect(template).not.toHaveAttribute('maxLength');
    expect(template).toHaveValue(
      'Hi {client}, this is {business}. Please confirm your {service} appointment on {date} at {time}: {link}',
    );
    expect(template).toHaveAccessibleDescription(templateHint);
    expect(screen.getByLabelText('Time zone')).toHaveAccessibleDescription(
      'Changing the time zone does not move appointments. The same times show in the new zone.',
    );
    expect(screen.getByLabelText('Late cancellation window (hours)')).toHaveAccessibleDescription(
      '0 turns the late cancellation flag off.',
    );
    expect(screen.getAllByRole('button', { name: 'Save' })).toHaveLength(1);
  });

  it('lists every supported time zone and UTC, sorted', async () => {
    await renderLoaded(await createSignedInApi());

    const options = Array.from((screen.getByLabelText('Time zone') as HTMLSelectElement).options, (option) => option.value);

    expect(options).toEqual([...Intl.supportedValuesOf('timeZone'), 'UTC'].sort());
  });

  it('adds a current time zone that is not in the list, selected', async () => {
    const api = await createSignedInApi();
    const settings = await api.getSettings();
    vi.spyOn(api, 'getSettings').mockResolvedValue({ ...settings, timeZone: 'US/Eastern' });
    await renderLoaded(api);

    const select = screen.getByLabelText('Time zone') as HTMLSelectElement;
    const options = Array.from(select.options, (option) => option.value);
    expect(select).toHaveValue('US/Eastern');
    expect(options).toContain('US/Eastern');
    expect(options).toEqual([...options].sort());
  });

  it('shows every browser check at once and sends nothing', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateSettings = vi.spyOn(api, 'updateSettings');
    await renderLoaded(api);

    await replace(user, 'Business name', '   ');
    await replace(user, 'No reply window (hours)', '');
    await replace(user, 'No-shows before flagging', '0');
    await replace(user, 'No-show lookback (days)', '731');
    await replace(user, 'Late cancellation window (hours)', '1.5');
    await replace(user, 'Default duration (minutes)', '4');
    await user.clear(screen.getByLabelText('Message template'));
    await save(user);

    expectFieldError('Business name', 'Enter the business name.');
    expectFieldError('No reply window (hours)', 'Enter a whole number from 1 to 168.');
    expectFieldError('No-shows before flagging', 'Enter a whole number from 1 to 10.');
    expectFieldError('No-show lookback (days)', 'Enter a whole number from 7 to 730.');
    expectFieldError('Late cancellation window (hours)', 'Enter a whole number from 0 to 168.');
    expectFieldError('Default duration (minutes)', 'Enter a whole number from 5 to 480.');
    expectFieldError('Message template', 'Enter the message template.');
    expect(screen.getByLabelText('Message template').getAttribute('aria-describedby')!.split(' ')).toContain('messageTemplate-hint');
    expect(screen.getByLabelText('Late cancellation window (hours)').getAttribute('aria-describedby')!.split(' ')).toContain(
      'lateCancellationHours-hint',
    );
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('accepts each number at its limits', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateSettings = vi.spyOn(api, 'updateSettings');
    await renderLoaded(api);

    await replace(user, 'No reply window (hours)', '168');
    await replace(user, 'No-shows before flagging', '10');
    await replace(user, 'No-show lookback (days)', '7');
    await replace(user, 'Late cancellation window (hours)', '0');
    await replace(user, 'Default duration (minutes)', '480');
    await save(user);

    expect(updateSettings).toHaveBeenCalledWith({
      noReplyWindowHours: 168,
      noShowThreshold: 10,
      noShowLookbackDays: 7,
      lateCancellationHours: 0,
      defaultDurationMinutes: 480,
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved.');
  });

  it('sends only the changed field', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateSettings = vi.spyOn(api, 'updateSettings');
    await renderLoaded(api);

    await replace(user, 'No reply window (hours)', '48');
    await save(user);

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ noReplyWindowHours: 48 });
  });

  it('trims the name, sends the template exactly as typed, and the time zone chosen', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateSettings = vi.spyOn(api, 'updateSettings');
    await renderLoaded(api);

    await replace(user, 'Business name', '  New Studio  ');
    await user.selectOptions(screen.getByLabelText('Time zone'), 'UTC');
    fireEvent.change(screen.getByLabelText('Message template'), { target: { value: '  Hi {client}: {link}  ' } });
    await save(user);

    expect(updateSettings).toHaveBeenCalledWith({ businessName: 'New Studio', timeZone: 'UTC', messageTemplate: '  Hi {client}: {link}  ' });
  });

  it('sends nothing when nothing changed, including a name that differs only by spaces', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateSettings = vi.spyOn(api, 'updateSettings');
    await renderLoaded(api);

    await save(user);
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save.');

    await replace(user, 'Business name', ' Demo Studio ');
    await replace(user, 'No reply window (hours)', '24');
    await save(user);

    expect(screen.getByRole('status')).toHaveTextContent('No changes to save.');
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('shows Saving… while it runs and sends one request for two submits', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const original = api.updateSettings.bind(api);
    const pending = deferred<void>();
    const updateSettings = vi.spyOn(api, 'updateSettings').mockImplementation(async (body) => {
      await pending.promise;
      return original(body);
    });
    await renderLoaded(api);

    await replace(user, 'No reply window (hours)', '48');
    const form = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Saving…' }));
    await act(async () => pending.resolve());

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('shows the saved settings as the new baseline, and the message goes away on a change', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateSettings = vi.spyOn(api, 'updateSettings');
    await renderLoaded(api);

    await replace(user, 'Business name', '  New Studio ');
    await save(user);

    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved.');
    expect(screen.getByLabelText('Business name')).toHaveValue('New Studio');
    await expect(api.getSettings()).resolves.toMatchObject({ businessName: 'New Studio' });

    await save(user);
    expect(screen.getByRole('status')).toHaveTextContent('No changes to save.');
    expect(updateSettings).toHaveBeenCalledTimes(1);

    await replace(user, 'No reply window (hours)', '48');
    expect(screen.queryByRole('status')).toBeNull();
    await save(user);
    expect(updateSettings).toHaveBeenLastCalledWith({ noReplyWindowHours: 48 });
  });

  it('shows the mock 422 on the template under the field', async () => {
    const user = userEvent.setup();
    await renderLoaded(await createSignedInApi());

    fireEvent.change(screen.getByLabelText('Message template'), { target: { value: 'Hi {client}' } });
    await save(user);

    expect(await screen.findByText('Must contain {link}.')).toBeInTheDocument();
    expectFieldError('Message template', 'Must contain {link}.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a 422 on the time zone under the field', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'updateSettings').mockRejectedValue(
      new ApiError(422, 'validation_error', 'Must be an IANA time zone, for example Europe/Madrid.', 'timeZone'),
    );
    await renderLoaded(api);

    await user.selectOptions(screen.getByLabelText('Time zone'), 'UTC');
    await save(user);

    expect(await screen.findByText('Must be an IANA time zone, for example Europe/Madrid.')).toBeInTheDocument();
    expectFieldError('Time zone', 'Must be an IANA time zone, for example Europe/Madrid.');
    expect(screen.getByLabelText('Time zone').getAttribute('aria-describedby')!.split(' ')).toContain('timeZone-hint');
  });

  it('shows any other 422 in an alert above the button', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'updateSettings').mockRejectedValue(new ApiError(422, 'validation_error', 'Change at least one setting.'));
    await renderLoaded(api);

    await replace(user, 'No reply window (hours)', '48');
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Change at least one setting.');
  });

  it('shows sign-in when saving returns 401', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'updateSettings').mockRejectedValue(unauthenticated);
    await renderLoaded(api);

    await replace(user, 'No reply window (hours)', '48');
    await save(user);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps every value on a network failure', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'updateSettings').mockRejectedValue(networkError);
    await renderLoaded(api);

    await replace(user, 'Business name', 'New Studio');
    await replace(user, 'No reply window (hours)', '48');
    await save(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the settings. Check your connection and try again.');
    expect(screen.getByLabelText('Business name')).toHaveValue('New Studio');
    expect(screen.getByLabelText('No reply window (hours)')).toHaveValue(48);
  });
});

describe('SettingsPage reaching other pages', () => {
  it('shows the new time zone on the dashboard', async () => {
    const user = userEvent.setup();
    await renderLoaded(await createSignedInApi());

    await user.selectOptions(screen.getByLabelText('Time zone'), 'America/New_York');
    await save(user);
    await screen.findByText('Settings saved.');
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));

    expect(await screen.findByText('Times in America/New_York')).toBeInTheDocument();
  });

  it('prefills the new default duration on New appointment', async () => {
    const user = userEvent.setup();
    await renderLoaded(await createSignedInApi());

    await replace(user, 'Default duration (minutes)', '45');
    await save(user);
    await screen.findByText('Settings saved.');
    await user.click(screen.getByRole('link', { name: 'New appointment' }));

    expect(await screen.findByLabelText('Duration (minutes)')).toHaveValue(45);
  });
});
