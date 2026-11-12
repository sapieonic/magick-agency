import { Link, Outlet, useLocation } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useNavGate } from '../../hooks/useNavGate';
import { accountCreateAccess } from '../../utils/accountCreateAccess';
import { tabBarFor } from '../../utils/consoleNav';
import { SectionTabs } from './SectionTabs';
import styles from './ConsoleLayout.module.css';

/**
 * What every `/agency` page renders inside the console shell: the section's tab bar where the
 * page is one of a group (`tabBarFor`), then the page. It is the `/agency` route's element,
 * under that route's capability and flag gates, so nothing here runs for a tenant without the
 * dialer.
 *
 * Every agency call is account-scoped (the API requires `x-mgkvc-account` and answers 400
 * without it), so with no account resolved it says what is missing once rather than letting
 * each page fail on a header error.
 */
export function AgencyArea() {
  const { pathname } = useLocation();
  const { accountId, accounts, accountResolution, tenantId } = useTenant();
  const { memberships } = useAuth();
  const gate = useNavGate({ missed: true });

  if (!accountId && accountResolution !== 'loading' && accountResolution !== 'error') {
    const canCreateAccount = accountCreateAccess(memberships, tenantId) === 'allowed';
    return (
      <div className={styles.noAccount}>
        <h2>Select an account</h2>
        <p>
          {accounts.length === 0
            ? 'This workspace has no accounts yet. An account is where campaigns, contacts and the Do Not Call list live, so one has to exist before the Agency Dialer can be used.'
            : 'Choose an account from the switcher in the sidebar. Campaigns, rosters and dialling all belong to a single account.'}
        </p>
        {accounts.length === 0 && canCreateAccount && (
          <p>
            <Link to="/settings/accounts" data-testid="agency-create-account-link">Create an account</Link>
          </p>
        )}
      </div>
    );
  }

  const bar = tabBarFor(pathname, gate);

  return (
    <>
      {bar && <SectionTabs bar={bar} />}
      <Outlet />
    </>
  );
}
