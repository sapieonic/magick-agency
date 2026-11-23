import { Navigate, useLocation } from 'react-router-dom';
import { PhoneOutgoing } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { usePermission } from '../../hooks/usePermission';
import { softphoneCallsRedirectPath } from '../../utils/agency/callLog';
import { CallLogList } from './AgencyCampaignAttemptsPage';
import styles from './AgencyCampaignAttemptsPage.module.css';

/**
 * `/agency/calls`: the account's **All calls** (`docs/call-log.md` §7, CL34), where the
 * account's Soft-phone calls list was. Every call of the account, whatever placed it and
 * whatever campaign it is on, in the campaign Call log's own table with a Campaign column and a
 * Campaign filter; "No campaign" lists the calls filed under none.
 *
 * On top of the `/agency` subtree's gates (the `agency` capability, `agency_dialer_enabled`), a
 * reader below `agency.supervise` is told so and nothing is asked for: the server refuses
 * `GET /calls` below that floor, the floor the Soft-phone calls list had.
 */
export default function AllCallsPage() {
  const supervise = usePermission('agency.supervise');
  if (!supervise) {
    return (
      <div className={styles.page}>
        <EmptyState
          icon={<PhoneOutgoing size={32} />}
          title="All calls"
          description="Only supervisors can see every call in the account. Your own calls are under My calls."
        />
      </div>
    );
  }
  return (
    <div className={styles.page}>
      <CallLogList scope={{ kind: 'account' }} />
    </div>
  );
}

/**
 * `/agency/softphone`: the account's Soft-phone calls until All calls took its place (CL34).
 * Its links and bookmarks land on All calls with the Soft phone chip on and their query kept,
 * replacing the entry so Back does not bounce.
 */
export function SoftphoneCallsRedirect() {
  const { search } = useLocation();
  return <Navigate to={softphoneCallsRedirectPath(search)} replace />;
}
