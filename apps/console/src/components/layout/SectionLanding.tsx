import { Navigate, useLocation } from 'react-router-dom';
import { useNavGate } from '../../hooks/useNavGate';
import { sectionLandingPath, sectionRootFor } from '../../utils/consoleNav';
import NotFoundPage from '../../pages/NotFoundPage';

/**
 * A section's root URL that is not a page of its own (`/agency/inbound`): opens the section's
 * first tab the reader may open (`sectionLandingPath`), as the sidebar's entry does, keeping
 * the query and the hash. The history entry is replaced, so Back skips it.
 */
export function SectionLanding() {
  const { pathname, search, hash } = useLocation();
  const gate = useNavGate({ missed: true });
  const section = sectionRootFor(pathname);
  if (!section) return <NotFoundPage />;
  const to = sectionLandingPath(section, gate);
  return <Navigate to={{ pathname: to, search, hash }} replace />;
}
