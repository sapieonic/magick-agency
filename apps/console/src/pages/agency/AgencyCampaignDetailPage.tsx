import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { AgentFloor } from '../../components/agency/AgentFloor';
import { CampaignAgentAssignments } from '../../components/agency/CampaignAgentAssignments';
import { CampaignAssignmentProgress } from '../../components/agency/CampaignAssignmentProgress';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { CONTACT_ASSIGNMENT_FLAG } from '../../utils/agencyAssignmentCopy';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { campaignPanelFromPath } from '../../utils/agencyCampaignTabs';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { publishCampaignTabBadge } from '../../hooks/useCampaignTabBadges';
import { agentsOnShift } from '../../utils/agencyAgentFloor';
import { trackAgencyCampaignTabViewed } from '../../analytics/events';
import { isKnownCampaignStatus } from '../../utils/agencyCampaignControls';
import { CampaignWorkspaceFrame } from './campaign-detail/CampaignWorkspace';
import { InsightsPanel } from './campaign-detail/insights/InsightsPanel';
import { useAgencyCampaignDetail } from './campaign-detail/useAgencyCampaignDetail';
import { useCampaignChrome } from './campaign-detail/useCampaignChrome';
import styles from './AgencyCampaignDetailPage.module.css';

export function AgencyCampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const { tenantId, accountId, role } = useTenant();

  /*
    Which of this page's panels is on screen, read from the URL rather than held
    in state: `…/overview`, `…/calls`, `…/agents`, `…/callbacks` and `…/health`
    all mount this component, so a section survives a refresh and can be sent to
    a colleague. See `campaignPanelFromPath`.
  */
  const panel = campaignPanelFromPath(pathname);

  const detail = useAgencyCampaignDetail(id, tenantId, accountId);
  const { campaign, stats, error, statsError, loading, load } = detail;
  /** Bumped by the Refresh control so the analytic tabs' range reads re-read too. */
  const [insightsRefresh, setInsightsRefresh] = useState(0);
  /**
   * Overdue callbacks as of now, reported by the insights panel: the Callbacks tab's badge. Kept
   * with the campaign it was read for, because the route has no `key`: moving from one campaign
   * to another keeps this page mounted, and the previous campaign's count must not be shown or
   * published under the next one's id while its own allocation is on its way.
   */
  const [overdueReport, setOverdueReport] = useState<{ campaignId: string; count: number } | null>(null);
  const reportCallbacksOverdue = useCallback((count: number | null, campaignId: string | null) => {
    setOverdueReport(count === null || campaignId === null ? null : { campaignId, count });
  }, []);

  // Contacts by agent (contact assignment): a supervisor read behind its flag.
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);

  /*
    The header, the health strip and the dialogs their controls open, with the gates that
    decide who sees which (`useCampaignChrome`, shared with the campaign's other sections).
    Refresh here also re-reads the analytic tabs' ranges: those fetch separately and
    deliberately do not poll, so without it Refresh moved the counters and the "Updated"
    stamp while those sections silently kept showing the older read. Bumped only here —
    never on the 10s poll, which must not re-read up to 92 days every tick.
  */
  const chrome = useCampaignChrome({
    campaignId: id,
    active: panel,
    detail,
    onRefresh: () => {
      void load();
      setInsightsRefresh((n) => n + 1);
    },
  });
  const { canControl, canRetry } = chrome;

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
  const callbacksOverdue = overdueReport && overdueReport.campaignId === shownId ? overdueReport.count : null;
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

  const readError = error ?? statsError;
  if (error && !campaign) {
    return <ErrorAlert message={error} onRetry={() => void load()} />;
  }

  if (!campaign) return null;

  return (
    <CampaignWorkspaceFrame
      header={chrome.header}
      strip={chrome.strip}
      /*
        The workspace's sections. Contacts, Call attempts, Activity
        and Settings used to be secondary buttons in the header row above —
        the same row that carries Stop — each gated on its own permission at the
        call site. They are tabs now, gated inside `CAMPAIGN_TABS` on the same
        permissions the server enforces, which leaves the header holding only the
        affordances that CHANGE the campaign.
      */
      tabs={
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
      }
    >
      {/* No description line: the API has no such column, so it was a paragraph
          that could only ever be empty. See the note on `AgencyCampaign`. */}

      {/* The campaign's read, or its stats' alone: the floor and the strip read those, so it is said. */}
      {readError && <ErrorAlert message={readError} onRetry={() => void load()} />}

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
          onRetry={chrome.openRetry}
          refreshToken={insightsRefresh}
          shellStatus={campaign.status}
          view={panel}
          onCallbacksOverdue={reportCallbacksOverdue}
        />
      ) : panel === 'agents' ? null : role === undefined ? (
        <LoadingSpinner />
      ) : (
        <Navigate to={`/agency/campaigns/${campaign.id}/agents`} replace />
      )}

      {chrome.dialogs}
    </CampaignWorkspaceFrame>
  );
}

export default AgencyCampaignDetailPage;
