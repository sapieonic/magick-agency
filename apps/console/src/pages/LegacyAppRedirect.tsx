import { Navigate, useLocation, useParams } from 'react-router-dom';
import { legacySettingsPath } from '../utils/consoleNav';
import NotFoundPage from './NotFoundPage';

/**
 * An old `/app/<page>` URL (a bookmark, a link in an old email): `/app/team`,
 * `/app/notifications`, `/app/inbound/:routeId` and the rest moved to `/settings/<page>` with
 * nothing else changed (decision B28), so the rest of the path, the query and the hash are
 * carried over and the history entry is replaced. Anything else under `/app` was never a page
 * here, and says so (`NotFoundPage`) rather than landing somewhere unexplained.
 */
export default function LegacyAppRedirect() {
  const { '*': rest = '' } = useParams();
  const { search, hash } = useLocation();
  const target = legacySettingsPath(rest);
  if (!target) return <NotFoundPage />;
  return <Navigate to={{ pathname: target, search, hash }} replace />;
}
