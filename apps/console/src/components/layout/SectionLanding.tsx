import { Navigate, useLocation } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useGateReaders } from '../../hooks/useGateReaders';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { sectionLandingPath, sectionRootFor } from '../../utils/consoleNav';
import NotFoundPage from '../../pages/NotFoundPage';

/**
 * A section's root URL that is not a page of its own (`/agency/inbound`): opens the section's
 * first tab the reader may open (`sectionLandingPath`), as the sidebar's entry does, keeping
 * the query and the hash. The history entry is replaced, so Back skips it.
 */
export function SectionLanding() {
  const { pathname, search, hash } = useLocation();
  const { role } = useTenant();
  const readers = useGateReaders();
  const missed = useMissedCallsAccess();
  const section = sectionRootFor(pathname);
  if (!section) return <NotFoundPage />;
  const to = sectionLandingPath(section, { role, ...readers, missedAvailable: missed.available });
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
