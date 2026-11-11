import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { transitionAgencyCampaign } from '../../api/agencyCampaigns';
import { withCarrierRefusalCopy } from '../../utils/agencyCarriers';
import { ApiError } from '../../api/client';
import { hasPermission } from '../../utils/permissions';
import { Breadcrumbs } from '@magick-agency/web-ui/components/Breadcrumbs';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
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
import { CAMPAIGN_TABS, campaignPanelFromPath } from '../../utils/agencyCampaignTabs';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import {
  trackAgencyCampaignLifecycleAction,
  trackAgencyCampaignLifecycleFailed,
  trackAgencyCampaignTabViewed,
} from '../../analytics/events';
import {
  agencyCampaignControls,
  campaignEnding,
  isKnownCampaignStatus,
  isLifecycleActionEnabled,
  PAUSE_IN_FLIGHT_NOTE,
  showsPauseInFlightNote,
  type AgencyCampaignAction as Action,
} from '../../utils/agencyCampaignControls';
import { campaignTimeline } from '../../utils/agency/overview/lifecycle';
import { CampaignDetailHeader } from './campaign-detail/CampaignDetailHeader';
import { InsightsPanel } from './campaign-detail/insights/InsightsPanel';
import { useAgencyCampaignDetail } from './campaign-detail/useAgencyCampaignDetail';
import styles from './AgencyCampaignDetailPage.module.css';

/** Only `stop` is irreversible, so only `stop` interrupts with a confirm. */
const CONFIRM_COPY: Partial<Record<Action, { title: string; message: string }>> = {
  stop: {
    title: 'Stop this campaign?',
    message:
      'No new calls will be placed. Calls already in progress will finish normally, and the '
      + 'campaign moves to “Stopping” until they do. A stopped campaign cannot be restarted.',
  },
};

export function AgencyCampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();

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
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);
  /** Bumped by the Refresh control so the analytic tabs' range reads re-read too. */
  const [insightsRefresh, setInsightsRefresh] = useState(0);
  /** Overdue callbacks as of now, reported by the insights panel: the Callbacks tab's badge. */
  const [callbacksOverdue, setCallbacksOverdue] = useState<number | null>(null);

  /**
   * Synchronous with the click. `setBusy` is a render, so two Start clicks in
   * the same frame both see `busy === null` and both POST — the 7× `/start`
   * 409 seen in real use is that click, repeated, against a button that never
   * disabled. The ref is the lock the state cannot be.
   */
  const busyRef = useRef(false);

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



  /**
   * Say why a lifecycle action was refused. A carrier refusal (start or resume on a
   * carrier account that is no longer active, or gone) gets the console's own sentence,
   * which says who can fix it; anything else shows the API's message.
   */
  const reportRefusal = useCallback(
    (err: unknown) => showErrorToast(withCarrierRefusalCopy(err), 'Could not change the campaign state.'),
    [showErrorToast],
  );

  const runAction = useCallback(
    async (action: Action) => {
      if (!id || !tenantId || !accountId) return;
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(action);
      // Captured before the request fires — `updated.status` below is the
      // TO side, and neither may be read off `campaign` state directly (see
      // the comment on `campaignRef`).
      let fromStatus = campaignRef.current?.status;
      try {
        /**
         * Start / Resume from a stale view is a known bug: the button would
         * have been hidden if we held `running`. Re-read before
         * POSTing so the click does not become the API's 409. Pause / Stop
         * are still guarded against the status we hold — those buttons
         * are not the ones that stayed enabled across a transition.
         */
        if (action === 'start' || action === 'resume') {
          const latest = await refreshCampaign();
          fromStatus = latest?.status ?? fromStatus;
        }
        if (fromStatus && !isLifecycleActionEnabled(fromStatus, action)) {
          return;
        }
        const updated = await transitionAgencyCampaign(id, action, tenantId, accountId);
        // Invalidate any GET that started before this write so it cannot
        // paint the previous status over the one we just committed.
        commitCampaign(updated);
        // Report what came back, not what was asked for. `stop` answers with
        // `stopping`, and a toast saying "Stopped" while calls are still up
        // would contradict the badge rendered directly beneath it.
        showToast(`Campaign is now ${updated.status}.`, 'success');
        if (fromStatus && isKnownCampaignStatus(fromStatus) && isKnownCampaignStatus(updated.status)) {
          trackAgencyCampaignLifecycleAction({
            campaign_id: id,
            action,
            from_status: fromStatus,
            to_status: updated.status,
            // Only `stop` interrupts with a confirm dialog (`CONFIRM_COPY`).
            confirmed: Boolean(CONFIRM_COPY[action]),
            from_tab: panel,
          });
        }
        void load();
      } catch (err: unknown) {
        const statusCode = err instanceof ApiError ? err.statusCode : 0;
        /**
         * A 409 is an answer, not a transport failure. Two kinds:
         * the campaign moved underneath us (stale Start / Resume), or the
         * transition is refused where the campaign stands. The first is repaired
         * by refetching — the refreshed view then replaces the button, and a
         * conflict toast on a control that has just disappeared is friction. The
         * second is a real refusal (the roster gate, say) and still has to be
         * said. Another running campaign on the account is not a refusal: several
         * run at once and share the account's lines (decisions MC6).
         */
        let reportFailure = true;
        if (statusCode === 409) {
          const latest = await refreshCampaign();
          const stillOffered = latest ? isLifecycleActionEnabled(latest.status, action) : true;
          if (stillOffered) {
            reportRefusal(err);
          } else {
            reportFailure = false;
          }
        } else {
          reportRefusal(err);
        }
        if (reportFailure && fromStatus && isKnownCampaignStatus(fromStatus)) {
          trackAgencyCampaignLifecycleFailed({
            campaign_id: id,
            action,
            from_status: fromStatus,
            // `0` is a non-`ApiError` failure (e.g. a network error) — there is
            // no HTTP status to report, and `0` cannot collide with a real one.
            status_code: statusCode,
          });
        }
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [id, tenantId, accountId, load, refreshCampaign, commitCampaign, campaignRef, showToast, reportRefusal, panel],
  );

  const onActionClick = useCallback(
    (action: Action) => {
      if (CONFIRM_COPY[action]) setConfirming(action);
      else void runAction(action);
    },
    [runAction],
  );

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

  // "Campaigns / <name> / <tab>" in the top bar.
  useCampaignCrumbs(campaign?.id, campaign?.name, [
    { label: CAMPAIGN_TABS.find((tab) => tab.id === panel)?.label ?? 'Campaign' },
  ]);

  if (loading) return <LoadingSpinner />;

  if (error && !campaign) {
    return <ErrorAlert message={error} onRetry={() => void load()} />;
  }

  if (!campaign) return null;

  const controls = agencyCampaignControls(campaign.status);
  const confirmCopy = confirming ? CONFIRM_COPY[confirming] : undefined;
  /*
    HOW it ended, not merely THAT it did. `stopped` and `completed` are different
    events — a supervisor ended one, the other ran out of list — and the badge
    beside the title already distinguishes them. Collapsing both into a boolean
    is what had a completed campaign reporting "Stopped by: Automatically",
    which reads as the dialer having killed it.
  */
  const ending = campaignEnding(campaign.status);
  const terminal = ending !== null;


  /*
    ONE `now` for the whole render, read here and handed to both consumers.

    A fresh `new Date()` inside each of them is fine for a duration that is
    genuinely moving — this page re-renders every 10s from the poll, which is
    what keeps "Running for 6 hours" honest — but two of them in one render can
    straddle a tick, and the header saying "Running for 3 hours" above a rail
    saying "Ran for 2 hours 59 minutes" is a page disagreeing with itself about
    the same campaign.
  */
  const now = new Date();
  const timeline = campaignTimeline(campaign, ending, now);
  /*
    The two header facts, in reading order, with the absent ones dropped rather
    than dashed — `campaignTimeline` returns `null` for anything this server did
    not carry, and "Started —" reads as a failed read (or, on a campaign that
    genuinely never started, as a wrong one).
  */
  const timelineParts = [timeline.started, timeline.ran].filter(
    (part): part is string => part !== null,
  );

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          { label: campaign.name },
        ]}
      />

      <CampaignDetailHeader
        campaign={campaign}
        lastUpdatedAt={lastUpdatedAt}
        autoRefreshing={shouldPoll}
        timelineParts={timelineParts}
        concurrency={stats?.concurrency}
        tenantId={tenantId}
        accountId={accountId}
        canControl={canControl}
        controls={controls}
        busy={busy}
        onAction={onActionClick}
        terminal={terminal}
        canRetry={canRetry}
        onRetry={() => setRetryOpen(true)}
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

      {/*
        Said out loud rather than left to be inferred from a counter that keeps
        moving: pause stops NEW calls only. A supervisor who believes they cut
        off live conversations may say so to a customer who is still on one.
      */}
      {canControl && showsPauseInFlightNote(campaign.status) && (
        <p className={styles.pauseNote}>
          <Activity size={15} aria-hidden="true" />
          {PAUSE_IN_FLIGHT_NOTE}
        </p>
      )}

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
          The live floor count, so the tab says whether it is worth opening.
          `stats.agents` absent is "not known", not "nobody" — `liveAgentCount`
          renders no badge for either `null` or `0`, so an unread floor never
          claims to be an empty one.
        */
        liveAgentCount={stats?.agents ? stats.agents.length : null}
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

      {confirming && confirmCopy && (
        <ConfirmDialog
          open
          title={confirmCopy.title}
          message={confirmCopy.message}
          confirmLabel="Stop campaign"
          danger
          disabled={busy !== null}
          onConfirm={() => {
            const action = confirming;
            setConfirming(null);
            void runAction(action);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

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
