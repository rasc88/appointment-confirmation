import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useApi } from '../api/api-context';
import type { StaffMember } from '../api/types';

interface AuthState {
  staffMember: StaffMember | null;
  isLoading: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [staffMember, setStaffMember] = useState<StaffMember | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isCurrent = true;
    api
      .getCurrentStaffMember()
      .then(
        (current) => {
          if (isCurrent) {
            setStaffMember(current);
          }
        },
        () => {},
      )
      .finally(() => {
        if (isCurrent) {
          setIsLoading(false);
        }
      });
    return () => {
      isCurrent = false;
    };
  }, [api]);

  async function signIn(email: string, password: string) {
    const signedIn = await api.login({ email, password });
    setStaffMember(signedIn);
    setIsLoading(false);
  }

  async function signOut() {
    try {
      await api.logout();
    } catch {
      // Signed out locally even when the request fails.
    }
    setStaffMember(null);
  }

  return <AuthContext value={{ staffMember, isLoading, signIn, signOut }}>{children}</AuthContext>;
}

export function useAuth(): AuthState {
  const auth = useContext(AuthContext);
  if (!auth) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return auth;
}
