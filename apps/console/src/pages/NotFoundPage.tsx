import { Link } from 'react-router-dom';
import { useTenant } from '../contexts/TenantContext';
import { useGateReaders } from '../hooks/useGateReaders';
import { usePageCrumbs } from '../components/layout/PageCrumbs';
import { HOME_PATH, canSeeHome } from '../utils/consoleNav';
import styles from './NotFoundPage.module.css';

/** What the top bar's breadcrumb calls a page that is not there. */
export const NOT_FOUND_CRUMBS = [{ label: 'Page not found' }];

/**
 * A console URL that is no page here (`/agency/whatever`, `/settings/whatever`, an `/app/...`
 * path that never was one, anything else signed-in): said plainly, inside the shell, with a way
 * home, rather than a silent redirect that leaves the reader wondering why they are on Home.
 *
 * "Home" is Home for whoever may open it (`canSeeHome`); anyone else goes to `/`, which picks
 * their start page (`HomeRedirect`). A dedicated agent never sees this: `AgentLanding` sends
 * them from every shell page to the dialer.
 */
export default function NotFoundPage() {
  const { role } = useTenant();
  const readers = useGateReaders();
  usePageCrumbs(NOT_FOUND_CRUMBS);
  const home = canSeeHome({ role, ...readers });

  return (
    <div className={styles.notFound} data-testid="not-found">
      <h1>Page not found</h1>
      <p>There’s no page at this address. The link may be out of date, or mistyped.</p>
      <Link to={home ? HOME_PATH : '/'} className="btn-primary">
        {home ? 'Go to Home' : 'Go to your start page'}
      </Link>
    </div>
  );
}
