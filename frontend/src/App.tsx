import type { ReactNode } from 'react';
import { Outlet, Route, Routes } from 'react-router';
import { AuthProvider } from './auth/auth-context';
import { RequireStaff } from './auth/RequireStaff';
import { ClientAppointmentPage } from './pages/ClientAppointmentPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { SignInPage } from './pages/SignInPage';
import { StaffLayout } from './StaffLayout';

function staffPage(page: ReactNode) {
  return (
    <RequireStaff>
      <StaffLayout>{page}</StaffLayout>
    </RequireStaff>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/c/:token" element={<ClientAppointmentPage />} />
      <Route
        element={
          <AuthProvider>
            <Outlet />
          </AuthProvider>
        }
      >
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/" element={staffPage(<PlaceholderPage title="Dashboard" />)} />
        <Route path="/appointments/new" element={staffPage(<PlaceholderPage title="New appointment" />)} />
        <Route path="/appointments/:id/edit" element={staffPage(<PlaceholderPage title="Edit appointment" />)} />
        <Route path="/clients/:id" element={staffPage(<PlaceholderPage title="Client" />)} />
        <Route path="/settings" element={staffPage(<PlaceholderPage title="Settings" />)} />
        <Route path="/staff" element={staffPage(<PlaceholderPage title="Staff" />)} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
