import { Navigate } from 'react-router-dom';
import { useSuperAdmin } from '../../contexts/SuperAdminContext';
import { LoadingSpinner } from '../common/LoadingSpinner';
import type { ReactNode } from 'react';

export default function RequireSuperAdmin({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading } = useSuperAdmin();

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
