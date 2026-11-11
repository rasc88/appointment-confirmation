import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { createMockApi } from '../api/mock-api';
import type { Appointment, DayView } from '../api/types';
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

    const bar = document.querySelector('.dashboard-bar') as HTMLElement;
    expect(within(bar).getByLabelText('Date')).toBeInTheDocument();
    expect(within(bar).getByLabelText('Staff')).toBeInTheDocument();
    expect(within(bar).getByText('Times in Europe/Madrid')).toBeInTheDocument();
    expect(
      within(bar).getByText('At risk 2, Pending 0, Confirmed 1, Cancelled 1, Needs outcome 1, Completed 2'),
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
      ['13:00', '30 min', 'Ana Torres', 'Haircut', 'with Alex', 'Pending', 'No reply yet', 'Edit', 'Confirm', 'Cancel'],
      ['16:00', '45 min', 'Felix Novak', 'Manicure', 'with Alex', 'Pending', 'No reply yet', 'Missed 2 before', 'Edit', 'Confirm', 'Cancel'],
    ]);
    expect(groupElement('Pending')).toHaveTextContent('No appointments.');
    expect(itemsIn('Confirmed')).toEqual([
      ['14:00', '90 min', 'Chloe Martin', 'Colour', 'with Alex', 'Confirmed by client', 'Edit', 'Cancel'],
    ]);
    expect(itemsIn('Cancelled')).toEqual([
      ['15:00', '45 min', 'Grace Lee', 'Manicure', 'with Alex', 'Cancelled by client', 'Late cancellation'],
    ]);
    expect(itemsIn('Needs outcome')).toEqual([['10:00', '30 min', 'Ben Carter', 'Haircut', 'with Alex', 'Pending', 'Attended', 'No-show']]);
    expect(itemsIn('Completed')).toEqual([
      ['08:00', '30 min', 'Grace Lee', 'Haircut', 'with Sam', 'Attended', 'Undo'],
      ['09:00', '60 min', 'Elena Sousa', 'Colour', 'with Alex', 'No-show', 'Undo'],
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
      ['12:00', '30 min', 'Elena Sousa', 'Haircut', 'with Sam', 'Confirmed by client', 'Missed 1 before', 'Edit', 'Cancel'],
    ]);
    expect(itemsIn('Pending')).toEqual([['13:00', '60 min', 'Ben Carter', 'Massage', 'with Sam', 'Pending', 'Edit', 'Confirm', 'Cancel']]);
    expect(itemsIn('Confirmed')).toEqual([
      ['14:00', '30 min', 'David Ruiz', 'Haircut', 'with Sam', 'Confirmed by staff', 'Edit', 'Cancel'],
    ]);
    expect(itemsIn('Cancelled')).toEqual([['15:00', '60 min', 'Hugo Blanc', 'Massage', 'with Sam', 'Cancelled by staff']]);
  });

  it('shows 21 October in summer time', async () => {
    await renderDashboard(await createSignedInApi());

    chooseDate('2026-10-21');
    await flush();

    expect(itemsIn('Completed')).toEqual([['12:00', '60 min', 'Felix Novak', 'Massage', 'with Alex', 'No-show', 'Undo']]);
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

    expect(itemsIn('Needs outcome')).toEqual([['10:00', '30 min', 'Ben Carter', 'Haircut', 'with Alex', 'Pending', 'Attended', 'No-show']]);
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
    expect(itemsIn('Completed')).toEqual([['08:00', '30 min', 'Grace Lee', 'Haircut', 'with Sam', 'Attended', 'Undo']]);

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
      ['16:00', '45 min', 'Felix Novak', 'Manicure', 'with Alex', 'Pending', 'No reply yet', 'Missed 2 before', 'Edit', 'Confirm', 'Cancel'],
    ]);
    expect(itemsIn('Confirmed')).toEqual([
      ['13:00', '30 min', 'Ana Torres', 'Haircut', 'with Alex', 'Confirmed by client', 'Edit', 'Cancel'],
      ['14:00', '90 min', 'Chloe Martin', 'Colour', 'with Alex', 'Confirmed by client', 'Edit', 'Cancel'],
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

function itemFor(group: string, clientName: string): HTMLElement {
  const item = Array.from(groupElement(group).querySelectorAll('li')).find(
    (entry) => entry.querySelector('.appointment-client')?.textContent === clientName,
  );
  if (!item) {
    throw new Error(`No ${clientName} under ${group}`);
  }
  return item;
}

function buttonNames(item: HTMLElement) {
  return within(item).queryAllByRole('button').map((button) => button.textContent);
}

function buttonIn(group: string, clientName: string, name: string) {
  return within(itemFor(group, clientName)).getByRole('button', { name });
}

function clientLink(group: string, clientName: string) {
  return itemFor(group, clientName).querySelector('.appointment-client');
}

function appointmentButtons() {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('li.appointment button'));
}

async function appointmentId(api: ApiService, clientName: string) {
  const { appointments } = await api.getDayView({});
  return appointments.find((appointment) => appointment.client.name === clientName)!.id;
}

function openCancelPrompt(group: string, clientName: string) {
  fireEvent.click(buttonIn(group, clientName, 'Cancel'));
}

describe('DashboardPage action buttons', () => {
  it('offers the buttons of each group', async () => {
    await renderDashboard(await createSignedInApi());

    expect(buttonNames(itemFor('At risk', 'Ana Torres'))).toEqual(['Confirm', 'Cancel']);
    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Cancel']);
    expect(buttonNames(itemFor('Needs outcome', 'Ben Carter'))).toEqual(['Attended', 'No-show']);
    expect(buttonNames(itemFor('Completed', 'Elena Sousa'))).toEqual(['Undo']);
    expect(buttonNames(itemFor('Completed', 'Grace Lee'))).toEqual(['Undo']);
    expect(buttonNames(itemFor('Cancelled', 'Grace Lee'))).toEqual([]);
  });

  it('confirms on one tap and shows the appointment as confirmed by staff, focusing its client', async () => {
    const api = await createSignedInApi();
    const anaId = await appointmentId(api, 'Ana Torres');
    const confirmAppointment = vi.spyOn(api, 'confirmAppointment');
    await renderDashboard(api);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    expect(screen.queryByText('Loading appointments…')).not.toBeInTheDocument();
    await flush();

    expect(confirmAppointment).toHaveBeenCalledTimes(1);
    expect(confirmAppointment).toHaveBeenCalledWith(anaId);
    expect(itemsIn('Confirmed')[0]).toEqual(['13:00', '30 min', 'Ana Torres', 'Haircut', 'with Alex', 'Confirmed by staff', 'Edit', 'Cancel']);
    expect(document.activeElement).toBe(clientLink('Confirmed', 'Ana Torres'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks before cancelling, and Keep appointment puts focus back on Cancel', async () => {
    const api = await createSignedInApi();
    const cancelAppointment = vi.spyOn(api, 'cancelAppointment');
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');

    const chloe = itemFor('Confirmed', 'Chloe Martin');
    expect(within(chloe).getByText('Cancel this appointment?')).toBeInTheDocument();
    expect(buttonNames(chloe)).toEqual(['Keep appointment', 'Yes, cancel it']);
    expect(document.activeElement).toBe(within(chloe).getByRole('button', { name: 'Keep appointment' }));

    fireEvent.click(within(chloe).getByRole('button', { name: 'Keep appointment' }));

    expect(buttonNames(chloe)).toEqual(['Cancel']);
    expect(document.activeElement).toBe(buttonIn('Confirmed', 'Chloe Martin', 'Cancel'));
    expect(cancelAppointment).not.toHaveBeenCalled();
  });

  it('cancels on Yes, cancel it and shows a late staff cancellation', async () => {
    const api = await createSignedInApi();
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');
    fireEvent.click(buttonIn('Confirmed', 'Chloe Martin', 'Yes, cancel it'));
    await flush();

    expect(itemsIn('Cancelled')).toEqual([
      ['14:00', '90 min', 'Chloe Martin', 'Colour', 'with Alex', 'Cancelled by staff', 'Late cancellation'],
      ['15:00', '45 min', 'Grace Lee', 'Manicure', 'with Alex', 'Cancelled by client', 'Late cancellation'],
    ]);
    expect(document.activeElement).toBe(clientLink('Cancelled', 'Chloe Martin'));
  });

  it('keeps at most one prompt open, and another action closes it', async () => {
    await renderDashboard(await createSignedInApi());

    openCancelPrompt('Confirmed', 'Chloe Martin');
    openCancelPrompt('At risk', 'Ana Torres');

    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Cancel']);
    expect(buttonNames(itemFor('At risk', 'Ana Torres'))).toEqual(['Keep appointment', 'Yes, cancel it']);

    fireEvent.click(buttonIn('Needs outcome', 'Ben Carter', 'Attended'));
    await flush();

    expect(screen.queryByText('Cancel this appointment?')).not.toBeInTheDocument();
    expect(buttonNames(itemFor('At risk', 'Ana Torres'))).toEqual(['Confirm', 'Cancel']);
  });

  it.each([
    ['No-show', 'No-show'],
    ['Attended', 'Attended'],
  ])('records %s on Ben Carter and moves him to Completed', async (button, statusText) => {
    await renderDashboard(await createSignedInApi());

    fireEvent.click(buttonIn('Needs outcome', 'Ben Carter', button));
    await flush();

    expect(itemsIn('Completed')).toContainEqual(['10:00', '30 min', 'Ben Carter', 'Haircut', 'with Alex', statusText, 'Undo']);
    expect(groupElement('Needs outcome')).toHaveTextContent('No appointments.');
    expect(document.activeElement).toBe(clientLink('Completed', 'Ben Carter'));
  });

  it('undoes Elena Sousa’s no-show back to Needs outcome as pending', async () => {
    await renderDashboard(await createSignedInApi());

    fireEvent.click(buttonIn('Completed', 'Elena Sousa', 'Undo'));
    await flush();

    expect(itemsIn('Needs outcome')).toContainEqual(['09:00', '60 min', 'Elena Sousa', 'Colour', 'with Alex', 'Pending', 'Attended', 'No-show']);
    expect(document.activeElement).toBe(clientLink('Needs outcome', 'Elena Sousa'));
  });
});

describe('DashboardPage action in progress', () => {
  it.each([
    ['confirmAppointment', 'At risk', 'Ana Torres', 'Confirm', 'Confirming…'],
    ['recordAppointmentOutcome', 'Needs outcome', 'Ben Carter', 'Attended', 'Saving…'],
    ['recordAppointmentOutcome', 'Needs outcome', 'Ben Carter', 'No-show', 'Saving…'],
    ['undoAppointmentOutcome', 'Completed', 'Elena Sousa', 'Undo', 'Undoing…'],
  ] as const)('%s: disables every action button and labels the pressed one', async (method, group, clientName, button, label) => {
    const api = await createSignedInApi();
    const request = deferred<never>();
    vi.spyOn(api, method).mockReturnValue(request.promise);
    await renderDashboard(api);

    fireEvent.click(buttonIn(group, clientName, button));
    await flush();

    expect(buttonIn(group, clientName, label)).toBeDisabled();
    expect(appointmentButtons().every((entry) => entry.disabled)).toBe(true);
  });

  it('labels Yes, cancel it as Cancelling… and disables the prompt', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'cancelAppointment').mockReturnValue(new Promise(() => {}));
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');
    fireEvent.click(buttonIn('Confirmed', 'Chloe Martin', 'Yes, cancel it'));
    await flush();

    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Keep appointment', 'Cancelling…']);
    expect(appointmentButtons().every((entry) => entry.disabled)).toBe(true);
  });

  it.each([false, true])('sends one request for two clicks in the same task (StrictMode %s)', async (isStrict) => {
    const api = await createSignedInApi();
    const confirmAppointment = vi.spyOn(api, 'confirmAppointment');
    await renderDashboard(api, { isStrict });

    const confirm = buttonIn('At risk', 'Ana Torres', 'Confirm');
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    await flush();

    expect(confirmAppointment).toHaveBeenCalledTimes(1);
  });

  it('counts as running until the day view has reloaded after it', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    const reloaded = deferred<DayView>();
    getDayView.mockReturnValueOnce(reloaded.promise);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(2);
    expect(buttonIn('At risk', 'Ana Torres', 'Confirming…')).toBeDisabled();
    expect(screen.queryByText('Loading appointments…')).not.toBeInTheDocument();

    reloaded.resolve(await api.getDayView({}));
    await flush();

    expect(appointmentButtons().every((entry) => !entry.disabled)).toBe(true);
    expect(buttonNames(itemFor('Confirmed', 'Ana Torres'))).toEqual(['Cancel']);
  });
});

describe('DashboardPage action errors', () => {
  it.each([
    ['appointment_started', 'That appointment has already started. Nothing was saved.'],
    ['appointment_not_started', 'That appointment has not started yet. Nothing was saved.'],
    ['invalid_transition', 'That appointment had already changed. Nothing was saved.'],
  ] as const)('reloads and explains a 409 %s', async (code, message) => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    vi.spyOn(api, 'confirmAppointment').mockRejectedValue(new ApiError(409, code, 'x'));
    await renderDashboard(api);
    await api.confirmPublicAppointment('demo-1');

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Loading appointments…')).not.toBeInTheDocument();
    expect(buttonNames(itemFor('Confirmed', 'Ana Torres'))).toEqual(['Cancel']);
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(document.querySelector('.dashboard-bar [role="alert"]')).toBe(screen.getByRole('alert'));
  });

  it('reloads after a 409 on Yes, cancel it and focuses the client', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'cancelAppointment').mockRejectedValue(new ApiError(409, 'invalid_transition', 'x'));
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');
    fireEvent.click(buttonIn('Confirmed', 'Chloe Martin', 'Yes, cancel it'));
    await flush();

    expect(screen.getByRole('alert')).toHaveTextContent('That appointment had already changed. Nothing was saved.');
    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Cancel']);
    expect(document.activeElement).toBe(clientLink('Confirmed', 'Chloe Martin'));
  });

  it('reloads on a 404 and focuses the Date input when the appointment is gone', async () => {
    const api = await createSignedInApi();
    const dayView = await api.getDayView({});
    const getDayView = vi.spyOn(api, 'getDayView');
    vi.spyOn(api, 'confirmAppointment').mockRejectedValue(new ApiError(404, 'not_found', 'Not found.'));
    await renderDashboard(api);
    getDayView.mockResolvedValueOnce({
      ...dayView,
      appointments: dayView.appointments.filter((appointment) => appointment.client.name !== 'Ana Torres'),
    });

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert')).toHaveTextContent('That appointment no longer exists. Nothing was saved.');
    expect(allItems()).toHaveLength(6);
    expect(document.activeElement).toBe(screen.getByLabelText('Date'));
  });

  it.each([
    ['a network failure', networkError],
    ['a 500', new ApiError(500, 'internal_error', 'Something went wrong.')],
  ])('on %s does not reload, closes the prompt, and focuses the client', async (_name, error) => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    vi.spyOn(api, 'cancelAppointment').mockRejectedValue(error);
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');
    fireEvent.click(buttonIn('Confirmed', 'Chloe Martin', 'Yes, cancel it'));
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not save. Check your connection and try again.');
    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Cancel']);
    expect(appointmentButtons().every((entry) => !entry.disabled)).toBe(true);
    expect(document.activeElement).toBe(clientLink('Confirmed', 'Chloe Martin'));
  });

  it('signs out on a 401 from the action', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'confirmAppointment').mockRejectedValue(new ApiError(401, 'unauthenticated', 'Sign in to continue.'));
    await renderDashboard(api);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs out on a 401 from the reload after the action', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockRejectedValueOnce(new ApiError(401, 'unauthenticated', 'Sign in to continue.'));

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps the view when the reload after an action fails, and the refresh carries on', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockRejectedValueOnce(networkError);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();

    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh. Trying again in 30 seconds.');
    expect(buttonNames(itemFor('At risk', 'Ana Torres'))).toEqual(['Confirm', 'Cancel']);
    expect(appointmentButtons().every((entry) => !entry.disabled)).toBe(true);
    expect(document.activeElement).toBe(clientLink('At risk', 'Ana Torres'));

    await advance(30_000);

    expect(getDayView).toHaveBeenCalledTimes(3);
    expect(buttonNames(itemFor('Confirmed', 'Ana Torres'))).toEqual(['Cancel']);
    expect(screen.queryByText('Could not refresh. Trying again in 30 seconds.')).not.toBeInTheDocument();
  });

  it('shows the load error when the date changes during an action and the reload after it fails', async () => {
    const api = await createSignedInApi();
    const confirmed = deferred<Appointment>();
    const { appointments } = await api.getDayView({});
    const ana = appointments.find((appointment) => appointment.client.name === 'Ana Torres')!;
    const { confirmAppointment } = api;
    vi.spyOn(api, 'confirmAppointment').mockReturnValue(confirmed.promise);
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();
    getDayView.mockReturnValueOnce(new Promise(() => {}));
    chooseDate('2026-11-11');
    await flush();
    expect(getDayView).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toHaveTextContent('Loading appointments…');

    getDayView.mockRejectedValueOnce(networkError);
    confirmed.resolve(await confirmAppointment(ana.id));
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Loading appointments…')).not.toBeInTheDocument();
    expect(screen.getByText('Could not load appointments. Check your connection and try again.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(4);
    expect(getDayView).toHaveBeenLastCalledWith({ date: '2026-11-11' });
    expect(screen.queryByText('Could not load appointments. Check your connection and try again.')).not.toBeInTheDocument();
    expect(summaries()).not.toHaveLength(0);
  });

  it('clears the alert when the next action starts', async () => {
    const api = await createSignedInApi();
    const confirmAppointment = vi.spyOn(api, 'confirmAppointment').mockRejectedValue(networkError);
    await renderDashboard(api);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    confirmAppointment.mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the alert when a prompt opens or a filter changes', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'confirmAppointment').mockRejectedValue(networkError);
    await renderDashboard(api);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();
    openCancelPrompt('Confirmed', 'Chloe Martin');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    chooseDate('2026-11-11');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await flush();

    fireEvent.click(buttonIn('Pending', 'Ben Carter', 'Confirm'));
    await flush();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    chooseStaff('Sam');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('DashboardPage refresh with actions', () => {
  it('keeps an open prompt and its focus through a refresh while the appointment can still be cancelled', async () => {
    const api = await createSignedInApi();
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');
    await advance(30_000);

    expect(getDayView).toHaveBeenCalledTimes(2);
    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Keep appointment', 'Yes, cancel it']);
    expect(document.activeElement).toBe(buttonIn('Confirmed', 'Chloe Martin', 'Keep appointment'));
  });

  it('closes the prompt when a refresh shows the appointment cancelled, and focuses the client', async () => {
    const api = await createSignedInApi();
    await renderDashboard(api);

    openCancelPrompt('Confirmed', 'Chloe Martin');
    await api.cancelPublicAppointment('demo-3');
    await advance(30_000);

    expect(itemsIn('Cancelled')[0]).toEqual(['14:00', '90 min', 'Chloe Martin', 'Colour', 'with Alex', 'Cancelled by client', 'Late cancellation']);
    expect(screen.queryByText('Cancel this appointment?')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(clientLink('Cancelled', 'Chloe Martin'));
  });

  it('focuses the Date input when a refresh drops the appointment the prompt was on', async () => {
    const api = await createSignedInApi();
    const dayView = await api.getDayView({});
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    getDayView.mockResolvedValueOnce({
      ...dayView,
      appointments: dayView.appointments.filter((appointment) => appointment.client.name !== 'Chloe Martin'),
    });

    openCancelPrompt('Confirmed', 'Chloe Martin');
    await advance(30_000);

    expect(groupElement('Confirmed')).toHaveTextContent('No appointments.');
    expect(document.activeElement).toBe(screen.getByLabelText('Date'));

    await advance(30_000);

    expect(buttonNames(itemFor('Confirmed', 'Chloe Martin'))).toEqual(['Cancel']);
  });

  it('skips a refresh that comes due during an action, and restarts the cycle after the reload', async () => {
    const api = await createSignedInApi();
    const anaId = await appointmentId(api, 'Ana Torres');
    const getDayView = vi.spyOn(api, 'getDayView');
    const request = deferred<Awaited<ReturnType<ApiService['confirmAppointment']>>>();
    const confirmAppointment = vi.spyOn(api, 'confirmAppointment').mockReturnValueOnce(request.promise);
    await renderDashboard(api);

    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await advance(45_000);
    expect(getDayView).toHaveBeenCalledTimes(1);

    confirmAppointment.mockRestore();
    request.resolve(await api.confirmAppointment(anaId));
    await flush();
    expect(getDayView).toHaveBeenCalledTimes(2);

    await advance(29_900);
    expect(getDayView).toHaveBeenCalledTimes(2);
    await advance(100);
    expect(getDayView).toHaveBeenCalledTimes(3);
  });

  it('ignores a refresh response requested before the action once its reload has started', async () => {
    const api = await createSignedInApi();
    const before = await api.getDayView({});
    const getDayView = vi.spyOn(api, 'getDayView');
    await renderDashboard(api);
    const staleRefresh = deferred<DayView>();
    getDayView.mockReturnValueOnce(staleRefresh.promise);

    await advance(30_000);
    fireEvent.click(buttonIn('At risk', 'Ana Torres', 'Confirm'));
    await flush();
    staleRefresh.resolve(before);
    await flush();

    expect(getDayView).toHaveBeenCalledTimes(3);
    expect(buttonNames(itemFor('Confirmed', 'Ana Torres'))).toEqual(['Cancel']);
  });
});
