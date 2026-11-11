import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { buildDemoData, type DemoData } from '../api/demo-data';
import { createMockApi } from '../api/mock-api';
import type { ClientDetail } from '../api/types';
import { App } from '../App';

vi.mock('../api/demo-data', { spy: true });

const now = new Date('2026-11-10T10:07:00Z');

const networkError = new TypeError('Failed to fetch');

const unauthenticated = new ApiError(401, 'unauthenticated', 'Sign in to continue.');

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The store the mock was built from, so tests can find demo rows by token. */
async function createSignedInApi() {
  const api = createMockApi({ now });
  const store = vi.mocked(buildDemoData).mock.results.at(-1)?.value as DemoData;
  await api.login({ email: 'alex@demo.test', password: 'demo1234' });
  const clientId = (name: string) => store.clients.find((client) => client.name === name)!.id;
  const appointmentId = (token: string) => store.appointments.find((appointment) => appointment.token === token)!.id;
  return { api, clientId, appointmentId };
}

function GoTo({ path }: { path: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(path)}>
      Go to other client
    </button>
  );
}

function renderPage(api: ApiService, path: string, otherPath = '/') {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[path]}>
        <ApiProvider api={api}>
          <App />
          <GoTo path={otherPath} />
        </ApiProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function items() {
  return Array.from(document.querySelectorAll('.client-history li'), (item) =>
    Array.from(item.children, (child) => child.textContent),
  );
}

function itemFor(appointmentId: string) {
  return document.querySelector<HTMLElement>(`.client-history li a[href="/appointments/${appointmentId}/edit"]`)?.closest('li');
}

describe('ClientHistoryPage loading', () => {
  it('shows the loading status until both calls answer, with the id from the URL', async () => {
    const { api, clientId } = await createSignedInApi();
    const settings = await api.getSettings();
    const pending = deferred<typeof settings>();
    const getClient = vi.spyOn(api, 'getClient');
    vi.spyOn(api, 'getSettings').mockReturnValue(pending.promise);
    renderPage(api, `/clients/${clientId('Felix Novak')}`);

    await waitFor(() => expect(getClient).toHaveBeenCalledWith(clientId('Felix Novak')));
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    pending.resolve(settings);

    expect(await screen.findByRole('heading', { level: 1, name: 'Felix Novak' })).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the not-found view for an unknown id', async () => {
    const { api } = await createSignedInApi();
    renderPage(api, '/clients/unknown');

    expect(await screen.findByRole('heading', { level: 1, name: 'Client not found' })).toBeInTheDocument();
    expect(screen.getByText('This client does not exist.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute('href', '/');
  });

  it.each(['getClient', 'getSettings'] as const)('shows sign-in when %s returns 401', async (operation) => {
    const { api, clientId } = await createSignedInApi();
    vi.spyOn(api, operation).mockRejectedValue(unauthenticated);
    renderPage(api, `/clients/${clientId('Ana Torres')}`);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it.each(['getClient', 'getSettings'] as const)('shows an alert when %s fails and loads again on Try again', async (operation) => {
    const { api, clientId } = await createSignedInApi();
    vi.spyOn(api, operation).mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);
    renderPage(api, `/clients/${clientId('Ana Torres')}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the client. Check your connection and try again.');

    const settings = await api.getSettings();
    const pending = deferred<typeof settings>();
    vi.spyOn(api, 'getSettings').mockReturnValueOnce(pending.promise);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByRole('alert')).toBeNull();

    pending.resolve(settings);

    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Torres' })).toBeInTheDocument();
  });

  it('loads the other client when the id in the URL changes', async () => {
    const { api, clientId } = await createSignedInApi();
    renderPage(api, `/clients/${clientId('Ana Torres')}`, `/clients/${clientId('Felix Novak')}`);
    await screen.findByRole('heading', { level: 1, name: 'Ana Torres' });
    const client = await api.getClient(clientId('Felix Novak'));
    const pending = deferred<ClientDetail>();
    vi.spyOn(api, 'getClient').mockReturnValue(pending.promise);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Go to other client' }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.queryByRole('heading', { level: 1, name: 'Ana Torres' })).toBeNull();

    pending.resolve(client);

    expect(await screen.findByRole('heading', { level: 1, name: 'Felix Novak' })).toBeInTheDocument();
  });

  it('shows the same client when rendered again at the same URL', async () => {
    const { api, clientId } = await createSignedInApi();
    const path = `/clients/${clientId('Grace Lee')}`;
    const { unmount } = renderPage(api, path);
    await screen.findByRole('heading', { level: 1, name: 'Grace Lee' });

    unmount();
    renderPage(api, path);

    expect(await screen.findByRole('heading', { level: 1, name: 'Grace Lee' })).toBeInTheDocument();
  });
});

describe('ClientHistoryPage history', () => {
  it('shows the client, the all-time no-show count and every appointment newest first', async () => {
    const { api, clientId } = await createSignedInApi();
    renderPage(api, `/clients/${clientId('Felix Novak')}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Felix Novak' })).toBeInTheDocument();
    expect(screen.getByText('+34 600 000 050')).toBeInTheDocument();
    expect(screen.getByText('No-shows (all time): 2')).toBeInTheDocument();
    expect(screen.getByText('Times in Europe/Madrid')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Appointments' });
    expect(within(section).getAllByRole('listitem')).toHaveLength(3);
    expect(items()).toEqual([
      ['Tuesday, 10 November 2026, 16:00', '45 min', 'Manicure', 'with Alex', 'Pending', 'Edit'],
      ['Wednesday, 21 October 2026, 12:00', '60 min', 'Massage', 'with Alex', 'No-show'],
      ['Friday, 11 September 2026, 12:00', '60 min', 'Massage', 'with Sam', 'No-show'],
    ]);
  });

  it('shows the items in the order the API returns', async () => {
    const { api, clientId } = await createSignedInApi();
    const client = await api.getClient(clientId('Felix Novak'));
    vi.spyOn(api, 'getClient').mockResolvedValue({ ...client, appointments: [...client.appointments].reverse() });
    renderPage(api, `/clients/${clientId('Felix Novak')}`);
    await screen.findByRole('heading', { level: 1, name: 'Felix Novak' });

    expect(items().map((item) => item[0])).toEqual([
      'Friday, 11 September 2026, 12:00',
      'Wednesday, 21 October 2026, 12:00',
      'Tuesday, 10 November 2026, 16:00',
    ]);
  });

  it.each([
    ['Ana Torres', '+34 600 000 000', 'No-shows (all time): 0'],
    ['David Ruiz', 'No phone', 'No-shows (all time): 0'],
    ['Elena Sousa', '+34 600 000 040', 'No-shows (all time): 1'],
  ])('shows the phone and count of %s', async (name, phone, count) => {
    const { api, clientId } = await createSignedInApi();
    renderPage(api, `/clients/${clientId(name)}`);

    expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument();
    expect(screen.getByText(phone)).toBeInTheDocument();
    expect(screen.getByText(count)).toBeInTheDocument();
  });

  it.each([
    ['Grace Lee', [['Cancelled by client'], ['Attended']]],
    ['David Ruiz', [['Confirmed by staff', 'Edit']]],
    ['Ben Carter', [['Pending', 'Edit'], ['Pending']]],
    ['Hugo Blanc', [['Cancelled by staff']]],
    ['Chloe Martin', [['Confirmed by client', 'Edit']]],
  ])('shows the status of each appointment of %s in the dashboard words, and Edit only before the start', async (name, expected) => {
    const { api, clientId } = await createSignedInApi();
    renderPage(api, `/clients/${clientId(name)}`);
    await screen.findByRole('heading', { level: 1, name });

    expect(items().map((item) => item.slice(4))).toEqual(expected);
  });

  it('links Edit to the edit page of a pending or confirmed appointment that has not started', async () => {
    const { api, clientId, appointmentId } = await createSignedInApi();
    renderPage(api, `/clients/${clientId('Ben Carter')}`);
    await screen.findByRole('heading', { level: 1, name: 'Ben Carter' });

    expect(screen.getAllByRole('link', { name: 'Edit' })).toHaveLength(1);
    expect(itemFor(appointmentId('demo-2'))).toBeTruthy();
    expect(itemFor(appointmentId('demo-9'))).toBeFalsy();
  });

  it('shows the appointment of an inactive staff member with their name', async () => {
    const { api, clientId } = await createSignedInApi();
    const sam = (await api.listStaff()).find((staffMember) => staffMember.name === 'Sam')!;
    await api.updateStaffMember(sam.id, { isActive: false });
    renderPage(api, `/clients/${clientId('Ben Carter')}`);
    await screen.findByRole('heading', { level: 1, name: 'Ben Carter' });

    expect(items()[0]).toEqual(['Wednesday, 11 November 2026, 13:00', '60 min', 'Massage', 'with Sam', 'Pending', 'Edit']);
  });

  it('shows an empty history for a new client', async () => {
    const { api } = await createSignedInApi();
    const client = await api.createClient({ name: 'Iris Moreau' });
    renderPage(api, `/clients/${client.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Iris Moreau' })).toBeInTheDocument();
    expect(screen.getByText('No phone')).toBeInTheDocument();
    expect(screen.getByText('No appointments yet.')).toBeInTheDocument();
    expect(screen.getByText('No-shows (all time): 0')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('opens from the client name on the dashboard', async () => {
    const { api, appointmentId } = await createSignedInApi();
    renderPage(api, '/');
    await screen.findByRole('heading', { name: 'Dashboard' });

    await userEvent.setup().click(await screen.findByRole('link', { name: 'Ana Torres' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Ana Torres' })).toBeInTheDocument();
    expect(itemFor(appointmentId('demo-1'))).toBeTruthy();
    expect(items()).toEqual([['Tuesday, 10 November 2026, 13:00', '30 min', 'Haircut', 'with Alex', 'Pending', 'Edit']]);
  });

  it('logs nothing to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method));
    const { api, clientId } = await createSignedInApi();
    renderPage(api, `/clients/${clientId('Felix Novak')}`);
    await screen.findByRole('heading', { level: 1, name: 'Felix Novak' });

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
