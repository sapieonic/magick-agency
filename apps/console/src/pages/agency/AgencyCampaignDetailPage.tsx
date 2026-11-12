import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { hasPermission } from '../../utils/permissions';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { CampaignHealthStrip } from '../../components/agency/CampaignHealthStrip';
import { AgentFloor } from '../../components/agency/AgentFloor';
import { CampaignAgentAssignments } from '../../components/agency/CampaignAgentAssignments';
import { CampaignAssignmentProgress } from '../../components/agency/CampaignAssignmentProgress';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { CONTACT_ASSIGNMENT_FLAG } from '../../utils/agencyAssignmentCopy';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { AgencyRetryDialog } from '../../components/agency/AgencyRetryDialog';
import { DEFAULT_RETRY_SELECTOR, retryCreatedToast } from '../../utils/agencyRetrySelector';
import { campaignPanelFromPath } from '../../utils/agencyCampaignTabs';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { publishCampaignTabBadge } from '../../hooks/useCampaignTabBadges';
import { agentsOnShift } from '../../utils/agencyAgentFloor';
import { trackAgencyCampaignTabViewed } from '../../analytics/events';
import { isKnownCampaignStatus } from '../../utils/agencyCampaignControls';
import { CampaignDetailHeader } from './campaign-detail/CampaignDetailHeader';
import { InsightsPanel } from './campaign-detail/insights/InsightsPanel';
import { useAgencyCampaignDetail } from './campaign-detail/useAgencyCampaignDetail';
import { useCampaignLifecycle } from './campaign-detail/useCampaignLifecycle';
import styles from './AgencyCampaignDetailPage.module.css';

export function AgencyCampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { tenantId, accountId, role } = useTenant();
  const { showToast } = useToast();

  /*
    Which of this page's panels is on screen, read from the URL rather than held
    in state: `…/overview`, `…/calls`, `…/agents`, `…/callbacks` and `…/health`
    all mount this component, so a section survives a refresh and can be sent to
    a colleague. See `campaignPanelFromPath`.
  */
  const panel = campaignPanelFromPath(pathname);

  const {
    campaign,
    stats,
    error,
    loading,
    lastUpdatedAt,
    shouldPoll,
    campaignRef,
    load,
    refreshCampaign,
    commitCampaign,
  } = useAgencyCampaignDetail(id, tenantId, accountId);
  const [retryOpen, setRetryOpen] = useState(false);
  /** Bumped by the Refresh control so the analytic tabs' range reads re-read too. */
  const [insightsRefresh, setInsightsRefresh] = useState(0);
  /** Overdue callbacks as of now, reported by the insights panel: the Callbacks tab's badge. */
  const [callbacksOverdue, setCallbacksOverdue] = useState<number | null>(null);

  /**
   * `agency.supervise`, floored at `account_admin`.
   *
   * These controls used to check `proxy.schedules.write` — an `operator`-level
   * permission borrowed because that was what the server's lifecycle routes happened
   * to gate on. It is now a recorded decision that starting, pausing and stopping
   * a dialing campaign is a supervisory act, and the server's four lifecycle proxies
   * gate on `agency.supervise` to match. The UI gate has to be the API gate:
   * checking the looser one here would show an `operator` four buttons that 403.
   */
  const canControl = hasPermission(role, 'agency.supervise');
  // Contacts by agent (contact assignment): a supervisor read behind its flag.
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  // Floors at `agent`, so everyone above holds it too — a supervisor covering a
  // shift is the case this exists for.
  const canJoinStation = hasPermission(role, 'agency.station.connect');
  /*
    The server names BOTH permissions on `POST .../retry`: creating a campaign
    (`agency.campaigns.write`) and acting on another campaign's call results
    (`agency.supervise`). Same `account_admin` floor today; naming both keeps
    this affordance correct if either moves.
  */
  const canRetry = canControl && hasPermission(role, 'agency.campaigns.write');

  const lifecycle = useCampaignLifecycle({
    id,
    tenantId,
    accountId,
    campaignRef,
    refreshCampaign,
    commitCampaign,
    reload: () => void load(),
    fromTab: panel,
  });

  /*
    `trackAgencyCampaignTabViewed` for the panel the URL landed on directly —
    a refresh or a shared link, which a click handler on `CampaignTabs` can
    never see. `from_tab: null` marks this as an arrival rather than a
    same-bar navigation. Guarded on a ref (not state) so it fires once per
    distinct panel value per mount and never on a re-render the poll causes —
    a state-backed guard would itself trigger the very re-render it exists to
    avoid firing on.
  */
  const lastFiredPanelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!campaign || !isKnownCampaignStatus(campaign.status)) return;
    if (lastFiredPanelRef.current === panel) return;
    lastFiredPanelRef.current = panel;
    trackAgencyCampaignTabViewed({
      campaign_id: campaign.id,
      tab: panel,
      from_tab: null,
      campaign_status: campaign.status,
    });
  }, [campaign, panel]);

  /*
    The tab bar's counts, handed to the campaign's other screens so their bar
    need not read them again: on shift at every stats poll, overdue when the
    insights panel reports it. Under `campaign.id`, the campaign the bar shows
    them for (the stats are read with it).
  */
  const onShift = agentsOnShift(stats?.agents);
  const shownId = campaign?.id;
  useEffect(() => {
    if (shownId && tenantId && accountId && onShift !== null) publishCampaignTabBadge('onShift', tenantId, accountId, shownId, onShift);
    // On `stats` as well as the count: each poll's answer is fresh even when the count is unchanged.
  }, [shownId, tenantId, accountId, stats, onShift]);
  useEffect(() => {
    if (shownId && tenantId && accountId && callbacksOverdue !== null) {
      publishCampaignTabBadge('overdue', tenantId, accountId, shownId, callbacksOverdue);
    }
  }, [shownId, tenantId, accountId, callbacksOverdue]);

  // "Campaigns / <name> / <tab>" in the top bar.
  useCampaignCrumbs(id, campaign, panel);

  if (loading) return <LoadingSpinner />;

  if (error && !campaign) {
    return <ErrorAlert message={error} onRetry={() => void load()} />;
  }

  if (!campaign) return null;

  return (
    <div className={styles.page}>

      <CampaignDetailHeader
        campaign={campaign}
        lastUpdatedAt={lastUpdatedAt}
        autoRefreshing={shouldPoll}
        concurrency={stats?.concurrency}
        tenantId={tenantId}
        accountId={accountId}
        canControl={canControl}
        busy={lifecycle.busy}
        onAction={lifecycle.onAction}
        onRetry={canRetry ? () => setRetryOpen(true) : undefined}
        canJoinStation={canJoinStation}
        role={role}
        onRefresh={() => {
          void load();
          /*
            The analytic tabs' range reads fetch separately and deliberately do
            not poll, so without this Refresh moved the counters and the
            "Updated" stamp while those sections silently kept showing the
            older read. Bumped only here — never on the 10s poll, which must
            not re-read up to 92 days every tick.
          */
          setInsightsRefresh((n) => n + 1);
        }}
      />

      {/* No description line: the API has no such column, so it was a paragraph
          that could only ever be empty. See the note on `AgencyCampaign`. */}

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {/*
        A blocker stays above every metric AND above the tab bar. It is the one
        thing on this screen that is worth reading before choosing what to read:
        a diagnosis that only appeared on the section you happened to be on
        would be invisible to the supervisor who opened Agents first.
      */}
      <CampaignHealthStrip
        stats={stats}
        campaignId={campaign.id}
        campaignStatus={campaign.status}
        role={role}
      />

      {/*
        The workspace's sections. Contacts, Call attempts, Activity
        and Settings used to be secondary buttons in the header row above —
        the same row that carries Stop — each gated on its own permission at the
        call site. They are tabs now, gated inside `CAMPAIGN_TABS` on the same
        permissions the server enforces, which leaves the header holding only the
        affordances that CHANGE the campaign.
      */}
      <CampaignTabs
        campaignId={campaign.id}
        active={panel}
        role={role}
        /*
          Agents on shift, so the tab says whether it is worth opening: the same
          count the floor's "N on shift" and the stall banner read
          (`agentsOnShift`), never `agents.length`, which counted signed-out rows.
          `stats.agents` absent is "not known" (null), not "nobody".
        */
        agentsOnShift={onShift}
        campaignStatus={campaign.status}
        callbacksOverdue={callbacksOverdue}
      />

      {/*
        The floor and the roster together, because the question they answer is a
        single one asked two ways: the floor is who is working right now, the
        roster is who works here at all — and an empty floor only means
        something once you can see whether anyone is assigned.

        Mounted only while the section is open, which is also what keeps the
        staffing panel's two reads (`GET …/agents` and the tenant member list)
        off every campaign page view.
      */}
      {panel === 'agents' && (
      <div className={styles.agentPanel}>
        <AgentFloor
          campaignId={campaign.id}
          stats={stats}
          wrapupSeconds={campaign.wrapup_seconds}
          canSupervise={canControl}
          onForced={() => void load()}
        />

        {/*
          Staffing, directly beneath the live floor and deliberately distinct
          from it: the floor answers "who is working right now", this answers
          "who works here". A supervisor looking at an empty floor needs to be
          able to tell a shift nobody has started from a campaign nobody is
          assigned to.

          `canControl` is `hasPermission(role, 'agency.supervise')` — the exact
          permission the server floors all four assignment routes on, so the gate
          here is the gate there.
        */}
        <CampaignAgentAssignments
          campaignId={campaign.id}
          canSupervise={canControl}
          /*
            The floor's own data, handed over rather than fetched again — it is
            what lets the staffing list say "assigned, but not at this station".
            `undefined` agents means the API produced no per-agent rows (or the
            stats read failed), which is NOT an empty floor, so it is passed
            through as `null` and the list claims nothing.
          */
          liveAgentUserIds={stats?.agents ? stats.agents.map((a) => a.agent_user_id) : null}
          // Each row's dedicated caller ID, behind the contact-assignment flag.
          assignmentEnabled={assignmentEnabled}
        />

        {/*
          Contacts by agent, under the staffing list: who works here, then how far
          each has got through the contacts assigned to them. Mounted only for a
          supervisor with the flag on, so its read never 403s on a page view.
        */}
        {canControl && assignmentEnabled ? <CampaignAssignmentProgress campaignId={campaign.id} /> : null}
      </div>
      )}

      {/*
        The analytic tabs (decisions IN1, IN13): Overview, Calls, Callbacks and
        Health, plus the performance half of Agents beneath the floor. ONE
        element in one place for all five, so moving between them keeps its
        reads and its range instead of loading them again. Its reads are floored
        at `agency.supervise`: a role below it sees the floor and staffing on
        Agents, and is sent there from any other analytic tab rather than shown
        a panel of 403s.
      */}
      {canControl ? (
        <InsightsPanel
          campaignId={campaign.id}
          canRetry={canRetry}
          onRetry={() => setRetryOpen(true)}
          refreshToken={insightsRefresh}
          shellStatus={campaign.status}
          view={panel}
          onCallbacksOverdue={setCallbacksOverdue}
        />
      ) : panel === 'agents' ? null : role === undefined ? (
        <LoadingSpinner />
      ) : (
        <Navigate to={`/agency/campaigns/${campaign.id}/agents`} replace />
      )}

      {lifecycle.confirmDialog}

      {/* Mounted only while open: the preview is a count over the whole
          campaign and has no business running on every page view. */}
      {retryOpen && (
        <AgencyRetryDialog
          open
          campaign={campaign}
          /*
            The default, used because this entry point has no filtered
            list behind it: ONE dimension, `last_outcome ∈ {no_answer, busy,
            __none__}`.

            ⚠️ NOT `last_outcome` plus `never_attempted`, which is what this
            comment used to describe. Those are two dimensions, the selector
            algebra ANDs across dimensions, and a contact with no attempts has a
            NULL outcome — so that pair matched zero rows on every campaign and
            this button was dead. "We did not reach them" is a UNION, and
            `__none__` is how it is spelled inside a single dimension. See
            `DEFAULT_RETRY_SELECTOR` for the measurement.

            Everything else — machine, failed, a suppressed state, a disposition
            — is opt-in and reached by narrowing the Contacts tab first, which
            the dialog says.
          */
          selector={DEFAULT_RETRY_SELECTOR}
          origin="campaign"
          onClose={() => setRetryOpen(false)}
          onCreated={(result) => {
            setRetryOpen(false);
            showToast(retryCreatedToast(result), 'success');
            navigate(`/agency/campaigns/${result.campaign.id}`);
          }}
        />
      )}
    </div>
  );
}

export default AgencyCampaignDetailPage;
