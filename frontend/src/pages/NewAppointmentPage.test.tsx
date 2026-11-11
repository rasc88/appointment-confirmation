import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { createMockApi } from '../api/mock-api';
import type { Client } from '../api/types';
import { App } from '../App';

const now = new Date('2026-11-10T10:07:00Z');

const networkError = new TypeError('Failed to fetch');

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

function LocationProbe() {
  const location = useLocation();
  return <pre data-testid="location">{JSON.stringify([location.pathname, location.search, location.hash, location.state])}</pre>;
}

function renderPage(api: ApiService, path = '/appointments/new') {
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

async function renderLoaded(api: ApiService) {
  const view = renderPage(api);
  await screen.findByLabelText('Service');
  return view;
}

async function search(user: UserEvent, text: string) {
  const box = screen.getByLabelText('Search clients');
  await user.clear(box);
  if (text) {
    await user.type(box, text);
  }
  await user.click(screen.getByRole('button', { name: 'Search' }));
}

async function chooseClient(user: UserEvent, name: string) {
  await search(user, name);
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${name}`) }));
}

async function fillAppointment(user: UserEvent, values: { service?: string; startsAt?: string; duration?: string }) {
  if (values.service !== undefined) {
    await user.type(screen.getByLabelText('Service'), values.service);
  }
  if (values.startsAt !== undefined) {
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: values.startsAt } });
  }
  if (values.duration !== undefined) {
    await user.clear(screen.getByLabelText('Duration (minutes)'));
    if (values.duration) {
      await user.type(screen.getByLabelText('Duration (minutes)'), values.duration);
    }
  }
}

async function fillValidAppointment(user: UserEvent) {
  await chooseClient(user, 'Ana Torres');
  await fillAppointment(user, { service: 'Haircut', startsAt: '2026-11-10T18:00', duration: '45' });
}

function submit(user: UserEvent) {
  return user.click(screen.getByRole('button', { name: 'Create appointment' }));
}

function staffOptions() {
  return Array.from((screen.getByLabelText('Staff') as HTMLSelectElement).options, (option) => option.textContent);
}

function selectedStaff() {
  const select = screen.getByLabelText('Staff') as HTMLSelectElement;
  return select.options[select.selectedIndex].textContent;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function stubClipboard(value: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
}

function expectFieldError(label: string, message: string) {
  const input = screen.getByLabelText(label);
  expect(input).toHaveAttribute('aria-invalid', 'true');
  const describedBy = input.getAttribute('aria-describedby')!.split(' ');
  const error = screen.getByText(message);
  expect(describedBy).toContain(error.id);
}

describe('NewAppointmentPage loading', () => {
  it('shows the loading status, then the form', async () => {
    const api = await createSignedInApi();
    const settings = await api.getSettings();
    const pending = deferred<typeof settings>();
    vi.spyOn(api, 'getSettings').mockReturnValue(pending.promise);
    renderPage(api);

    expect(await screen.findByRole('heading', { level: 1, name: 'New appointment' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    pending.resolve(settings);

    expect(await screen.findByLabelText('Service')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each(['getSettings', 'listStaff'] as const)('shows an alert when %s fails and loads again on Try again', async (operation) => {
    const api = await createSignedInApi();
    vi.spyOn(api, operation).mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);
    renderPage(api);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the form. Check your connection and try again.');
    expect(screen.queryByLabelText('Service')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByLabelText('Service')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows sign-in when loading returns 401', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'getSettings').mockRejectedValue(new ApiError(401, 'unauthenticated', 'Sign in to continue.'));
    renderPage(api);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('is reached from the dashboard header link', async () => {
    renderPage(await createSignedInApi(), '/');
    await screen.findByRole('heading', { name: 'Dashboard' });

    await userEvent.setup().click(screen.getByRole('link', { name: 'New appointment' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'New appointment' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Service')).toBeInTheDocument();
  });
});

describe('NewAppointmentPage client search', () => {
  it('searches with the trimmed text, or with no q when empty', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const searchClients = vi.spyOn(api, 'searchClients');
    await renderLoaded(api);

    expect(screen.getByLabelText('Search clients')).toHaveAttribute('maxLength', '80');
    await search(user, '  ana  ');
    expect(searchClients).toHaveBeenLastCalledWith('ana');
    await search(user, '   ');
    expect(searchClients).toHaveBeenLastCalledWith(undefined);
    await search(user, '');
    expect(searchClients).toHaveBeenLastCalledWith(undefined);
    expect(await screen.findByRole('button', { name: /^Hugo Blanc/ })).toBeInTheDocument();
  });

  it('searches on Enter without submitting the appointment', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    await renderLoaded(api);

    await user.type(screen.getByLabelText('Search clients'), 'ruiz{Enter}');

    expect(await screen.findByRole('button', { name: 'David Ruiz No phone' })).toBeInTheDocument();
    expect(createAppointment).not.toHaveBeenCalled();
    expect(screen.queryByText('Enter the service.')).toBeNull();
  });

  it('shows each result with its phone, chooses one, and brings the search back on Change client', async () => {
    const user = userEvent.setup();
    await renderLoaded(await createSignedInApi());

    await search(user, 'a');
    expect(await screen.findByRole('button', { name: 'Ana Torres +34 600 000 000' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'David Ruiz No phone' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Ana Torres +34 600 000 000' }));

    expect(screen.getByText('Client: Ana Torres, +34 600 000 000')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search clients')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Change client' }));
    expect(screen.getByLabelText('Search clients')).toBeInTheDocument();

    await chooseClient(user, 'David Ruiz');
    expect(screen.getByText('Client: David Ruiz')).toBeInTheDocument();
  });

  it('shows only the latest search', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const first = deferred<Client[]>();
    const original = api.searchClients.bind(api);
    vi.spyOn(api, 'searchClients').mockImplementationOnce(() => first.promise);
    await renderLoaded(api);

    await search(user, 'ana');
    await search(user, 'ben');
    expect(await screen.findByRole('button', { name: /^Ben Carter/ })).toBeInTheDocument();

    const anaResults = await original('ana');
    await act(async () => first.resolve(anaResults));

    expect(screen.getByRole('button', { name: /^Ben Carter/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ana Torres/ })).toBeNull();
  });

  it('says when nothing matches and when the list is capped at 20', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    for (let index = 0; index < 17; index += 1) {
      await api.createClient({ name: `Zed ${index}` });
    }
    await renderLoaded(api);

    await search(user, 'nobody');
    expect(await screen.findByText('No clients match. Create a new client instead.')).toBeInTheDocument();

    await search(user, '');
    expect(await screen.findByText('Showing the first 20 matches. Search for more of the name or phone.')).toBeInTheDocument();
    expect(within(document.querySelector('.client-results') as HTMLElement).getAllByRole('button')).toHaveLength(20);

    await search(user, 'zed');
    expect(await screen.findAllByRole('button', { name: /^Zed/ })).toHaveLength(17);
    expect(screen.queryByText(/Showing the first 20/)).toBeNull();
  });

  it('shows an alert when the search fails', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'searchClients').mockRejectedValue(networkError);
    await renderLoaded(api);

    await search(user, 'ana');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not search. Check your connection and try again.');
  });

  it('shows sign-in when the search returns 401', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'searchClients').mockRejectedValue(new ApiError(401, 'unauthenticated', 'Sign in to continue.'));
    await renderLoaded(api);

    await search(user, 'ana');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('NewAppointmentPage new client', () => {
  async function openNewClient(user: UserEvent) {
    await user.click(screen.getByRole('button', { name: 'New client' }));
  }

  it('checks the name and phone before sending', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createClient = vi.spyOn(api, 'createClient');
    await renderLoaded(api);
    await openNewClient(user);

    expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', '80');
    expect(screen.getByLabelText('Phone (optional)')).toHaveAttribute('maxLength', '30');
    await user.type(screen.getByLabelText('Name'), '   ');
    await user.type(screen.getByLabelText('Phone (optional)'), '600 abc');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    expectFieldError('Name', "Enter the client's name.");
    expectFieldError('Phone (optional)', 'Use only digits, spaces, +, ( ) and -.');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('creates the client with trimmed values, leaves out an empty phone, and chooses it', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createClient = vi.spyOn(api, 'createClient');
    await renderLoaded(api);
    await openNewClient(user);

    await user.type(screen.getByLabelText('Name'), '  Iris Moreau  ');
    await user.type(screen.getByLabelText('Phone (optional)'), '   ');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    expect(createClient).toHaveBeenCalledWith({ name: 'Iris Moreau' });
    expect(await screen.findByText('Client: Iris Moreau')).toBeInTheDocument();
  });

  it('sends a trimmed phone', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createClient = vi.spyOn(api, 'createClient');
    await renderLoaded(api);
    await openNewClient(user);

    await user.type(screen.getByLabelText('Name'), 'Iris Moreau');
    await user.type(screen.getByLabelText('Phone (optional)'), ' +33 (0) 6-12 ');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    expect(createClient).toHaveBeenCalledWith({ name: 'Iris Moreau', phone: '+33 (0) 6-12' });
    expect(await screen.findByText('Client: Iris Moreau, +33 (0) 6-12')).toBeInTheDocument();
  });

  it.each([
    ['name', 'Name'],
    ['phone', 'Phone (optional)'],
  ])('shows a 422 on %s under that field', async (field, label) => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createClient').mockRejectedValue(new ApiError(422, 'validation_error', 'Server says no.', field));
    await renderLoaded(api);
    await openNewClient(user);

    await user.type(screen.getByLabelText('Name'), 'Iris Moreau');
    await user.click(screen.getByRole('button', { name: 'Create client' }));

    expect(await screen.findByText('Server says no.')).toBeInTheDocument();
    expectFieldError(label, 'Server says no.');
    expect(screen.getByLabelText('Name')).toHaveValue('Iris Moreau');
  });
});

describe('NewAppointmentPage appointment form', () => {
  it('lists active staff only, defaults to the signed-in member, and prefills the duration', async () => {
    const api = await createSignedInApi();
    const staff = await api.listStaff();
    vi.spyOn(api, 'listStaff').mockResolvedValue([
      ...staff,
      { id: 'inactive', name: 'Old Kim', email: 'kim@demo.test', isActive: false, createdAt: now.toISOString() },
    ]);
    await renderLoaded(api);

    expect(staffOptions()).toEqual(['Alex', 'Sam']);
    expect(selectedStaff()).toBe('Alex');
    expect(screen.getByLabelText('Service')).toHaveAttribute('maxLength', '80');
    expect(screen.getByLabelText('Date and time')).toHaveAttribute('type', 'datetime-local');
    expect(screen.getByLabelText('Date and time')).toHaveValue('');
    expect(screen.getByText('Times in Europe/Madrid')).toBeInTheDocument();
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(30);
  });

  it('shows every field error at once and sends nothing', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    await renderLoaded(api);

    await fillAppointment(user, { service: '   ', duration: '' });
    await submit(user);

    expect(screen.getByText('Choose or create a client.')).toBeInTheDocument();
    expectFieldError('Search clients', 'Choose or create a client.');
    expectFieldError('Service', 'Enter the service.');
    expectFieldError('Date and time', 'Enter the date and time.');
    expectFieldError('Duration (minutes)', 'Enter a duration from 5 to 480 minutes.');
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it.each([
    ['2026-03-29T02:30', 'That time does not exist in Europe/Madrid because the clocks change. Choose another time.'],
    ['2026-11-10T11:07', 'Choose a time in the future.'],
    ['2026-11-10T09:00', 'Choose a time in the future.'],
  ])('rejects the start %s', async (startsAt, message) => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    await renderLoaded(api);
    await chooseClient(user, 'Ana Torres');

    await fillAppointment(user, { service: 'Haircut', startsAt });
    await submit(user);

    expectFieldError('Date and time', message);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it.each(['4', '481', '30.5'])('rejects the duration %s', async (duration) => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    await renderLoaded(api);
    await chooseClient(user, 'Ana Torres');

    await fillAppointment(user, { service: 'Haircut', startsAt: '2026-11-10T18:00', duration });
    await submit(user);

    expectFieldError('Duration (minutes)', 'Enter a duration from 5 to 480 minutes.');
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it('sends one request with the start time in UTC and shows Creating… while it runs', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const staff = await api.listStaff();
    const alex = staff.find((entry) => entry.name === 'Alex')!;
    const [ana] = await api.searchClients('Ana Torres');
    const pending = deferred<Awaited<ReturnType<ApiService['createAppointment']>>>();
    const original = api.createAppointment.bind(api);
    const createAppointment = vi.spyOn(api, 'createAppointment').mockReturnValue(pending.promise);
    await renderLoaded(api);
    await chooseClient(user, 'Ana Torres');
    await fillAppointment(user, { service: '  Haircut  ', startsAt: '2026-11-10T18:00', duration: '45' });

    await submit(user);

    const button = screen.getByRole('button', { name: 'Creating…' });
    expect(button).toBeDisabled();
    await user.click(button);
    expect(createAppointment).toHaveBeenCalledTimes(1);
    expect(createAppointment).toHaveBeenCalledWith({
      clientId: ana.id,
      staffMemberId: alex.id,
      service: 'Haircut',
      startsAt: '2026-11-10T17:00:00.000Z',
      durationMinutes: 45,
    });

    pending.resolve(await original(createAppointment.mock.calls[0][0]));
    expect(await screen.findByRole('heading', { name: 'Appointment created' })).toBeInTheDocument();
  });

  it('always sends the duration, even when left at the default', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    await renderLoaded(api);
    await chooseClient(user, 'Ana Torres');
    await fillAppointment(user, { service: 'Haircut', startsAt: '2026-11-10T18:00' });

    await submit(user);

    expect(createAppointment.mock.calls[0][0]).toMatchObject({ durationMinutes: 30 });
  });

  it.each([
    ['clientId', 'Search clients'],
    ['staffMemberId', 'Staff'],
    ['service', 'Service'],
    ['startsAt', 'Date and time'],
    ['durationMinutes', 'Duration (minutes)'],
  ])('shows a server 422 on %s under that field', async (field, label) => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createAppointment').mockRejectedValue(new ApiError(422, 'validation_error', 'Server says no.', field));
    await renderLoaded(api);
    await fillValidAppointment(user);

    await submit(user);

    expect(await screen.findByText('Server says no.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    if (field === 'clientId') {
      expect(document.querySelector('.client-section')).toHaveTextContent('Server says no.');
    } else {
      expectFieldError(label, 'Server says no.');
    }
  });

  it('shows any other 422 in an alert above the button', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createAppointment').mockRejectedValue(new ApiError(422, 'validation_error', 'Something else is wrong.', 'other'));
    await renderLoaded(api);
    await fillValidAppointment(user);

    await submit(user);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Something else is wrong.');
    expect(alert.nextElementSibling).toBe(screen.getByRole('button', { name: 'Create appointment' }));
  });

  it('shows sign-in when create returns 401', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createAppointment').mockRejectedValue(new ApiError(401, 'unauthenticated', 'Sign in to continue.'));
    await renderLoaded(api);
    await fillValidAppointment(user);

    await submit(user);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps every value on a network failure, and a new client is created only once', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createClient = vi.spyOn(api, 'createClient');
    const createAppointment = vi.spyOn(api, 'createAppointment').mockRejectedValueOnce(networkError);
    await renderLoaded(api);
    await user.click(screen.getByRole('button', { name: 'New client' }));
    await user.type(screen.getByLabelText('Name'), 'Iris Moreau');
    await user.click(screen.getByRole('button', { name: 'Create client' }));
    await screen.findByText('Client: Iris Moreau');
    fireEvent.change(screen.getByLabelText('Staff'), { target: { value: (await api.listStaff())[1].id } });
    await fillAppointment(user, { service: 'Haircut', startsAt: '2026-11-10T18:00', duration: '45' });

    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not create the appointment. Check your connection and try again.',
    );
    expect(screen.getByText('Client: Iris Moreau')).toBeInTheDocument();
    expect(selectedStaff()).toBe('Sam');
    expect(screen.getByLabelText('Service')).toHaveValue('Haircut');
    expect(screen.getByLabelText('Date and time')).toHaveValue('2026-11-10T18:00');
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(45);

    await submit(user);

    expect(await screen.findByRole('heading', { name: 'Appointment created' })).toBeInTheDocument();
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(createAppointment).toHaveBeenCalledTimes(2);
  });
});

describe('NewAppointmentPage after create', () => {
  async function createAna(api: ApiService) {
    const user = userEvent.setup();
    const { unmount } = await renderLoaded(api);
    await fillValidAppointment(user);
    await submit(user);
    await screen.findByRole('heading', { name: 'Appointment created' });
    return { user, unmount };
  }

  it('shows the appointment, its link and message, and the note', async () => {
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    await createAna(api);
    const { confirmationLink, message } = await createAppointment.mock.results[0].value;

    const panel = document.querySelector('.created-panel') as HTMLElement;
    expect(Array.from(panel.querySelectorAll('.created-details dd'), (entry) => entry.textContent)).toEqual([
      'Ana Torres',
      'Haircut',
      'Alex',
      'Tuesday, 10 November 2026, 18:00',
      '45 min',
    ]);
    expect(within(panel).getByText(confirmationLink)).toBeInTheDocument();
    expect(within(panel).getByText(message)).toBeInTheDocument();
    expect(message).toBe(`Please confirm your appointment: ${confirmationLink}`);
    expect(
      within(panel).getByText("This link is shown only now. If it is lost, regenerate it from the appointment's edit page."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Service')).toBeNull();
  });

  it('copies the link and the message', async () => {
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    const { user } = await createAna(api);
    const { confirmationLink, message } = await createAppointment.mock.results[0].value;
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenLastCalledWith(confirmationLink);
    expect(await screen.findByRole('status')).toHaveTextContent('Link copied.');

    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenLastCalledWith(message);
    expect(await screen.findByText('Message copied.')).toHaveAttribute('role', 'status');
  });

  it.each([
    ['writeText rejects', { writeText: vi.fn().mockRejectedValue(new Error('Denied')) }],
    ['the clipboard is missing', undefined],
  ])('shows the fallback alert when %s', async (_case, clipboard) => {
    const api = await createSignedInApi();
    const { user } = await createAna(api);
    stubClipboard(clipboard);

    await user.click(screen.getByRole('button', { name: 'Copy link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not copy. Select the text above and copy it yourself.');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the link out of the URL, router state and storage, and a reload shows an empty form', async () => {
    const api = await createSignedInApi();
    const createAppointment = vi.spyOn(api, 'createAppointment');
    const { unmount } = await createAna(api);
    const { confirmationLink } = await createAppointment.mock.results[0].value;
    const token = confirmationLink.split('/c/')[1];

    expect(screen.getByTestId('location')).toHaveTextContent(JSON.stringify(['/appointments/new', '', '', null]));
    for (const storage of [localStorage, sessionStorage]) {
      expect(JSON.stringify({ ...storage })).not.toContain(token);
    }

    unmount();
    renderPage(api);

    expect(await screen.findByLabelText('Service')).toHaveValue('');
    expect(screen.queryByText(confirmationLink)).toBeNull();
  });

  it('empties the form on Create another appointment', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    await renderLoaded(api);
    await fillValidAppointment(user);
    fireEvent.change(screen.getByLabelText('Staff'), { target: { value: (await api.listStaff())[1].id } });
    await submit(user);
    await screen.findByRole('heading', { name: 'Appointment created' });

    await user.click(screen.getByRole('button', { name: 'Create another appointment' }));

    expect(screen.getByLabelText('Search clients')).toBeInTheDocument();
    expect(screen.queryByText(/^Client: /)).toBeNull();
    expect(selectedStaff()).toBe('Alex');
    expect(screen.getByLabelText('Service')).toHaveValue('');
    expect(screen.getByLabelText('Date and time')).toHaveValue('');
    expect(screen.getByLabelText('Duration (minutes)')).toHaveValue(30);
  });

  it('shows the new appointment under Pending on the dashboard', async () => {
    const api = await createSignedInApi();
    const { user } = await createAna(api);

    await user.click(screen.getByRole('link', { name: 'Back to dashboard' }));

    await screen.findByRole('heading', { name: 'Dashboard' });
    const pending = Array.from(document.querySelectorAll('details')).find((details) =>
      details.querySelector('summary')?.textContent?.startsWith('Pending ('),
    )!;
    expect(
      await within(pending).findByText((_content, element) => element?.tagName === 'LI' && element.textContent?.includes('Ana Torres') === true),
    ).toHaveTextContent('18:0045 minAna TorresHaircutwith AlexPendingEdit');
  });
});
