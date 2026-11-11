import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ApiProvider } from './api/api-context';
import type { ApiService } from './api/api-service';
import { createMockApi } from './api/mock-api';
import { App } from './App';

function renderApp(path: string, api: ApiService = createMockApi()) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider api={api}>
        <App />
      </ApiProvider>
    </MemoryRouter>,
  );
}

async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('App', () => {
  it('shows sign-in when a signed-out user opens the dashboard', async () => {
    renderApp('/');

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows both field messages on an empty submit and does not call login', async () => {
    const api = createMockApi();
    const login = vi.spyOn(api, 'login');
    renderApp('/sign-in', api);

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter your email.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();
  });

  it('treats a whitespace-only email as empty and trims the email it sends', async () => {
    const api = createMockApi();
    const login = vi.spyOn(api, 'login');
    renderApp('/sign-in', api);

    await signIn('   ', 'demo1234');
    expect(screen.getByText('Enter your email.')).toBeInTheDocument();
    expect(login).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), ' alex@demo.test ');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).toHaveBeenCalledWith({ email: 'alex@demo.test', password: 'demo1234' });
  });

  it('shows the error for a wrong password, keeps the email and clears the password', async () => {
    renderApp('/sign-in');

    await signIn('alex@demo.test', 'wrong-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveValue('alex@demo.test');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('shows the connection message when login fails without an ApiError', async () => {
    const api = createMockApi();
    vi.spyOn(api, 'login').mockRejectedValue(new TypeError('Failed to fetch'));
    renderApp('/sign-in', api);

    await signIn('alex@demo.test', 'demo1234');

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in. Check your connection and try again.');
  });

  it('disables the button and sends one request while login is pending', async () => {
    const api = createMockApi();
    const login = vi.spyOn(api, 'login').mockReturnValue(new Promise(() => {}));
    renderApp('/sign-in', api);

    await signIn('alex@demo.test', 'demo1234');
    const button = screen.getByRole('button', { name: 'Signing in…' });
    await userEvent.setup().click(button);

    expect(button).toBeDisabled();
    expect(login).toHaveBeenCalledTimes(1);
  });

  it('lands on the dashboard with the staff name in the header after signing in', async () => {
    renderApp('/sign-in');

    await signIn('alex@demo.test', 'demo1234');

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).toHaveTextContent('Alex');
  });

  it('returns to the requested page after signing in', async () => {
    renderApp('/settings');

    await signIn('alex@demo.test', 'demo1234');

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
  });

  it('signs out back to sign-in, and the dashboard stays behind sign-in afterwards', async () => {
    const api = createMockApi();
    const { unmount } = renderApp('/sign-in', api);
    await signIn('alex@demo.test', 'demo1234');

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    unmount();
    renderApp('/', api);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('still signs out when logout fails', async () => {
    const api = createMockApi();
    vi.spyOn(api, 'logout').mockRejectedValue(new TypeError('Failed to fetch'));
    renderApp('/sign-in', api);
    await signIn('alex@demo.test', 'demo1234');

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('redirects a signed-in user from sign-in to the dashboard', async () => {
    const api = createMockApi();
    await api.login({ email: 'alex@demo.test', password: 'demo1234' });

    renderApp('/sign-in', api);

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('shows Loading while the first auth check is pending', () => {
    const api = createMockApi();
    vi.spyOn(api, 'getCurrentStaffMember').mockReturnValue(new Promise(() => {}));

    renderApp('/settings', api);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('shows the client page signed out, without the staff header', async () => {
    renderApp('/c/demo-1');

    expect(await screen.findByRole('heading', { name: 'Your appointment' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
  });

  it('shows Page not found for an unknown path', async () => {
    renderApp('/no-such-page');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute('href', '/');
  });
});
