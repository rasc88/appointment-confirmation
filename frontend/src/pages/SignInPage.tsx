import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError } from '../api/api-error';
import { useAuth } from '../auth/auth-context';

export function SignInPage() {
  const { staffMember, signIn } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [formError, setFormError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (staffMember) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedEmail = email.trim();
    setEmailError(trimmedEmail ? '' : 'Enter your email.');
    setPasswordError(password ? '' : 'Enter your password.');
    setFormError('');
    if (!trimmedEmail || !password) {
      return;
    }
    setIsSubmitting(true);
    try {
      await signIn(trimmedEmail, password);
    } catch (error) {
      setFormError(error instanceof ApiError ? error.message : 'Could not sign in. Check your connection and try again.');
      setPassword('');
      setIsSubmitting(false);
    }
  }

  return (
    <main className="sign-in">
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit} noValidate>
        {formError && <p role="alert" className="form-error">{formError}</p>}
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? 'email-error' : undefined}
          />
          {emailError && <p id="email-error" className="field-error">{emailError}</p>}
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? 'password-error' : undefined}
          />
          {passwordError && <p id="password-error" className="field-error">{passwordError}</p>}
        </div>
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
