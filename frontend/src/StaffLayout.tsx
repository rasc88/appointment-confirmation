import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuth } from './auth/auth-context';

export function StaffLayout({ children }: { children: ReactNode }) {
  const { staffMember, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate('/sign-in');
  }

  return (
    <>
      <header className="staff-header">
        <span className="staff-name">{staffMember?.name}</span>
        <nav>
          <Link to="/">Dashboard</Link>
          <Link to="/appointments/new">New appointment</Link>
          <Link to="/settings">Settings</Link>
          <Link to="/staff">Staff</Link>
        </nav>
        <button type="button" onClick={handleSignOut}>
          Sign out
        </button>
      </header>
      <main>{children}</main>
    </>
  );
}
