import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/api-error';
import { ApiProvider } from '../api/api-context';
import type { ApiService } from '../api/api-service';
import { createMockApi } from '../api/mock-api';
import type { StaffMember } from '../api/types';
import { App } from '../App';

const now = new Date('2026-11-10T10:07:00Z');

const networkError = new TypeError('Failed to fetch');

const unauthenticated = new ApiError(401, 'unauthenticated', 'Sign in to continue.');

const samPrompt = 'Deactivate Sam? They are signed out and can no longer sign in.';

beforeEach(() => {
  vi.useFakeTimers({ now, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
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

function renderPage(api: ApiService, path = '/staff') {
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
  await screen.findByRole('list');
  return view;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function rows() {
  return within(screen.getByRole('list')).getAllByRole('listitem');
}

function row(name: string) {
  return rows().find((item) => item.textContent!.startsWith(name))!;
}

async function staffId(api: ApiService, name: string) {
  return (await api.listStaff()).find((member) => member.name === name)!.id;
}

async function fillStaff(user: UserEvent, values: { name?: string; email?: string; password?: string }) {
  if (values.name) {
    await user.type(screen.getByLabelText('Name'), values.name);
  }
  if (values.email) {
    await user.type(screen.getByLabelText('Email'), values.email);
  }
  if (values.password) {
    await user.type(screen.getByLabelText('Initial password'), values.password);
  }
}

function add(user: UserEvent) {
  return user.click(screen.getByRole('button', { name: 'Add staff member' }));
}

function expectFieldError(label: string, message: string) {
  const input = screen.getByLabelText(label);
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input.getAttribute('aria-describedby')!.split(' ')).toContain(screen.getByText(message).id);
}

describe('StaffPage loading', () => {
  it('shows the loading status, then the list', async () => {
    const api = await createSignedInApi();
    const staff = await api.listStaff();
    const pending = deferred<StaffMember[]>();
    vi.spyOn(api, 'listStaff').mockReturnValue(pending.promise);
    renderPage(api);

    expect(await screen.findByRole('heading', { level: 1, name: 'Staff' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');

    await act(async () => pending.resolve(staff));

    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows an alert when loading fails and loads again on Try again', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'listStaff').mockRejectedValueOnce(networkError).mockRejectedValueOnce(networkError);
    renderPage(api);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the staff list. Check your connection and try again.');
    expect(screen.queryByRole('list')).toBeNull();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('list')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows sign-in when loading returns 401', async () => {
    const api = await createSignedInApi();
    vi.spyOn(api, 'listStaff').mockRejectedValue(unauthenticated);
    renderPage(api);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('is reached from the header link', async () => {
    renderPage(await createSignedInApi(), '/');
    await screen.findByRole('heading', { name: 'Dashboard' });

    await userEvent.setup().click(screen.getByRole('link', { name: 'Staff' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Staff' })).toBeInTheDocument();
    expect(await screen.findByRole('list')).toBeInTheDocument();
  });
});

describe('StaffPage list', () => {
  it('lists every account by name with its email, marks you and inactive accounts', async () => {
    const api = await createSignedInApi();
    await api.createStaffMember({ name: 'Bea', email: 'bea@demo.test', password: 'secret123' });
    await api.createStaffMember({ name: 'Zoe', email: 'zoe@demo.test', password: 'secret123' });
    await api.updateStaffMember(await staffId(api, 'Zoe'), { isActive: false });
    await renderLoaded(api);

    expect(rows().map((item) => within(item).getAllByText(/./)[0].textContent)).toEqual(['Alex (you)', 'Bea', 'Sam', 'Zoe']);
    expect(within(row('Alex')).getByText('alex@demo.test')).toBeInTheDocument();
    expect(within(row('Alex')).queryByRole('button')).toBeNull();
    expect(within(row('Sam')).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(within(row('Sam')).queryByText('Inactive')).toBeNull();
    expect(within(row('Zoe')).getByText('Inactive')).toBeInTheDocument();
    expect(within(row('Zoe')).getByRole('button', { name: 'Reactivate' })).toBeInTheDocument();
    expect(within(row('Zoe')).queryByRole('button', { name: 'Deactivate' })).toBeNull();
  });

  it('asks before deactivating, and Keep active closes the prompt with no request', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const updateStaffMember = vi.spyOn(api, 'updateStaffMember');
    const confirm = vi.spyOn(window, 'confirm');
    await renderLoaded(api);

    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));

    expect(within(row('Sam')).getByText(samPrompt)).toBeInTheDocument();
    expect(within(row('Sam')).queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(within(row('Sam')).getByRole('button', { name: 'Keep active' })).toHaveFocus();
    expect(within(row('Sam')).getByRole('button', { name: 'Yes, deactivate' })).toBeInTheDocument();

    await user.click(within(row('Sam')).getByRole('button', { name: 'Keep active' }));

    expect(screen.queryByText(samPrompt)).toBeNull();
    expect(within(row('Sam')).getByRole('button', { name: 'Deactivate' })).toHaveFocus();
    expect(updateStaffMember).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('keeps only one prompt open', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    await api.createStaffMember({ name: 'Bea', email: 'bea@demo.test', password: 'secret123' });
    await renderLoaded(api);

    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));
    await user.click(within(row('Bea')).getByRole('button', { name: 'Deactivate' }));

    expect(screen.getAllByRole('button', { name: 'Keep active' })).toHaveLength(1);
    expect(within(row('Bea')).getByRole('button', { name: 'Keep active' })).toHaveFocus();
    expect(within(row('Sam')).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('deactivates once, shows Deactivating… while it runs, then the inactive row', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const samId = await staffId(api, 'Sam');
    const original = api.updateStaffMember.bind(api);
    const pending = deferred<void>();
    const updateStaffMember = vi.spyOn(api, 'updateStaffMember').mockImplementation(async (id, body) => {
      await pending.promise;
      return original(id, body);
    });
    await renderLoaded(api);

    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));
    const confirmButton = within(row('Sam')).getByRole('button', { name: 'Yes, deactivate' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(within(row('Sam')).getByRole('button', { name: 'Deactivating…' })).toBeDisabled();
    expect(within(row('Sam')).getByRole('button', { name: 'Keep active' })).toBeDisabled();
    await act(async () => pending.resolve());

    expect(updateStaffMember).toHaveBeenCalledTimes(1);
    expect(updateStaffMember).toHaveBeenCalledWith(samId, { isActive: false });
    expect(within(row('Sam')).getByText('Inactive')).toBeInTheDocument();
    expect(within(row('Sam')).getByRole('button', { name: 'Reactivate' })).toBeEnabled();
    expect(screen.queryByText(samPrompt)).toBeNull();
  });

  it('reactivates with one tap, showing Reactivating… while it runs', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const samId = await staffId(api, 'Sam');
    await api.updateStaffMember(samId, { isActive: false });
    const original = api.updateStaffMember.bind(api);
    const pending = deferred<void>();
    const updateStaffMember = vi.spyOn(api, 'updateStaffMember').mockImplementation(async (id, body) => {
      await pending.promise;
      return original(id, body);
    });
    await renderLoaded(api);

    const reactivate = within(row('Sam')).getByRole('button', { name: 'Reactivate' });
    fireEvent.click(reactivate);
    fireEvent.click(reactivate);

    expect(within(row('Sam')).getByRole('button', { name: 'Reactivating…' })).toBeDisabled();
    await act(async () => pending.resolve());

    expect(updateStaffMember).toHaveBeenCalledTimes(1);
    expect(updateStaffMember).toHaveBeenCalledWith(samId, { isActive: true });
    expect(within(row('Sam')).queryByText('Inactive')).toBeNull();
    expect(within(row('Sam')).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));
    expect(screen.getByText(samPrompt)).toBeInTheDocument();
  });

  it.each([
    [new ApiError(409, 'cannot_deactivate_self', 'You cannot deactivate your own account.'), 'You cannot deactivate your own account.'],
    [new ApiError(404, 'not_found', 'Not found.'), 'Not found.'],
    [networkError, 'Could not update Sam. Check your connection and try again.'],
  ])('shows %s above the list and keeps the list', async (error, message) => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'updateStaffMember').mockRejectedValue(error);
    await renderLoaded(api);

    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));
    await user.click(within(row('Sam')).getByRole('button', { name: 'Yes, deactivate' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(alert.compareDocumentPosition(screen.getByRole('list')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(row('Sam')).queryByText('Inactive')).toBeNull();
    expect(within(row('Sam')).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  });

  it('shows sign-in when an update returns 401', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'updateStaffMember').mockRejectedValue(unauthenticated);
    await renderLoaded(api);

    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));
    await user.click(within(row('Sam')).getByRole('button', { name: 'Yes, deactivate' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('StaffPage add staff', () => {
  it('has the fields below the list with their attributes', async () => {
    await renderLoaded(await createSignedInApi());

    const heading = screen.getByRole('heading', { level: 2, name: 'Add staff' });
    expect(screen.getByRole('list').compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', '80');
    const email = screen.getByLabelText('Email');
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('maxLength', '254');
    expect(email).toHaveAttribute('autoComplete', 'off');
    const password = screen.getByLabelText('Initial password');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autoComplete', 'new-password');
    expect(password).toHaveAttribute('maxLength', '72');
    expect(screen.getByRole('button', { name: 'Add staff member' }).closest('form')).toHaveAttribute('noValidate');
    expect(screen.queryByRole('button', { name: /show/i })).toBeNull();
  });

  it('shows every browser check at once and sends nothing', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const createStaffMember = vi.spyOn(api, 'createStaffMember');
    await renderLoaded(api);

    await fillStaff(user, { name: '   ', email: 'jordan', password: '1234567' });
    await add(user);

    expectFieldError('Name', 'Enter the name.');
    expectFieldError('Email', 'Enter a valid email address.');
    expectFieldError('Initial password', 'Use at least 8 characters.');
    expect(createStaffMember).not.toHaveBeenCalled();
  });

  it('adds once with trimmed name and email and the password as typed, then empties the form', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    const original = api.createStaffMember.bind(api);
    const pending = deferred<void>();
    const createStaffMember = vi.spyOn(api, 'createStaffMember').mockImplementation(async (body) => {
      await pending.promise;
      return original(body);
    });
    const { container } = await renderLoaded(api);

    await fillStaff(user, { name: '  Jordan ', email: ' Jordan@Demo.test ', password: ' secret12 ' });
    const form = screen.getByRole('button', { name: 'Add staff member' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    await act(async () => pending.resolve());

    expect(createStaffMember).toHaveBeenCalledTimes(1);
    expect(createStaffMember).toHaveBeenCalledWith({ name: 'Jordan', email: 'Jordan@Demo.test', password: ' secret12 ' });
    expect(rows().map((item) => within(item).getAllByText(/./)[0].textContent)).toEqual(['Alex (you)', 'Jordan', 'Sam']);
    expect(within(row('Jordan')).getByText('jordan@demo.test')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Jordan added. Give them their email and initial password.');
    expect(screen.getByLabelText('Name')).toHaveValue('');
    expect(screen.getByLabelText('Email')).toHaveValue('');
    expect(screen.getByLabelText('Initial password')).toHaveValue('');
    expect(container.innerHTML).not.toContain('secret12');
    expect(document.body.textContent).not.toContain('secret12');
    expect(screen.getByTestId('location')).toHaveTextContent('["/staff","","",null]');
    expect(JSON.stringify({ ...localStorage })).not.toContain('secret12');
    expect(JSON.stringify({ ...sessionStorage })).not.toContain('secret12');
  });

  it('shows email_taken under Email', async () => {
    const user = userEvent.setup();
    await renderLoaded(await createSignedInApi());

    await fillStaff(user, { name: 'Sam Two', email: 'SAM@demo.test', password: 'secret123' });
    await add(user);

    expect(await screen.findByText('Another staff account already has this email.')).toBeInTheDocument();
    expectFieldError('Email', 'Another staff account already has this email.');
  });

  it.each([
    ['name', 'Name'],
    ['email', 'Email'],
    ['password', 'Initial password'],
  ])('shows a 422 on %s under its field', async (field, label) => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createStaffMember').mockRejectedValue(new ApiError(422, 'validation_error', 'Server says no.', field));
    await renderLoaded(api);

    await fillStaff(user, { name: 'Jordan', email: 'jordan@demo.test', password: 'secret123' });
    await add(user);

    expect(await screen.findByText('Server says no.')).toBeInTheDocument();
    expectFieldError(label, 'Server says no.');
  });

  it('shows any other 422 in an alert', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createStaffMember').mockRejectedValue(new ApiError(422, 'validation_error', 'Something is off.'));
    await renderLoaded(api);

    await fillStaff(user, { name: 'Jordan', email: 'jordan@demo.test', password: 'secret123' });
    await add(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Something is off.');
  });

  it('shows sign-in when adding returns 401', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createStaffMember').mockRejectedValue(unauthenticated);
    await renderLoaded(api);

    await fillStaff(user, { name: 'Jordan', email: 'jordan@demo.test', password: 'secret123' });
    await add(user);

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('keeps every value on a network failure', async () => {
    const user = userEvent.setup();
    const api = await createSignedInApi();
    vi.spyOn(api, 'createStaffMember').mockRejectedValue(networkError);
    await renderLoaded(api);

    await fillStaff(user, { name: 'Jordan', email: 'jordan@demo.test', password: 'secret123' });
    await add(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not add the staff member. Check your connection and try again.');
    expect(screen.getByLabelText('Name')).toHaveValue('Jordan');
    expect(screen.getByLabelText('Email')).toHaveValue('jordan@demo.test');
    expect(screen.getByLabelText('Initial password')).toHaveValue('secret123');
    expect(rows()).toHaveLength(2);
  });

  it('puts an added member in the New appointment staff select and takes out a deactivated one', async () => {
    const user = userEvent.setup();
    await renderLoaded(await createSignedInApi());

    await fillStaff(user, { name: 'Jordan', email: 'jordan@demo.test', password: 'secret123' });
    await add(user);
    await screen.findByText('Jordan added. Give them their email and initial password.');
    await user.click(within(row('Sam')).getByRole('button', { name: 'Deactivate' }));
    await user.click(within(row('Sam')).getByRole('button', { name: 'Yes, deactivate' }));
    await within(row('Sam')).findByText('Inactive');
    await user.click(screen.getByRole('link', { name: 'New appointment' }));

    const select = (await screen.findByLabelText('Staff')) as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.textContent)).toEqual(['Alex', 'Jordan']);
  });
});
