import { Navigate, useLocation, useParams } from 'react-router-dom';
import { legacySettingsPath } from '../utils/consoleNav';

/**
 * An old `/app/<page>` URL (a bookmark, a link in an old email): `/app/team`,
 * `/app/notifications`, `/app/inbound/:routeId` and the rest moved to `/settings/<page>` with
 * nothing else changed (decision B28), so the rest of the path, the query and the hash are
 * carried over and the history entry is replaced. Anything else under `/app` was never a page
 * here and goes to `/app`, the console's home decision.
 */
export default function LegacyAppRedirect() {
  const { '*': rest = '' } = useParams();
  const { search, hash } = useLocation();
  const target = legacySettingsPath(rest);
  return <Navigate to={target ? { pathname: target, search, hash } : '/app'} replace />;
}
