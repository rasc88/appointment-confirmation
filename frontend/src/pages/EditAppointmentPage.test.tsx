import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { buildDemoData, type DemoData } from '../api/demo-data';
import { createMockApi } from '../api/mock-api';
import type { Appointment, AppointmentWithLink } from '../api/types';
import { App } from '../App';

vi.mock('../api/demo-data', { spy: true });

const now = new Date('2026-11-10T10:07:00Z');

const networkError = new TypeError('Failed to fetch');

const unauthenticated = new ApiError(401, 'unauthenticated', 'Sign in to continue.');

const notFound = new ApiError(404, 'not_found', 'Not found.');

const conflictSaveAlert = 'This appointment had already changed. Nothing was saved.';
const conflictLinkAlert = 'This appointment had already changed. No new link was made.';
const saveFailedAlert = 'Could not save. Check your connection and try again.';
const linkFailedAlert = 'Could not make a new link. Check your connection and try again.';

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The store the mock was built from, so tests can find demo rows by token. */
async function createSignedInApi(options: { now?: Date } = { now }) {
  const api = createMockApi(options);
  const store = vi.mocked(buildDemoData).mock.results.at(-1)?.value as DemoData;
  await api.login({ email: 'alex@demo.test', password: 'demo1234' });
  const appointmentId = (token: string) => store.appointments.find((appointment) => appointment.token === token)!.id;
  const staffId = (name: string) => store.staff.find((staffMember) => staffMember.name === name)!.id;
  return { api, store, appointmentId, staffId };
}

function LocationProbe() {
  const location = useLocation();
  return <pre data-testid="location">{JSON.stringify([location.pathname, location.search, location.hash, location.state])}</pre>;
}

function renderPage(api: ApiService, path: string) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <ApiProvider api={api}>
          <App />
          <LocationProbe />
        </ApiProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

async function renderEdit(api: ApiService, id: string) {
  const view = renderPage(api, `/appointments/${id}/edit`);
  await screen.findByText(/^Status: /);
  return view;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function saveButton() {
  return screen.getByRole('button', { name: 'Save changes' });
}

function form() {
  return screen.getByLabelText('Service').closest('form')!;
}

function setStart(value: string) {
  fireEvent.change(screen.getByLabelText('Date and time'), { target: { value } });
}

async function setService(user: UserEvent, value: string) {
  await user.clear(screen.getByLabelText('Service'));
  if (value) {
    await user.type(screen.getByLabelText('Service'), value);
  }
}

async function setDuration(user: UserEvent, value: string) {
  await user.clear(screen.getByLabelText('Duration (minutes)'));
  if (value) {
    await user.type(screen.getByLabelText('Duration (minutes)'), value);
  }
}

function staffOptions() {
  return Array.from((screen.getByLabelText('Staff') as HTMLSelectElement).options, (option) => option.textContent);
}

function selectedStaff() {
  const select = screen.getByLabelText('Staff') as HTMLSelectElement;
  return select.options[select.selectedIndex].textContent;
}

function expectFieldError(label: string, message: string) {
  const field = screen.getByLabelText(label);
  expect(field).toHaveAttribute('aria-invalid', 'true');
  const describedBy = field.getAttribute('aria-describedby')!.split(' ');
  expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain(message);
}

/** Throws until the link is there, so `waitFor` keeps waiting for it. */
function editLink(id: string) {
  const link = document.querySelector<HTMLAnchorElement>(`a[href="/appointments/${id}/edit"]`);
  if (!link) {
    throw new Error(`No Edit link for ${id}`);
  }
  return link;
}

function clientLine() {
  return document.querySelector('.chosen-client');
}

function linkSection() {
  return screen.getByRole('region', { name: 'Confirmation link' });
}

describe('EditAppointmentPage loading', () => {
  it('shows the loading status until all three calls answer, with the id from the URL', async () => {
    const { api, appointmentId } = await createSignedInApi();
    const staff = await api.listStaff();
    const pending = deferred<typeof staff>();
    const getAppointment = vi.spyOn(api, 'getAppointment');
    const getSettings = vi.spyOn(api, 'getSettings');
    vi.spyOn(api, 'listStaff').mockReturnValue(pending.promise);
    renderPage(api, `/appointments/${appointmentId('demo-1')}/edit`);

    await waitFor(() => expect(getAppointment).toHaveBeenCalledWith(appointmentId('demo-1')));
    expect(getSettings).toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Edit appointment' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    pending.resolve(staff);

    expect(await screen.findByLabelText('Service')).toHaveValue('Haircut');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the not-found view for an unknown id', async () => {
    const { api } = await createSignedInApi();
    renderPage(api, '/appointments/unknown/edit');

    expect(await screen.findByText('This appointment does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
  });

  it.each(['getAppointment', 'getSettings', 'listStaff'] as const)('shows sign-in when %s returns 401', async (operation) => {
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, operation).mockRejectedValue(unauthenticated);
    renderPage(api, `/appointments/${appointmentId('demo-1')}/edit`);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it.each(['getAppointment', 'getSettings', 'listStaff'] as const)(
    'shows an alert when %s fails and loads again on Try again',
    async (operation) => {
      const user = userEvent.setup();
      const { api, appointmentId } = await createSignedInApi();
      vi.spyOn(api, operation).mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);
      renderPage(api, `/appointments/${appointmentId('demo-1')}/edit`);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Could not load the appointment. Check your connection and try again.',
      );
      await user.click(screen.getByRole('button', { name: 'Try again' }));

      expect(await screen.findByLabelText('Service')).toHaveValue('Haircut');
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );

  it('shows the client with a link to their page, and the status', async () => {
    const user = userEvent.setup();
    const { api, store, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    expect(clientLine()).toHaveTextContent(/^Client: Ana Torres, \+34 600 000 000$/);
    expect(screen.getByText('The client cannot be changed. To book someone else, cancel this appointment and create a new one.')).toBeInTheDocument();
    expect(screen.getByText('Status: Pending')).toBeInTheDocument();
    expect(screen.queryByLabelText(/client/i)).toBeNull();
    const anaId = store.clients.find((client) => client.name === 'Ana Torres')!.id;
    expect(screen.getByRole('link', { name: 'Ana Torres' })).toHaveAttribute('href', `/clients/${anaId}`);

    await user.click(screen.getByRole('link', { name: 'Ana Torres' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Torres' })).toBeInTheDocument();
    expect(screen.getByText('No-shows (all time): 0')).toBeInTheDocument();
  });

  it('shows no phone for a client without one, and the confirmed status text', async () => {
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-4'));

    expect(clientLine()).toHaveTextContent(/^Client: David Ruiz$/);
    expect(screen.getByText('Status: Confirmed by staff')).toBeInTheDocument();
  });

  it.each([
    ['demo-5', 'Status: Cancelled by client', 'This appointment is cancelled, so it can no longer be edited.', 'Manicure', '15:00', '45 min'],
    ['demo-8', 'Status: No-show', 'This appointment is complete, so it can no longer be edited.', 'Colour', '09:00', '60 min'],
    ['demo-9', 'Status: Pending', 'This appointment has started. Record the outcome from the dashboard.', 'Haircut', '10:00', '30 min'],
  ])('shows %s read-only', async (token, status, reason, service, time, duration) => {
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId(token));

    expect(screen.getByText(status)).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Appointment details' });
    expect(within(details).getByText(service)).toBeInTheDocument();
    expect(within(details).getByText(`Tuesday, 10 November 2026, ${time}`)).toBeInTheDocument();
    expect(within(details).getByText(duration)).toBeInTheDocument();
    expect(clientLine()).toBeInTheDocument();
    expect(screen.queryByLabelText('Service')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Regenerate link' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Confirmation link' })).toBeNull();
  });

  it('opens from the dashboard and from the client page, and shows the same appointment after a reload', async () => {
    const user = userEvent.setup();
    const { api, store, appointmentId } = await createSignedInApi();
    const id = appointmentId('demo-1');
    const { unmount } = renderPage(api, '/');
    await screen.findByRole('heading', { name: 'Dashboard' });

    await user.click(await waitFor(() => editLink(id)));
    expect(await screen.findByLabelText('Service')).toHaveValue('Haircut');
    expect(clientLine()).toHaveTextContent('Ana Torres');
    unmount();

    const anaId = store.clients.find((client) => client.name === 'Ana Torres')!.id;
    const second = renderPage(api, `/clients/${anaId}`);
    await screen.findByRole('heading', { level: 1, name: 'Ana Torres' });
    await user.click(await waitFor(() => editLink(id)));
    expect(await screen.findByLabelText('Date and time')).toHaveValue('2026-11-10T13:00');
    second.unmount();

    renderPage(api, `/appointments/${id}/edit`);
    expect(await screen.findByLabelText('Date and time')).toHaveValue('2026-11-10T13:00');
    expect(clientLine()).toHaveTextContent('Ana Torres');
  });
});

describe('EditAppointmentPage form', () => {
  it('prefills the same fields as the new appointment form', async () => {
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    expect(staffOptions()).toEqual(['Alex', 'Sam']);
    expect(selectedStaff()).toBe('Alex');
    expect(screen.getByLabelText('Service')).toHaveValue('Haircut');
    expect(screen.getByLabelText('Date and time')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Date and time')).toHaveValue('2026-11-10T13:00');
    expect(screen.getByText('Times in Europe/Madrid')).toBeInTheDocument();
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(30);
  });

  it('lists an inactive staff member of the appointment and keeps them on a save that does not change staff', async () => {
    const user = userEvent.setup();
    const { api, appointmentId, staffId } = await createSignedInApi();
    await api.updateStaffMember(staffId('Sam'), { isActive: false });
    const updateAppointment = vi.spyOn(api, 'updateAppointment');
    await renderEdit(api, appointmentId('demo-2'));

    expect(staffOptions()).toEqual(['Alex', 'Sam (inactive)']);
    expect(selectedStaff()).toBe('Sam (inactive)');

    await setService(user, 'Hot stone massage');
    await user.click(saveButton());

    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved.');
    expect(updateAppointment).toHaveBeenCalledWith(appointmentId('demo-2'), { service: 'Hot stone massage' });
    expect(selectedStaff()).toBe('Sam (inactive)');
  });

  it.each([
    ['an empty service', 'Service', 'Enter the service.'],
    ['an empty time', 'Date and time', 'Enter the date and time.'],
    ['a time the clocks skip', 'Date and time', 'That time does not exist in Europe/Madrid because the clocks change. Choose another time.'],
    ['a past time', 'Date and time', 'Choose a time in the future.'],
    ['a time equal to now', 'Date and time', 'Choose a time in the future.'],
    ['a duration of 4', 'Duration (minutes)', 'Enter a duration from 5 to 480 minutes.'],
    ['a duration of 481', 'Duration (minutes)', 'Enter a duration from 5 to 480 minutes.'],
    ['an empty duration', 'Duration (minutes)', 'Enter a duration from 5 to 480 minutes.'],
  ])('rejects %s on the client and sends nothing', async (name, label, message) => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    const updateAppointment = vi.spyOn(api, 'updateAppointment');
    await renderEdit(api, appointmentId('demo-1'));
    const changes: Record<string, () => Promise<void> | void> = {
      'an empty service': () => setService(user, '   '),
      'an empty time': () => setStart(''),
      'a time the clocks skip': () => setStart('2027-03-28T02:30'),
      'a past time': () => setStart('2026-11-10T09:00'),
      'a time equal to now': () => setStart('2026-11-10T11:07'),
      'a duration of 4': () => setDuration(user, '4'),
      'a duration of 481': () => setDuration(user, '481'),
      'an empty duration': () => setDuration(user, ''),
    };

    await changes[name]();
    await user.click(saveButton());

    expectFieldError(label, message);
    expect(screen.getByLabelText(label)).toHaveFocus();
    expect(updateAppointment).not.toHaveBeenCalled();
  });

  it('does not check an unchanged start time against now', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    const updateAppointment = vi.spyOn(api, 'updateAppointment');
    await renderEdit(api, appointmentId('demo-1'));
    vi.setSystemTime(new Date('2026-11-10T12:30:00Z'));

    await setService(user, 'Colour');
    await user.click(saveButton());

    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved.');
    expect(updateAppointment).toHaveBeenCalledWith(appointmentId('demo-1'), { service: 'Colour' });
  });

  it('warns that a new time sets a confirmed appointment back to pending, only while the time differs', async () => {
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-3'));
    const warning = 'Saving a new time sets this appointment back to pending. The client will need to confirm again.';
    expect(screen.queryByText(warning)).toBeNull();

    setStart('2026-11-10T16:00');
    expect(screen.getByText(warning)).toBeInTheDocument();

    setStart('2026-11-10T14:00');
    expect(screen.queryByText(warning)).toBeNull();
  });

  it('does not warn for a pending appointment', async () => {
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    setStart('2026-11-10T16:00');

    expect(screen.queryByText(/sets this appointment back to pending/)).toBeNull();
  });

  it('sends only the changed fields once, showing Saving… while it runs', async () => {
    const user = userEvent.setup();
    const { api, appointmentId, staffId } = await createSignedInApi();
    const pending = deferred<Appointment>();
    const original = api.updateAppointment.bind(api);
    const updateAppointment = vi.spyOn(api, 'updateAppointment').mockReturnValue(pending.promise);
    await renderEdit(api, appointmentId('demo-1'));

    fireEvent.change(screen.getByLabelText('Staff'), { target: { value: staffId('Sam') } });
    await setService(user, '  Colour  ');
    setStart('2026-11-10T18:00');
    await setDuration(user, '45');
    await user.click(saveButton());

    const button = screen.getByRole('button', { name: 'Saving…' });
    expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toBeDisabled();
    expect(updateAppointment).toHaveBeenCalledTimes(1);
    expect(updateAppointment).toHaveBeenCalledWith(appointmentId('demo-1'), {
      staffMemberId: staffId('Sam'),
      service: 'Colour',
      startsAt: '2026-11-10T17:00:00.000Z',
      durationMinutes: 45,
    });

    pending.resolve(await original(...updateAppointment.mock.calls[0]));

    expect(await screen.findByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it.each([
    ['nothing', () => undefined],
    ['only spaces around the service', (user: UserEvent) => setService(user, '  Haircut ')],
  ])('says Nothing to change and sends nothing when %s changed', async (_name, edit) => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    const updateAppointment = vi.spyOn(api, 'updateAppointment');
    await renderEdit(api, appointmentId('demo-1'));

    await edit(user);
    await user.click(saveButton());

    expect(screen.getByRole('status')).toHaveTextContent('Nothing to change.');
    expect(updateAppointment).not.toHaveBeenCalled();
  });

  it('sends one request for two submits in the same task', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    const updateAppointment = vi.spyOn(api, 'updateAppointment');
    await renderEdit(api, appointmentId('demo-1'));
    await setService(user, 'Colour');

    act(() => {
      fireEvent.submit(form());
      fireEvent.submit(form());
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved.');
    expect(updateAppointment).toHaveBeenCalledTimes(1);
  });

  it('does not start a regenerate while a save runs in the same task, nor a save while a regenerate runs', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    const updateAppointment = vi.spyOn(api, 'updateAppointment');
    const regenerateAppointmentLink = vi.spyOn(api, 'regenerateAppointmentLink');
    await renderEdit(api, appointmentId('demo-1'));
    await setService(user, 'Colour');

    act(() => {
      fireEvent.submit(form());
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate link' }));
    });
    expect(await screen.findByRole('status')).toHaveTextContent('Changes saved.');
    expect(updateAppointment).toHaveBeenCalledTimes(1);
    expect(regenerateAppointmentLink).not.toHaveBeenCalled();

    await setService(user, 'Manicure');
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate link' }));
      fireEvent.submit(form());
    });
    expect(await screen.findByText('This link is shown only now.')).toBeInTheDocument();
    expect(regenerateAppointmentLink).toHaveBeenCalledTimes(1);
    expect(updateAppointment).toHaveBeenCalledTimes(1);
  });

  it('shows the saved appointment, refills the form and explains a time change on a confirmed appointment', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-3'));
    expect(screen.getByText('Status: Confirmed by client')).toBeInTheDocument();

    setStart('2026-11-10T16:30');
    await user.click(saveButton());

    expect(await screen.findByRole('status')).toHaveTextContent(
      "Changes saved. The client's link now shows the new time. Regenerate the link below to copy a message with the new time. It is pending again until the client confirms.",
    );
    expect(screen.getByText('Status: Pending')).toBeInTheDocument();
    expect(screen.getByLabelText('Date and time')).toHaveValue('2026-11-10T16:30');
    expect(screen.queryByText(/sets this appointment back to pending/)).toBeNull();
    expect(saveButton()).toHaveFocus();
    await expect(api.getPublicAppointment('demo-3')).resolves.toMatchObject({ startsAt: '2026-11-10T15:30:00.000Z' });
  });

  it('says only Changes saved when the time did not change, and the time sentence alone for a pending appointment', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    await setDuration(user, '45');
    await user.click(saveButton());
    expect(await screen.findByRole('status')).toHaveTextContent(/^Changes saved\.$/);
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(45);

    setStart('2026-11-10T17:00');
    await user.click(saveButton());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /^Changes saved\. The client's link now shows the new time\. Regenerate the link below to copy a message with the new time\.$/,
      ),
    );
  });

  it('shows a server field error under its field and moves focus there', async () => {
    const user = userEvent.setup();
    const { api, appointmentId, staffId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));
    await api.updateStaffMember(staffId('Sam'), { isActive: false });

    fireEvent.change(screen.getByLabelText('Staff'), { target: { value: staffId('Sam') } });
    await user.click(saveButton());

    await waitFor(() => expectFieldError('Staff', 'Choose an active staff member.'));
    expect(screen.getByLabelText('Staff')).toHaveFocus();
    expect(selectedStaff()).toBe('Sam');
  });

  it.each(['service', 'startsAt', 'durationMinutes'] as const)('shows a server 422 on %s under that field', async (field) => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'updateAppointment').mockRejectedValue(new ApiError(422, 'validation_error', 'Server says no.', field));
    await renderEdit(api, appointmentId('demo-1'));

    await setService(user, 'Colour');
    await user.click(saveButton());

    await waitFor(() => expect(document.getElementById(field)).toHaveFocus());
    expect(document.getElementById(field)).toHaveAttribute('aria-describedby', expect.stringContaining(`${field}-error`));
    expect(document.getElementById(`${field}-error`)).toHaveTextContent('Server says no.');
  });

  it('shows any other 422 above the button and focuses Save changes', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'updateAppointment').mockRejectedValue(new ApiError(422, 'validation_error', 'Change at least one field.'));
    await renderEdit(api, appointmentId('demo-1'));

    await setService(user, 'Colour');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Change at least one field.');
    expect(within(form()).getByRole('alert')).toBeInTheDocument();
    expect(saveButton()).toHaveFocus();
  });

  it('reloads on 409 and shows the appointment read-only once it was cancelled', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));
    await api.cancelAppointment(appointmentId('demo-1'));

    await setService(user, 'Colour');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(conflictSaveAlert);
    expect(screen.getByText('This appointment is cancelled, so it can no longer be edited.')).toBeInTheDocument();
    expect(screen.getByText('Status: Cancelled by staff')).toBeInTheDocument();
    expect(screen.queryByLabelText('Service')).toBeNull();
    expect(screen.getByRole('link', { name: 'Ana Torres' })).toHaveFocus();
  });

  it('reloads on 409 and refills the form from the server when it is still editable', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'updateAppointment').mockRejectedValueOnce(
      new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.'),
    );
    await renderEdit(api, appointmentId('demo-1'));
    await api.confirmPublicAppointment('demo-1');

    await setService(user, 'Colour');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(conflictSaveAlert);
    expect(screen.getByText('Status: Confirmed by client')).toBeInTheDocument();
    expect(screen.getByLabelText('Service')).toHaveValue('Haircut');
    expect(saveButton()).toHaveFocus();
  });

  it.each([
    ['on save', () => notFound, () => undefined],
    ['on the reload after a 409', () => new ApiError(409, 'invalid_transition', 'x'), (api: ApiService) => vi.spyOn(api, 'getAppointment').mockRejectedValue(notFound)],
  ])('shows the not-found view on 404 %s and focuses Back to dashboard', async (_name, saveError, prepare) => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'updateAppointment').mockRejectedValue(saveError());
    await renderEdit(api, appointmentId('demo-1'));
    prepare(api);

    await setService(user, 'Colour');
    await user.click(saveButton());

    expect(await screen.findByText('This appointment does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveFocus();
  });

  it('signs out on 401', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'updateAppointment').mockRejectedValue(unauthenticated);
    await renderEdit(api, appointmentId('demo-1'));

    await setService(user, 'Colour');
    await user.click(saveButton());

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it.each([
    ['a network error', (api: ApiService) => vi.spyOn(api, 'updateAppointment').mockRejectedValue(networkError)],
    [
      'a failed reload after a 409',
      (api: ApiService) => {
        vi.spyOn(api, 'updateAppointment').mockRejectedValue(new ApiError(409, 'invalid_transition', 'x'));
        vi.spyOn(api, 'getAppointment').mockRejectedValue(networkError);
      },
    ],
  ])('keeps the typed values and shows an alert on %s', async (_name, prepare) => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));
    prepare(api);

    await setService(user, 'Colour');
    setStart('2026-11-10T18:00');
    await user.click(saveButton());

    expect(await screen.findByRole('alert')).toHaveTextContent(saveFailedAlert);
    expect(screen.getByLabelText('Service')).toHaveValue('Colour');
    expect(screen.getByLabelText('Date and time')).toHaveValue('2026-11-10T18:00');
    expect(saveButton()).toHaveFocus();
  });

  it('shows the new time on the dashboard after saving', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    setStart('2026-11-10T17:00');
    await user.click(saveButton());
    await screen.findByText(/^Changes saved\./);
    await user.click(screen.getByRole('link', { name: 'Dashboard' }));

    await screen.findByRole('heading', { name: 'Dashboard' });
    const item = (await waitFor(() => editLink(appointmentId('demo-1')))).closest('li');
    expect(item).toHaveTextContent(/^17:00/);
    expect(item).toHaveTextContent('Ana Torres');
  });
});

describe('EditAppointmentPage regenerate link', () => {
  it('explains regenerating below the form', async () => {
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    const section = linkSection();
    expect(within(section).getByRole('heading', { level: 2, name: 'Confirmation link' })).toBeInTheDocument();
    expect(
      within(section).getByText(
        'The link was shown when the appointment was created. If it was lost, get a new one. The old link stops working. Save changes first if you edited the appointment.',
      ),
    ).toBeInTheDocument();
    expect(form().compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows exactly the returned link and message in one tap, and focuses Copy link', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    const id = appointmentId('demo-1');
    const pending = deferred<AppointmentWithLink>();
    const original = api.regenerateAppointmentLink.bind(api);
    const regenerate = vi.spyOn(api, 'regenerateAppointmentLink').mockReturnValue(pending.promise);
    await renderEdit(api, id);
    await setService(user, 'Typed but not saved');

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    expect(screen.getByRole('button', { name: 'Regenerating…' })).toBeDisabled();
    expect(saveButton()).toBeDisabled();
    expect(regenerate).toHaveBeenCalledWith(id);
    const result = await original(id);
    pending.resolve(result);

    const section = linkSection();
    expect(await within(section).findByText(result.confirmationLink)).toBeInTheDocument();
    expect(within(section).getByText(result.message)).toBeInTheDocument();
    expect(result.message).toBe(`Please confirm your appointment: ${result.confirmationLink}`);
    expect(within(section).getByText('This link is shown only now.')).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy link' })).toHaveFocus();
    expect(within(section).getByRole('button', { name: 'Copy message' })).toBeInTheDocument();
    expect(screen.getByLabelText('Service')).toHaveValue('Typed but not saved');
    await expect(api.getPublicAppointment('demo-1')).rejects.toMatchObject({ status: 404 });
    expect(JSON.parse(screen.getByTestId('location').textContent!)).toEqual([`/appointments/${id}/edit`, '', '', null]);
  });

  it('keeps the link after a save, and replaces it on a second regenerate', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));
    const firstLink = (await within(linkSection()).findByText(/^http.*\/c\//)).textContent!;
    await setService(user, 'Colour');
    await user.click(saveButton());
    await screen.findByText(/^Changes saved\./);
    expect(within(linkSection()).getByText(firstLink)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    await waitFor(() => expect(within(linkSection()).queryByText(firstLink)).toBeNull());
    expect(within(linkSection()).getAllByText(/\/c\//)).toHaveLength(2);
  });

  it('sends one request for two clicks in the same task', async () => {
    const { api, appointmentId } = await createSignedInApi();
    const regenerate = vi.spyOn(api, 'regenerateAppointmentLink');
    await renderEdit(api, appointmentId('demo-1'));
    const button = screen.getByRole('button', { name: 'Regenerate link' });

    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });

    expect(await screen.findByText('This link is shown only now.')).toBeInTheDocument();
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it('reloads on 409 appointment_started and keeps the page editable while the browser says it has not started', async () => {
    const user = userEvent.setup();
    vi.setSystemTime(new Date('2026-11-10T08:30:00Z'));
    const { api, appointmentId } = await createSignedInApi({ now });
    const regenerate = vi.spyOn(api, 'regenerateAppointmentLink');
    await renderEdit(api, appointmentId('demo-9'));

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(conflictLinkAlert);
    await expect(regenerate.mock.results[0].value).rejects.toMatchObject({ status: 409, code: 'appointment_started' });
    expect(screen.queryByText('This link is shown only now.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toHaveFocus();
  });

  it('reloads on 409 invalid_transition and shows the appointment read-only', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));
    await api.cancelAppointment(appointmentId('demo-1'));

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(conflictLinkAlert);
    expect(screen.getByText('This appointment is cancelled, so it can no longer be edited.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Regenerate link' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Ana Torres' })).toHaveFocus();
  });

  it('shows the not-found view on 404 and focuses Back to dashboard', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'regenerateAppointmentLink').mockRejectedValue(notFound);
    await renderEdit(api, appointmentId('demo-1'));

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    expect(await screen.findByText('This appointment does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveFocus();
  });

  it('signs out on 401', async () => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    vi.spyOn(api, 'regenerateAppointmentLink').mockRejectedValue(unauthenticated);
    await renderEdit(api, appointmentId('demo-1'));

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it.each([
    ['a network error', (api: ApiService) => vi.spyOn(api, 'regenerateAppointmentLink').mockRejectedValue(networkError)],
    [
      'a failed reload after a 409',
      (api: ApiService) => {
        vi.spyOn(api, 'regenerateAppointmentLink').mockRejectedValue(new ApiError(409, 'appointment_started', 'x'));
        vi.spyOn(api, 'getAppointment').mockRejectedValue(networkError);
      },
    ],
  ])('shows an alert on %s and focuses Regenerate link', async (_name, prepare) => {
    const user = userEvent.setup();
    const { api, appointmentId } = await createSignedInApi();
    await renderEdit(api, appointmentId('demo-1'));
    prepare(api);

    await user.click(screen.getByRole('button', { name: 'Regenerate link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(linkFailedAlert);
    expect(screen.getByRole('button', { name: 'Regenerate link' })).toHaveFocus();
  });
});
