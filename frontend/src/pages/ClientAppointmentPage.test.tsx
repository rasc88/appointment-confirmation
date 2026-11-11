import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { createMockApi } from '../api/mock-api';
import type { PublicAppointment } from '../api/types';
import { App } from '../App';

const now = new Date('2026-11-10T10:07:00Z');

function createApi() {
  return createMockApi({ now });
}

function renderPage(token: string, api: ApiService = createApi()) {
  return render(
    <StrictMode>
      <MemoryRouter initialEntries={[`/c/${token}`]}>
        <ApiProvider api={api}>
          <App />
        </ApiProvider>
      </MemoryRouter>
    </StrictMode>,
  );
}

async function findStatusHeading() {
  const heading = await screen.findByRole('heading', { level: 2 });
  expect(within(screen.getByRole('status')).getByRole('heading', { level: 2 })).toBe(heading);
  return heading;
}

function buttonNames() {
  return screen.queryAllByRole('button').map((button) => button.textContent);
}

function detailRows() {
  return Array.from(document.querySelectorAll('dt')).map((term) => [term.textContent, term.nextElementSibling?.textContent]);
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

describe('ClientAppointmentPage states', () => {
  it('shows only the loading status before the first response', () => {
    const api = createApi();
    vi.spyOn(api, 'getPublicAppointment').mockReturnValue(new Promise(() => {}));

    renderPage('demo-1', api);

    expect(screen.getByRole('main').innerHTML).toBe('<p role="status">Loading your appointment…</p>');
  });

  it.each(['demo-1', 'demo-2', 'demo-13'])('shows %s as pending with Confirm and Cancel', async (token) => {
    renderPage(token);

    expect(await findStatusHeading()).toHaveTextContent('Please confirm your appointment');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Demo Studio');
    expect(buttonNames()).toEqual(['Confirm appointment', 'Cancel appointment']);
  });

  it('shows the details in the business time zone', async () => {
    renderPage('demo-1');

    await findStatusHeading();

    expect(detailRows()).toEqual([
      ['Service', 'Haircut'],
      ['With', 'Alex'],
      ['Date', 'Tuesday, 10 November 2026'],
      ['Time', '13:00, Europe/Madrid'],
      ['Duration', '30 minutes'],
    ]);
  });

  it.each(['demo-3', 'demo-4', 'demo-10'])('shows %s as confirmed with Cancel only', async (token) => {
    renderPage(token);

    expect(await findStatusHeading()).toHaveTextContent('Your appointment is confirmed');
    expect(buttonNames()).toEqual(['Cancel appointment']);
  });

  it.each(['demo-5', 'demo-6'])('shows %s as cancelled with no buttons', async (token) => {
    renderPage(token);

    expect(await findStatusHeading()).toHaveTextContent('This appointment is cancelled');
    expect(screen.getByText('To book again, contact Demo Studio.')).toBeInTheDocument();
    expect(buttonNames()).toEqual([]);
  });

  it.each(['demo-7', 'demo-8', 'demo-9', 'demo-11', 'demo-12'])('shows %s as passed with details and no buttons', async (token) => {
    renderPage(token);

    expect(await findStatusHeading()).toHaveTextContent('This appointment has passed');
    expect(screen.getByText('This link can no longer confirm or cancel it.')).toBeInTheDocument();
    expect(detailRows()).toHaveLength(5);
    expect(buttonNames()).toEqual([]);
    expect(document.body).not.toHaveTextContent(/attended|no.show/i);
  });

  it('decides has-passed from hasStarted, not the device clock', async () => {
    const api = createApi();
    const appointment = await api.getPublicAppointment('demo-1');
    vi.spyOn(api, 'getPublicAppointment').mockResolvedValue({ ...appointment, hasStarted: true });

    renderPage('demo-1', api);

    expect(await findStatusHeading()).toHaveTextContent('This appointment has passed');
  });

  it.each(['nope', 'demo-99'])('shows the invalid link page for %s', async (token) => {
    renderPage(token);

    expect(await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })).toBeInTheDocument();
    expect(screen.getByText('It may have been replaced by a newer link. Contact the business that sent it.')).toBeInTheDocument();
    expect(screen.queryByText('Demo Studio')).not.toBeInTheDocument();
    expect(document.querySelector('dl')).toBeNull();
    expect(buttonNames()).toEqual([]);
  });

  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['429', new ApiError(429, 'rate_limited', 'Too many requests.')],
  ])('shows the load error on %s and loads again on Try again', async (_name, error) => {
    const api = createApi();
    const getPublicAppointment = vi.spyOn(api, 'getPublicAppointment').mockRejectedValue(error);
    renderPage('demo-1', api);

    expect(await screen.findByRole('heading', { level: 1, name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'We could not load your appointment. Check your connection and try again.',
    );
    const callsBefore = getPublicAppointment.mock.calls.length;
    getPublicAppointment.mockReturnValueOnce(new Promise(() => {}));

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading your appointment…');
    expect(getPublicAppointment.mock.calls.length).toBe(callsBefore + 1);
  });
});

describe('ClientAppointmentPage confirm and cancel', () => {
  it('confirms once, showing Confirming… with both buttons disabled', async () => {
    const api = createApi();
    const pending = deferred<PublicAppointment>();
    const confirm = vi.spyOn(api, 'confirmPublicAppointment').mockReturnValue(pending.promise);
    renderPage('demo-1', api);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Confirm appointment' }));

    expect(screen.getByRole('button', { name: 'Confirming…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel appointment' })).toBeDisabled();
    expect(confirm).toHaveBeenCalledTimes(1);
    pending.resolve({ ...(await api.getPublicAppointment('demo-1')), status: 'confirmed' });
    expect(await findStatusHeading()).toHaveTextContent('Your appointment is confirmed');
    expect(buttonNames()).toEqual(['Cancel appointment']);
  });

  it('asks before cancelling, and Keep appointment restores the buttons without a request', async () => {
    const api = createApi();
    const cancel = vi.spyOn(api, 'cancelPublicAppointment');
    renderPage('demo-1', api);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Cancel appointment' }));

    expect(screen.getByText('Cancel this appointment?')).toBeInTheDocument();
    expect(buttonNames()).toEqual(['Keep appointment', 'Yes, cancel it']);
    expect(screen.getByRole('button', { name: 'Keep appointment' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Keep appointment' }));

    expect(buttonNames()).toEqual(['Confirm appointment', 'Cancel appointment']);
    expect(screen.getByRole('button', { name: 'Cancel appointment' })).toHaveFocus();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels once on the second tap, showing Cancelling…', async () => {
    const api = createApi();
    const pending = deferred<PublicAppointment>();
    const cancel = vi.spyOn(api, 'cancelPublicAppointment').mockReturnValue(pending.promise);
    renderPage('demo-3', api);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Keep appointment' })).toBeDisabled();
    expect(cancel).toHaveBeenCalledTimes(1);
    pending.resolve({ ...(await api.getPublicAppointment('demo-3')), status: 'cancelled' });
    expect(await findStatusHeading()).toHaveTextContent('This appointment is cancelled');
    expect(buttonNames()).toEqual([]);
  });

  it('cancels through the mock and shows the cancelled page', async () => {
    renderPage('demo-1');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'This appointment is cancelled' })).toBeInTheDocument();
  });

  it('reloads and shows the cancelled state after confirm is rejected with invalid_transition', async () => {
    const api = createApi();
    const appointment = await api.getPublicAppointment('demo-1');
    vi.spyOn(api, 'confirmPublicAppointment').mockRejectedValue(
      new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.'),
    );
    renderPage('demo-1', api);
    const getPublicAppointment = vi.spyOn(api, 'getPublicAppointment');
    await screen.findByRole('button', { name: 'Confirm appointment' });
    getPublicAppointment.mockResolvedValueOnce({ ...appointment, status: 'cancelled' });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm appointment' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'This appointment is cancelled' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your answer was not saved because this appointment had already changed.',
    );
    expect(getPublicAppointment).toHaveBeenCalledTimes(1);
  });

  it('reloads and shows has passed after confirm is rejected with appointment_started', async () => {
    const api = createApi();
    const appointment = await api.getPublicAppointment('demo-1');
    vi.spyOn(api, 'confirmPublicAppointment').mockRejectedValue(
      new ApiError(409, 'appointment_started', 'This appointment has already started.'),
    );
    renderPage('demo-1', api);
    await screen.findByRole('button', { name: 'Confirm appointment' });
    vi.spyOn(api, 'getPublicAppointment').mockResolvedValueOnce({ ...appointment, hasStarted: true });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirm appointment' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'This appointment has passed' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Your answer was not saved because this appointment had already changed.',
    );
  });

  it.each([
    ['the invalid link page', new ApiError(404, 'not_found', 'This link is not valid.'), 'This link is not valid'],
    ['the load error page', new TypeError('Failed to fetch'), 'Something went wrong'],
  ])('shows %s when the reload after a 409 fails', async (_name, error, heading) => {
    const api = createApi();
    vi.spyOn(api, 'cancelPublicAppointment').mockRejectedValue(
      new ApiError(409, 'invalid_transition', 'This appointment can no longer be changed.'),
    );
    renderPage('demo-1', api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Cancel appointment' }));
    vi.spyOn(api, 'getPublicAppointment').mockRejectedValueOnce(error);

    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it('shows the invalid link page when an action returns 404', async () => {
    const api = createApi();
    vi.spyOn(api, 'confirmPublicAppointment').mockRejectedValue(new ApiError(404, 'not_found', 'This link is not valid.'));
    renderPage('demo-1', api);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Confirm appointment' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'This link is not valid' })).toBeInTheDocument();
  });

  it.each([
    ['a network failure', new TypeError('Failed to fetch')],
    ['429', new ApiError(429, 'rate_limited', 'Too many requests.')],
    ['500', new ApiError(500, 'internal_error', 'Something went wrong.')],
  ])('keeps the state and shows a retry alert when cancel fails with %s', async (_name, error) => {
    const api = createApi();
    vi.spyOn(api, 'cancelPublicAppointment').mockRejectedValue(error);
    renderPage('demo-1', api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Cancel appointment' }));

    await user.click(screen.getByRole('button', { name: 'Yes, cancel it' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your answer was not saved. Check your connection and try again.',
    );
    expect(await findStatusHeading()).toHaveTextContent('Please confirm your appointment');
    expect(buttonNames()).toEqual(['Confirm appointment', 'Cancel appointment']);
    expect(screen.getByRole('button', { name: 'Confirm appointment' })).toBeEnabled();
    expect(detailRows()).toHaveLength(5);
  });

  it('clears the alert when a new action starts', async () => {
    const api = createApi();
    const confirm = vi.spyOn(api, 'confirmPublicAppointment').mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPage('demo-1', api);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Confirm appointment' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    confirm.mockReturnValueOnce(new Promise(() => {}));

    await user.click(screen.getByRole('button', { name: 'Confirm appointment' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ClientAppointmentPage privacy', () => {
  it('calls no staff operation and shows no client data or token', async () => {
    const api = createApi();
    const getCurrentStaffMember = vi.spyOn(api, 'getCurrentStaffMember');
    renderPage('demo-1', api);

    await findStatusHeading();

    expect(getCurrentStaffMember).not.toHaveBeenCalled();
    expect(document.body).not.toHaveTextContent(/Ana Torres|\+34|demo-1/);
    expect(document.body.innerHTML).not.toContain('demo-1');
    expect(document.title).not.toContain('demo-1');
  });
});
