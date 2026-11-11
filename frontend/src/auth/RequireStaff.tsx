import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from './auth-context';

/** Waits for the first auth check, so a signed-in reload is not bounced to sign-in. */
export function RequireStaff({ children }: { children: ReactNode }) {
  const { staffMember, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) {
    return <p className="loading">Loading…</p>;
  }
  if (!staffMember) {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname + location.search }} />;
  }
  return children;
}
