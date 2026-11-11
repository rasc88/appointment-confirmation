import { useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './auth-context';

/** Waits for the first auth check, so a signed-in reload is not bounced to sign-in. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { staffMember, isLoading } = useAuth();
  const location = useLocation();
  const [hasBeenSignedIn, setHasBeenSignedIn] = useState(false);
  if (staffMember && !hasBeenSignedIn) {
    setHasBeenSignedIn(true);
  }
  if (isLoading) {
    return <p className="loading">Loading…</p>;
  }
  if (!staffMember) {
    // After a sign-out, remembering the page would send the next person to it instead of the dashboard.
    const state = hasBeenSignedIn ? undefined : { from: location.pathname + location.search };
    return <Navigate to="/sign-in" replace state={state} />;
  }
  return children;
}
