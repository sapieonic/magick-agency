import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { SuperAdminProvider } from './contexts/SuperAdminContext';
import { ToastProvider } from './contexts/ToastContext';
import RequireSuperAdmin from './components/auth/RequireSuperAdmin';
import { SuperAdminLayout } from './components/layout/SuperAdminLayout';
import { LoadingSpinner } from './components/common/LoadingSpinner';

const SuperAdminLoginPage = lazy(() => import('./pages/auth/SuperAdminLoginPage'));
const SATenantsPage = lazy(() => import('./pages/super-admin/SATenantsPage'));
const SATenantDetailPage = lazy(() => import('./pages/super-admin/SATenantDetailPage'));
const SAUsersPage = lazy(() => import('./pages/super-admin/SAUsersPage'));
const SAAdminsPage = lazy(() => import('./pages/super-admin/SAAdminsPage'));
const SAAuditPage = lazy(() => import('./pages/super-admin/SAAuditPage'));
const SAPhoneNumbersPage = lazy(() => import('./pages/super-admin/SAPhoneNumbersPage'));
const SAFeatureFlagsPage = lazy(() => import('./pages/super-admin/SAFeatureFlagsPage'));
const SAUsagePage = lazy(() => import('./pages/super-admin/SAUsagePage'));

/**
 * PORT NOTE (magick-agency): cusui mounted this tree at `/super-admin/*` inside
 * the customer app. Here the whole app is the super-admin console, and the API
 * lives at `/super-admin/*` on the same origin, so the UI routes sit at the
 * root (`/tenants`, not `/super-admin/tenants`): a page reload can never be
 * mistaken for an API call by the dev proxy or a static host.
 * Deleted routes: `/super-admin` overview (credits/fleet ranking), `providers`,
 * `governance`, `dispatch-lanes`, `alerts`.
 */
export function App() {
  return (
    <BrowserRouter>
      <SuperAdminProvider>
        <ToastProvider>
          <Suspense fallback={<LoadingSpinner size="lg" />}>
            <Routes>
              <Route path="/login" element={<SuperAdminLoginPage />} />
              <Route path="/" element={<RequireSuperAdmin><SuperAdminLayout /></RequireSuperAdmin>}>
                <Route index element={<Navigate to="/tenants" replace />} />
                <Route path="tenants" element={<SATenantsPage />} />
                <Route path="tenants/:id" element={<SATenantDetailPage />} />
                <Route path="users" element={<SAUsersPage />} />
                <Route path="admins" element={<SAAdminsPage />} />
                <Route path="phone-numbers" element={<SAPhoneNumbersPage />} />
                <Route path="feature-flags" element={<SAFeatureFlagsPage />} />
                <Route path="usage" element={<SAUsagePage />} />
                <Route path="audit" element={<SAAuditPage />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </ToastProvider>
      </SuperAdminProvider>
    </BrowserRouter>
  );
}
