import { Navigate } from 'react-router-dom';
import { PhoneIncoming } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { hasPermission } from '../../utils/permissions';
import { isDedicatedAgent } from '../../utils/agencyPersona';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { PageDescription } from '../../components/common/PageDescription';
import { MissedCallsList } from '../../components/agency/inbound/MissedCallsList';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { NOBODY_FREE_MEANING } from '../../utils/inbound/missedCopy';
import missedStyles from '../../components/agency/inbound/MissedCalls.module.css';
import { InboundQueueTiles } from '../../components/agency/inbound/InboundQueueTiles';
import { SettingsEntryLink } from '../../components/common/SettingsEntryLink';
import styles from '../../components/agency/inbound/Inbound.module.css';

/**
 * Missed calls (`docs/inbound.md` §7): inbound calls that reached nobody, each a follow-up
 * someone owns, with Call back and Mark handled.
 *
 * Served twice, like reports: at `/agency/inbound/missed` in the console shell, and at
 * `/dialer/missed` in a dedicated agent's own frame (`AgentSurfaceShell`), because an `agent`
 * is below every entry of the console shell. A dedicated agent who opens the agency path is sent
 * to their own. What the list holds is the server's rule (`agency.inbound.read`): an agent's
 * own rows, and (IQ49) a Team view of the account's rows nobody has, which they claim; with
 * `agency.supervise`, the account's, including the rows assigned to the account rather than a
 * person.
 *
 * Hidden entirely (`CapabilityUnavailable`) without `agency.inbound.read`, and when
 * `agency_inbound_enabled` is off with no rows to read. With the flag off and rows there, the list
 * stays readable under a notice saying what happens (the kill switch answers callers with the
 * closed message and still lists them here, `docs/inbound.md` §8.4); what each action may still do is the server's answer. The route's gates are
 * the dialer's, so the page reads both itself.
 */
export default function MissedCallsPage({ surface = 'agency' }: { surface?: 'agency' | 'agent' }) {
  const { role } = useTenant();
  const { user } = useAuth();
  const access = useMissedCallsAccess();
  const softphone = useFeatureFlagEnabled(SOFTPHONE_FLAG);

  if (role === undefined) return <LoadingSpinner />;
  if (surface === 'agency' && isDedicatedAgent(role)) return <Navigate to="/dialer/missed" replace />;
  if (!hasPermission(role, 'agency.inbound.read')) return <CapabilityUnavailable />;
  if (!access.settled) return <LoadingSpinner />;
  if (!access.available) return <CapabilityUnavailable />;

  const switchedOff = access.inboundOn ? null : (
    <p className={missedStyles.notice} role="note" data-testid="missed-inbound-off">
      Inbound calls are switched off for this account: callers hear the closed message and are still listed here. You
      can call them back and mark them handled.
    </p>
  );

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
        {switchedOff}
        {list}
      </AgentSurfaceShell>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Missed calls"
        subtitle={supervise ? 'Inbound calls in this account that reached nobody.' : 'Inbound calls assigned to you that reached nobody.'}
        actions={<SettingsEntryLink entry="inbound" />}
      />
      <PageDescription
        pageKey="agency-inbound-missed"
        description={
          'Every inbound call that nobody answered — out of hours, a caller who hung up while waiting, nobody free to answer '
          + `(${NOBODY_FREE_MEANING}), or every line busy — stays here until someone marks it handled, or until an agent `
          + 'speaks to the customer (they ring again and someone answers, or someone calls them and saves an outcome other '
          + 'than voicemail). A call is assigned to the agent the customer last dealt with, or to the account when there is none.'
        }
        tips={[
          'Call back opens the soft phone with the number ready and the customer’s campaign picked; nothing is dialled until you press Call.',
          'A caller on a Do Not Call list is marked DNC. The soft phone asks for a reason before it calls them.',
          'Reopen, on the Handled tab, puts a call back on the list: one marked by mistake, or closed when the customer wasn’t really reached.',
          supervise
            ? 'Reassign hands a call to someone else in the account. A call whose agent has left says “Former member”: reassign it.'
            : 'Team lists the callers nobody owns. Claim one and it moves to your missed calls.',
        ]}
      />
      {switchedOff}
      {/* The live queue beside the calls it misses (P2): supervisors only, as the route is; it
          reads the flag itself and shows nothing with inbound off. */}
      <InboundQueueTiles />
      {list}
    </div>
  );
}

/** `/dialer/missed`: the same page in a dedicated agent's own frame. */
export function AgentMissedCallsPage() {
  return <MissedCallsPage surface="agent" />;
}
