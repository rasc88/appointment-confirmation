import { act, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { createMockApi } from '../api/mock-api';
import type { DayView } from '../api/types';
import { App } from '../App';

const now = new Date('2026-11-10T10:07:00Z');

const networkError = new TypeError('Failed to fetch');

beforeEach(() => {
  vi.useFakeTimers({ now });
});

afterEach(() => {
  vi.useRealTimers();
});

async function createSignedInApi() {
  const api = createMockApi({ now });
  await api.login({ email: 'alex@demo.test', password: 'demo1234' });
  return api;
}

/** Lets pending promises settle without moving the clock. */
async function flush() {
  await act(() => vi.advanceTimersByTimeAsync(0));
}

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

async function renderDashboard(api: ApiService, options?: { isStrict?: boolean }) {
  const app = (
    <MemoryRouter initialEntries={['/']}>
      <ApiProvider api={api}>
        <App />
      </ApiProvider>
    </MemoryRouter>
  );
  render(options?.isStrict ? <StrictMode>{app}</StrictMode> : app);
  await flush();
}

/** `fireEvent`, not `userEvent`: user-event's wrapper waits on a `setTimeout` that the fake timers never run. */
function chooseStaff(name: string) {
  const select = screen.getByLabelText('Staff') as HTMLSelectElement;
  const option = Array.from(select.options).find((entry) => entry.textContent === name)!;
  fireEvent.change(select, { target: { value: option.value } });
}

function groupElement(name: string) {
  const group = Array.from(document.querySelectorAll('details')).find((details) =>
    details.querySelector('summary')?.textContent?.startsWith(`${name} (`),
  );
  if (!group) {
    throw new Error(`No group ${name}`);
  }
  return group;
}

function summaries() {
  return Array.from(document.querySelectorAll('summary'), (summary) => summary.textContent);
}

function itemsIn(name: string) {
  return Array.from(groupElement(name).querySelectorAll('li'), (item) =>
    Array.from(item.children, (child) => child.textContent),
  );
}

function allItems() {
  return Array.from(document.querySelectorAll('li.appointment'));
}

function chooseDate(value: string) {
  fireEvent.change(screen.getByLabelText('Date'), { target: { value } });
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

describe('DashboardPage day view', () => {
  it('shows only the loading status before the first response', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'getDayView').mockReturnValue(new Promise(() => {}));

    await renderDashboard(api);

    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading appointments…');
    expect(document.querySelector('details')).toBeNull();
  });

  it('shows today in six groups with counts, in the business time zone', async () => {
    await renderDashboard(await createSignedInApi());

    expect(screen.getByText('Times in Europe/Madrid')).toBeInTheDocument();
    expect(
      screen.getByText('At risk 2, Pending 0, Confirmed 1, Cancelled 1, Needs outcome 1, Completed 2'),
    ).toBeInTheDocument();
    expect(summaries()).toEqual([
      'At risk (2)',
      'Pending (0)',
      'Confirmed (1)',
      'Cancelled (1)',
      'Needs outcome (1)',
      'Completed (2)',
    ]);
    for (const details of document.querySelectorAll('details')) {
      expect(details.open).toBe(true);
    }
    expect(itemsIn('At risk')).toEqual([
      ['13:00', '30 min', 'Ana Torres', 'Haircut', 'with Alex', 'Pending', 'No reply yet', 'Edit'],
      ['16:00', '45 min', 'Felix Novak', 'Manicure', 'with Alex', 'Pending', 'No reply yet', 'Missed 2 before', 'Edit'],
    ]);
    expect(groupElement('Pending')).toHaveTextContent('No appointments.');
    expect(itemsIn('Confirmed')).toEqual([
      ['14:00', '90 min', 'Chloe Martin', 'Colour', 'with Alex', 'Confirmed by client', 'Edit'],
    ]);
    expect(itemsIn('Cancelled')).toEqual([
      ['15:00', '45 min', 'Grace Lee', 'Manicure', 'with Alex', 'Cancelled by client', 'Late cancellation'],
    ]);
    expect(itemsIn('Needs outcome')).toEqual([['10:00', '30 min', 'Ben Carter', 'Haircut', 'with Alex', 'Pending']]);
    expect(itemsIn('Completed')).toEqual([
      ['08:00', '30 min', 'Grace Lee', 'Haircut', 'with Sam', 'Attended'],
      ['09:00', '60 min', 'Elena Sousa', 'Colour', 'with Alex', 'No-show'],
    ]);
    expect(screen.queryByText('No appointments on this day.')).not.toBeInTheDocument();
  });

  it('links the client name to the client page and Edit to the edit page', async () => {
    const api = await createSignedInApi();
    const { appointments } = await api.getDayView({});
    const ana = appointments.find((appointment) => appointment.client.name === 'Ana Torres')!;
    await renderDashboard(api);

    const anaItem = groupElement('At risk').querySelector('li')!;

    expect(anaItem.querySelector('a.appointment-client')).toHaveAttribute('href', `/clients/${ana.client.id}`);
    expect(Array.from(anaItem.querySelectorAll('a')).at(-1)).toHaveAttribute('href', `/appointments/${ana.id}/edit`);
    expect(screen.getAllByRole('link', { name: 'Edit' })).toHaveLength(3);
  });

  it('shows tomorrow after choosing 11 November', async () => {
    await renderDashboard(await createSignedInApi());

    chooseDate('2026-11-11');
    await flush();

    expect(summaries()).toEqual([
      'At risk (1)',
      'Pending (1)',
      'Confirmed (1)',
      'Cancelled (1)',
      'Needs outcome (0)',
      'Completed (0)',
    ]);
    expect(itemsIn('At risk')).toEqual([
      ['12:00', '30 min', 'Elena Sousa', 'Haircut', 'with Sam', 'Confirmed by client', 'Missed 1 before', 'Edit'],
    ]);
    expect(itemsIn('Pending')).toEqual([['13:00', '60 min', 'Ben Carter', 'Massage', 'with Sam', 'Pending', 'Edit']]);
    expect(itemsIn('Confirmed')).toEqual([
      ['14:00', '30 min', 'David Ruiz', 'Haircut', 'with Sam', 'Confirmed by staff', 'Edit'],
    ]);
    expect(itemsIn('Cancelled')).toEqual([['15:00', '60 min', 'Hugo Blanc', 'Massage', 'with Sam', 'Cancelled by staff']]);
  });

  it('shows 21 October in summer time', async () => {
    await renderDashboard(await createSignedInApi());

    chooseDate('2026-10-21');
    await flush();

    expect(itemsIn('Completed')).toEqual([['12:00', '60 min', 'Felix Novak', 'Massage', 'with Alex', 'No-show']]);
    expect(allItems()).toHaveLength(1);
  });

  it('shows the empty-day message and zero counts on a day with no appointments', async () => {
    await renderDashboard(await createSignedInApi());

    chooseDate('2026-11-12');
    await flush();

    expect(screen.getByText('No appointments on this day.')).toBeInTheDocument();
    expect(
      screen.getByText('At risk 0, Pending 0, Confirmed 0, Cancelled 0, Needs outcome 0, Completed 0'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('No appointments.')).toHaveLength(6);
  });

  it('shows no at-risk reasons on a started appointment even if the response carries some', async () => {
    const api = await createSignedInApi();
    const dayView = await api.getDayView({});
    const ben = dayView.appointments.find((appointment) => appointment.client.name === 'Ben Carter')!;
    ben.atRiskReasons = [{ code: 'no_reply' }];
    vi.spyOn(api, 'getDayView').mockResolvedValue(dayView);

    await renderDashboard(api);

    expect(itemsIn('Needs outcome')).toEqual([['10:00', '30 min', 'Ben Carter', 'Haircut', 'with Alex', 'Pending']]);
    expect(itemsIn('At risk')).toHaveLength(2);
  });
});

describe('DashboardPage filters', () => {
  it('shows the API date first, sends a chosen date, and drops it when the input is cleared', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);

    expect(getDayView).toHaveBeenLastCalledWith({});
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-10');

    chooseDate('2026-11-11');
    await flush();
    expect(getDayView).toHaveBeenLastCalledWith({ date: '2026-11-11' });
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-11');

    chooseDate('');
    await flush();
    expect(getDayView).toHaveBeenLastCalledWith({});
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-10');
  });

  it('lists All staff then the active staff, and filters by the chosen one', async () => {
    const api = await createSignedInApi();
    const staff = await api.listStaff();
    const sam = staff.find((staffMember) => staffMember.name === 'Sam')!;
    const alex = staff.find((staffMember) => staffMember.name === 'Alex')!;
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    const select = screen.getByLabelText('Staff');

    expect(Array.from((select as HTMLSelectElement).options, (option) => option.textContent)).toEqual([
      'All staff',
      'Alex',
      'Sam',
    ]);

    chooseStaff('Sam');
    await flush();
    expect(getDayView).toHaveBeenLastCalledWith({ staffId: sam.id });
    expect(allItems()).toHaveLength(1);
    expect(itemsIn('Completed')).toEqual([['08:00', '30 min', 'Grace Lee', 'Haircut', 'with Sam', 'Attended']]);

    chooseStaff('Alex');
    await flush();
    expect(getDayView).toHaveBeenLastCalledWith({ staffId: alex.id });
    expect(allItems()).toHaveLength(6);

    chooseStaff('All staff');
    await flush();
    expect(getDayView).toHaveBeenLastCalledWith({});
    expect(allItems()).toHaveLength(7);
  });

  it('leaves inactive staff out of the select', async () => {
    const api = await createSignedInApi();
    const staff = await api.listStaff();
    vi.spyOn(api, 'listStaff').mockResolvedValue(staff.map((staffMember) => ({ ...staffMember, isActive: staffMember.name !== 'Sam' })));

    await renderDashboard(api);

    const select = screen.getByLabelText('Staff') as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual(['All staff', 'Alex']);
  });

  it('offers only All staff when listStaff fails, and still loads the day', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'listStaff').mockRejectedValue(networkError);

    await renderDashboard(api);

    const select = screen.getByLabelText('Staff') as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual(['All staff']);
    expect(allItems()).toHaveLength(7);
  });

  it('combines date and staff, shows loading until the response, and ignores a late earlier response', async () => {
    const api = await createSignedInApi();
    const sam = (await api.listStaff()).find((staffMember) => staffMember.name === 'Sam')!;
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    const tomorrow = deferred<DayView>();
    const tomorrowForSam = deferred<DayView>();
    getDayView.mockReturnValueOnce(tomorrow.promise).mockReturnValueOnce(tomorrowForSam.promise);

    chooseDate('2026-11-11');
    await flush();
    expect(screen.getByRole('status')).toHaveTextContent('Loading appointments…');
    expect(document.querySelector('details')).toBeNull();

    chooseStaff('Sam');
    await flush();
    expect(getDayView).toHaveBeenLastCalledWith({ date: '2026-11-11', staffId: sam.id });

    tomorrowForSam.resolve(await api.getDayView({ date: '2026-11-11', staffId: sam.id }));
    await flush();
    tomorrow.resolve(await api.getDayView({ date: '2026-11-12' }));
    await flush();

    expect(screen.queryByText('Loading appointments…')).not.toBeInTheDocument();
    expect(allItems()).toHaveLength(4);
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-11');
  });

  it.each([
    ['a network failure', networkError],
    ['a 500', new ApiError(500, 'internal_error', 'Something went wrong.')],
  ])('shows the load error on %s and repeats the same request on Try again', async (_name, error) => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockRejectedValueOnce(error);

    chooseDate('2026-11-11');
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load appointments. Check your connection and try again.');
    expect(document.querySelector('details')).toBeNull();
    const callsBefore = getDayView.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();

    expect(getDayView.mock.calls.length).toBe(callsBefore + 1);
    expect(getDayView).toHaveBeenLastCalledWith({ date: '2026-11-11' });
    expect(allItems()).toHaveLength(4);
  });

  it('shows the load error on the first load too', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'getDayView').mockRejectedValueOnce(networkError);

    await renderDashboard(api);

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load appointments. Check your connection and try again.');
  });
});

describe('DashboardPage sign-out on 401', () => {
  const unauthenticated = new ApiError(401, 'unauthenticated', 'Sign in to continue.');

  it('signs out when getDayView returns 401 on load', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'getDayView').mockRejectedValue(unauthenticated);

    await renderDashboard(api);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs out when listStaff returns 401', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'listStaff').mockRejectedValue(unauthenticated);

    await renderDashboard(api);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs out when a refresh returns 401', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockRejectedValueOnce(unauthenticated);

    await advance(30_000);

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('DashboardPage refresh', () => {
  it('asks again 30 seconds after the previous call settled, without showing loading', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    expect(getDayView).toHaveBeenCalledTimes(1);

    await advance(29_900);
    expect(getDayView).toHaveBeenCalledTimes(1);

    getDayView.mockReturnValueOnce(new Promise(() => {}));
    await advance(100);
    expect(getDayView).toHaveBeenCalledTimes(2);
    expect(getDayView).toHaveBeenLastCalledWith({});
    expect(screen.queryByText('Loading appointments…')).not.toBeInTheDocument();
    expect(allItems()).toHaveLength(7);
  });

  it('shows a change made outside the page on the next refresh', async () => {
    const api = await createSignedInApi();
    await renderDashboard(api);

    await api.confirmPublicAppointment('demo-1');
    await advance(30_000);

    expect(itemsIn('At risk')).toEqual([
      ['16:00', '45 min', 'Felix Novak', 'Manicure', 'with Alex', 'Pending', 'No reply yet', 'Missed 2 before', 'Edit'],
    ]);
    expect(itemsIn('Confirmed')).toEqual([
      ['13:00', '30 min', 'Ana Torres', 'Haircut', 'with Alex', 'Confirmed by client', 'Edit'],
      ['14:00', '90 min', 'Chloe Martin', 'Colour', 'with Alex', 'Confirmed by client', 'Edit'],
    ]);
  });

  it('does not send another request while a refresh is pending', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockReturnValueOnce(new Promise(() => {}));

    await advance(30_000);
    await advance(60_000);

    expect(getDayView).toHaveBeenCalledTimes(2);
  });

  it('sends one request per tick under StrictMode', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api, { isStrict: true });
    const callsAfterMount = getDayView.mock.calls.length;

    await advance(30_000);
    expect(getDayView.mock.calls.length).toBe(callsAfterMount + 1);

    await advance(30_000);
    expect(getDayView.mock.calls.length).toBe(callsAfterMount + 2);
  });

  it('keeps a collapsed group collapsed and the filters chosen after a refresh', async () => {
    const api = await createSignedInApi();
    const sam = (await api.listStaff()).find((staffMember) => staffMember.name === 'Sam')!;
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    chooseDate('2026-11-11');
    await flush();
    chooseStaff('Sam');
    await flush();

    fireEvent.click(groupElement('Pending').querySelector('summary')!);
    expect(groupElement('Pending').open).toBe(false);

    await advance(30_000);

    expect(getDayView).toHaveBeenLastCalledWith({ date: '2026-11-11', staffId: sam.id });
    expect(groupElement('Pending').open).toBe(false);
    expect(groupElement('At risk').open).toBe(true);
    expect(screen.getByLabelText('Date')).toHaveValue('2026-11-11');
    expect(screen.getByLabelText('Staff')).toHaveValue(sam.id);
  });

  it('keeps the appointments on a failed refresh, and the next success removes the notice', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockRejectedValueOnce(networkError);

    await advance(30_000);

    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh. Trying again in 30 seconds.');
    expect(allItems()).toHaveLength(7);

    await advance(30_000);

    expect(screen.queryByText('Could not refresh. Trying again in 30 seconds.')).not.toBeInTheDocument();
    expect(getDayView).toHaveBeenCalledTimes(3);
  });

  it('stops refreshing after leaving the dashboard', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
    await flush();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await advance(60_000);

    expect(getDayView).toHaveBeenCalledTimes(1);
  });

  it('calls listStaff once per visit, not on every refresh', async () => {
    const api = await createSignedInApi();
    const listStaff = vi.spyOn(api, 'listStaff');
    await renderDashboard(api);

    await advance(90_000);

    expect(listStaff).toHaveBeenCalledTimes(1);
  });
});
