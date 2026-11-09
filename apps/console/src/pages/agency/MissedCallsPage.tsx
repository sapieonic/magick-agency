import { Navigate } from 'react-router-dom';
import { PhoneIncoming } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { hasPermission } from '../../utils/permissions';
import { isDedicatedAgent } from '../../utils/agencyPersona';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { PageDescription } from '../../components/common/PageDescription';
import { MissedCallsList } from '../../components/agency/inbound/MissedCallsList';
import styles from '../../components/agency/inbound/Inbound.module.css';

/**
 * Missed calls (`docs/inbound.md` §7): inbound calls that reached nobody, each a follow-up
 * someone owns, with Call back and Mark handled.
 *
 * Served twice, like reports: at `/agency/inbound/missed` in the agency shell, and at
 * `/dialer/missed` in a dedicated agent's own frame (`AgentSurfaceShell`), because an `agent`
 * is below every entry of the agency shell. A dedicated agent who opens the agency path is sent
 * to their own. What the list holds is the server's rule (`agency.inbound.read`): an agent's
 * own rows; with `agency.supervise`, the account's — including the rows assigned to the
 * account rather than a person, which only supervisors work.
 *
 * Hidden entirely (`CapabilityUnavailable`) when `agency_inbound_enabled` is off or the caller
 * lacks `agency.inbound.read`; the route's gates are the dialer's, so the page reads both itself.
 */
export default function MissedCallsPage({ surface = 'agency' }: { surface?: 'agency' | 'agent' }) {
  const { role } = useTenant();
  const { user } = useAuth();
  const inbound = useFeatureFlagEnabled(INBOUND_FLAG);
  const softphone = useFeatureFlagEnabled(SOFTPHONE_FLAG);

  if (role === undefined) return <LoadingSpinner />;
  if (surface === 'agency' && isDedicatedAgent(role)) return <Navigate to="/dialer/missed" replace />;
  if (!inbound || !hasPermission(role, 'agency.inbound.read')) return <CapabilityUnavailable />;

  const supervise = hasPermission(role, 'agency.supervise');
  const list = (
    <MissedCallsList
      userId={user?.id ?? null}
      supervise={supervise}
      canCallBack={softphone && hasPermission(role, 'agency.softphone.dial')}
    />
  );

  if (surface === 'agent') {
    return (
      <AgentSurfaceShell
        icon={<PhoneIncoming size={20} />}
        title="Missed calls"
        subtitle="Your customers who rang when nobody could answer. Call them back, then mark each one handled."
        current="missed"
      >
        {list}
      </AgentSurfaceShell>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Missed calls"
        subtitle={supervise ? 'Inbound calls in this account that reached nobody.' : 'Inbound calls assigned to you that reached nobody.'}
      />
      <PageDescription
        pageKey="agency-inbound-missed"
        description={
          'Every inbound call that nobody answered — out of hours, a caller who hung up while waiting, a wait that ran too long, '
          + 'or every line busy — stays here until someone marks it handled. A call is assigned to the agent the customer last '
          + 'dealt with, or to the account when there is none.'
        }
        tips={[
          'Call back opens the soft phone with the number ready and the customer’s campaign picked; nothing is dialled until you press Call.',
          'A caller on a Do Not Call list is marked DNC. The soft phone asks for a reason before it calls them.',
        ]}
      />
      {list}
    </div>
  );
}

/** `/dialer/missed`: the same page in a dedicated agent's own frame. */
export function AgentMissedCallsPage() {
  return <MissedCallsPage surface="agent" />;
}
