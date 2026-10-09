import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Headphones,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Upload,
} from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '../../contexts/ToastContext';
import {
  getAgencyCampaign,
  getAgencyCampaignStats,
  transitionAgencyCampaign,
} from '../../api/agencyCampaigns';
import { ApiError } from '../../api/client';
import { hasPermission } from '../../utils/permissions';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { ConfirmDialog } from '../../components/common/ConfirmDialog';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import { CampaignHealthStrip } from '../../components/agency/CampaignHealthStrip';
import { CampaignPerformance } from '../../components/agency/CampaignPerformance';
import { AgentFloor } from '../../components/agency/AgentFloor';
import { CampaignAgentAssignments } from '../../components/agency/CampaignAgentAssignments';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { CampaignSeriesSection } from '../../components/agency/CampaignSeriesSection';
import { CampaignLineageStrip } from '../../components/agency/CampaignLineageStrip';
import { AgencyRetryDialog } from '../../components/agency/AgencyRetryDialog';
import { DEFAULT_RETRY_SELECTOR, retryCreatedToast } from '../../utils/agencyRetrySelector';
import { campaignPanelFromPath } from '../../utils/agencyCampaignTabs';
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
import {
  campaignTimeline,
  contactFunnel,
  floorSummary,
  funnelBarWithheldNote,
  howItEndedLines,
  howItRanLines,
  listWorkedRing,
  onCallNote,
  pulseFigures,
  retriesNote,
  RING_RADIUS,
  type OverviewFigure,
} from '../../utils/agencyCampaignOverview';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';
import styles from './AgencyCampaignDetailPage.module.css';

const ACTION_META: Record<Action, { label: string; icon: typeof Play; danger?: boolean }> = {
  start: { label: 'Start dialing', icon: Play },
  pause: { label: 'Pause', icon: Pause },
  resume: { label: 'Resume', icon: Play },
  stop: { label: 'Stop', icon: Square, danger: true },
};

/** Only `stop` is irreversible, so only `stop` interrupts with a confirm. */
const CONFIRM_COPY: Partial<Record<Action, { title: string; message: string }>> = {
  stop: {
    title: 'Stop this campaign?',
    message:
      'No new calls will be placed. Calls already in progress will finish normally, and the '
      + 'campaign moves to “Stopping” until they do. A stopped campaign cannot be restarted.',
  },
};

/**
 * One cell of the pulse strip.
 *
 * The strip is deliberately one card rather than six tiles: these six numbers
 * are read as a sentence — how far through the list, how many dials that took,
 * how many reached anyone, how many were real conversations, how many counted,
 * and how many are up right now — and six bordered boxes invite them to be read
 * as six unrelated facts.
 *
 * `data-known` rather than a second class: an absent number is styled down
 * because it is a statement about our knowledge, not about the campaign.
 */
function PulseCell({
  label,
  figure,
  tone,
  testId,
}: {
  label: string;
  figure: OverviewFigure;
  tone?: 'accent' | 'live';
  testId: string;
}) {
  const cell = tone === 'live' ? `${styles.pulseCell} ${styles.pulseLive}` : styles.pulseCell;
  const value = tone === 'accent' ? `${styles.pulseValue} ${styles.pulseAccent}` : styles.pulseValue;
  return (
    <div className={cell} data-testid={testId}>
      <span className={styles.kicker}>{label}</span>
      <span className={value} data-known={String(figure.known)}>{figure.value}</span>
      {figure.sub && <span className={styles.pulseSub}>{figure.sub}</span>}
    </div>
  );
}

/** Statuses where the numbers move on their own and are worth re-reading. */
const LIVE_STATUSES = new Set(['running', 'stopping']);
const REFRESH_MS = 10_000;

export function AgencyCampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();

  /*
    Which of this page's three panels is on screen, read from the URL rather
    than held in state: `…/campaigns/:id`, `…/performance` and `…/agents` all
    mount this component, so a section survives a refresh and can be sent to a
    colleague. See `campaignPanelFromPath`.
  */
  const panel = campaignPanelFromPath(pathname);

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [stats, setStats] = useState<AgencyCampaignStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Action | null>(null);
  const [confirming, setConfirming] = useState<Action | null>(null);
  const [retryOpen, setRetryOpen] = useState(false);
  /** Bumped by the Refresh control so the chart sections re-read too. */
  const [seriesRefresh, setSeriesRefresh] = useState(0);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  /*
    `runAction` is a memoized callback whose dependency array (below) does not
    include `campaign` — reading the `campaign` state variable directly inside
    it would close over whatever `campaign` was at the callback's last
    recreation, not the value at click time. A ref (the same pattern `loadRef`
    already uses just below) is what lets it read the status the request is
    actually leaving FROM.
  */
  const campaignRef = useRef<AgencyCampaign | null>(campaign);
  campaignRef.current = campaign;
  /**
   * Synchronous with the click. `setBusy` is a render, so two Start clicks in
   * the same frame both see `busy === null` and both POST — the 7× `/start`
   * 409 in chitboss UAT is that click, repeated, against a button that never
   * disabled. The ref is the lock the state cannot be.
   */
  const busyRef = useRef(false);
  /**
   * Monotonic token fencing in-flight GETs. A draft does not poll, so the
   * refresh that hides Start is `visibilitychange` / `focus` — and those can
   * overlap a Start that already succeeded. Without this, the late GET paints
   * `draft` back over `running` and the button that just 409'd is enabled
   * again: the 7× loop this page exists to close.
   */
  const loadTokenRef = useRef(0);

  /**
   * `agency.supervise`, floored at `account_admin` (`MAG-136`).
   *
   * These controls used to check `proxy.schedules.write` — an `operator`-level
   * permission borrowed because that was what master's lifecycle routes happened
   * to gate on. It is now a recorded decision that starting, pausing and stopping
   * a dialing campaign is a supervisory act, and master's four lifecycle proxies
   * gate on `agency.supervise` to match. The UI gate has to be the API gate:
   * checking the looser one here would show an `operator` four buttons that 403.
   */
  const canControl = hasPermission(role, 'agency.supervise');
  // Floors at `agent`, so everyone above holds it too — a supervisor covering a
  // shift is the case this exists for.
  const canJoinStation = hasPermission(role, 'agency.station.connect');
  /*
    Master names BOTH permissions on `POST .../retry`: creating a campaign
    (`agency.campaigns.write`) and acting on another campaign's call results
    (`agency.supervise`). Same `account_admin` floor today; naming both keeps
    this affordance correct if either moves.
  */
  const canRetry = canControl && hasPermission(role, 'agency.campaigns.write');

  const load = useCallback(async (): Promise<AgencyCampaign | null> => {
    if (!id || !tenantId || !accountId) return null;
    const token = ++loadTokenRef.current;
    setError(null);
    try {
      // Both together: the status drives which controls render, and stale
      // counters beside a fresh status is the combination that misleads.
      const [nextCampaign, nextStats] = await Promise.all([
        getAgencyCampaign(id, tenantId, accountId),
        getAgencyCampaignStats(id, tenantId, accountId),
      ]);
      if (token !== loadTokenRef.current) {
        // A newer load (or a Start preflight) owns the paint. This body is
        // still what THIS request observed — returning `campaignRef` here
        // would report a stale `draft` to an awaiting Start click after a
        // focus refresh had already superseded the token.
        return nextCampaign;
      }
      // Written here as well as during render: a 409 handler awaits this
      // function and must see the status it just fetched, not the one the
      // last paint closed over.
      campaignRef.current = nextCampaign;
      setCampaign(nextCampaign);
      setStats(nextStats);
      setLastUpdatedAt(new Date());
      return nextCampaign;
    } catch (err: unknown) {
      if (token !== loadTokenRef.current) return campaignRef.current;
      setError(err instanceof Error ? err.message : 'Could not load this campaign.');
      return null;
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, [id, tenantId, accountId]);

  /**
   * Campaign row only — the Start / Resume preflight and the 409 repair.
   * `load()` waits on stats as well (the page paints them together), and a
   * stats outage must not turn a fresh `running` into `null` and fall back
   * to the stale `draft` that MAG-134 would have hidden.
   */
  const refreshCampaign = useCallback(async (): Promise<AgencyCampaign | null> => {
    if (!id || !tenantId || !accountId) return null;
    try {
      const nextCampaign = await getAgencyCampaign(id, tenantId, accountId);
      loadTokenRef.current += 1;
      campaignRef.current = nextCampaign;
      setCampaign(nextCampaign);
      return nextCampaign;
    } catch {
      return campaignRef.current;
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Poll only while something is actually moving — but "moving" is not the same
   * as "running".
   *
   * Status alone is the wrong predicate. A **paused** campaign places no new
   * calls and its in-flight ones keep going to their natural end, so its
   * counters continue to change for as long as the longest live call. Keying
   * the poll on status meant "Live now", "Done" and "Connected" froze the
   * instant a supervisor pressed Pause — exactly when they are watching to see
   * the calls drain, and exactly when a frozen number reads as a finished
   * drain.
   *
   * So: poll while the status implies movement OR while the server says
   * attempts are still live. `attempts_live` comes from core's own count, not
   * from anything derived here.
   *
   * **Anyone on the floor is also movement** (`MAG-148`). Agent state changes
   * without any attempt being live — a break ends, a wrap-up is submitted, a
   * station drops — and §C.4 is a live view of exactly those. The durations tick
   * client-side from `state_since`, so an unpolled floor does not *look* frozen;
   * it looks current and reports states the agents left minutes ago, which is
   * worse. This is not the same predicate as `attempts_live`: a paused campaign
   * draining its last call still has its whole floor sitting in `available`.
   */
  const loadRef = useRef(load);
  loadRef.current = load;

  /**
   * A draft (or a drained pause) does not poll — nothing is moving. That is
   * also the view that still shows Start / Resume after another tab, or this
   * tab's own first click, has already moved the campaign. Coming back to the
   * window is the moment to learn that, so MAG-134 can hide the button instead
   * of letting the click become core's 409.
   */
  useEffect(() => {
    const refetchIfVisible = () => {
      if (document.visibilityState === 'visible') void loadRef.current();
    };
    document.addEventListener('visibilitychange', refetchIfVisible);
    // Two side-by-side windows both stay `visible`, so `visibilitychange`
    // never fires when the supervisor clicks back into this one. `focus`
    // is the event that does — AuthContext listens to both for the same
    // reason.
    window.addEventListener('focus', refetchIfVisible);
    return () => {
      document.removeEventListener('visibilitychange', refetchIfVisible);
      window.removeEventListener('focus', refetchIfVisible);
    };
  }, []);

  const statusMoving = campaign ? LIVE_STATUSES.has(campaign.status) : false;
  const attemptsInFlight = (stats?.attempts_live ?? 0) > 0;
  const agentsOnFloor = (stats?.agents?.length ?? 0) > 0;
  const shouldPoll = statusMoving || attemptsInFlight || agentsOnFloor;
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => void loadRef.current(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [shouldPoll]);

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
         * Start / Resume from a stale view is the UAT bug: MAG-134 would
         * have hidden the button if we held `running`. Re-read before
         * POSTing so the click does not become core's 409. Pause / Stop
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
        loadTokenRef.current += 1;
        campaignRef.current = updated;
        setCampaign(updated);
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
         * the campaign moved underneath us (stale Start / Resume), or D9's
         * one-running-campaign-per-account rule refused the start. The
         * first is repaired by refetching — MAG-134 then replaces the
         * button, and a conflict toast on a control that has just
         * disappeared is the UAT friction. The second is a real refusal
         * (this campaign is still a draft) and still has to be said.
         */
        let reportFailure = true;
        if (statusCode === 409) {
          const latest = await refreshCampaign();
          const stillOffered = latest ? isLifecycleActionEnabled(latest.status, action) : true;
          if (stillOffered) {
            showErrorToast(err, 'Could not change the campaign state.');
          } else {
            reportFailure = false;
          }
        } else {
          showErrorToast(err, 'Could not change the campaign state.');
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
    [id, tenantId, accountId, load, refreshCampaign, showToast, showErrorToast, panel],
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
    Every figure on the Overview panel is derived in `agencyCampaignOverview`,
    which is pure and unit-tested. Nothing below divides, sums or formats — a
    derivation inlined into JSX is a claim about the campaign that no test can
    reach, and this payload is entirely optional-and-nullable fields where a
    missing number must never render as a zero.
  */
  const ring = listWorkedRing(stats);
  const funnel = contactFunnel(stats);
  const pulse = pulseFigures(stats);
  const retries = retriesNote(stats);
  // The ENDING, not `terminal` — the note names which of the two it is, and a
  // boolean here is what made it tell a Completed campaign it had stopped.
  const stuck = onCallNote(funnel, ending);
  const barWithheld = funnelBarWithheldNote(funnel);
  const floor = floorSummary(stats);
  const howItRan = howItRanLines(campaign);

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
    than dashed — `campaignTimeline` returns `null` for anything this master did
    not carry, and "Started —" reads as a failed read (or, on a campaign that
    genuinely never started, as a wrong one).
  */
  const timelineParts = [timeline.started, timeline.ran].filter(
    (part): part is string => part !== null,
  );
  /*
    Only ever on a terminal campaign, and only when there is something to say.
    `howItEndedLines` returns `[]` rather than a list of dashes, so the whole
    block — heading and divider included — is skipped instead of announcing an
    ending nobody can read.
  */
  const howItEnded = ending ? howItEndedLines(campaign, stats, ending, now) : [];

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          { label: campaign.name },
        ]}
      />

      <header className={styles.header}>
        <div className={styles.headerCopy}>
          <div className={styles.headerMain}>
            <h1 className={styles.title}>{campaign.name}</h1>
            <AgencyCampaignStatusBadge status={campaign.status} />
          </div>
          <p className={styles.updated}>
            {lastUpdatedAt
              ? `Updated ${lastUpdatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
              : 'Loading latest activity…'}
            {shouldPoll ? ' · Auto-refreshing' : ''}
          </p>
          {/*
            The campaign's OWN clock, beneath the console's. "Updated 10:23" is
            when this screen last read the server; this is when the campaign
            started and how long it has been going — two different facts that
            were being answered by one line, which is how a supervisor comes to
            read a refresh time as a start time.

            `timeline.ended` and `timeline.actor` are deliberately not here:
            when it stopped and who stopped it belong to the rail's "How it
            ended" block, beside the campaign they describe.
          */}
          {timelineParts.length > 0 && (
            <p className={styles.timeline} data-testid="campaign-timeline">
              {timelineParts.join(' · ')}
            </p>
          )}
          {/*
            ── Lineage lives in the HEADER, not in an eighth tab ─────────────
            `agencyCampaignTabs.ts` states the workspace's rule: the header
            holds what CHANGES the campaign and each tab answers one question.
            Lineage answers none — it is navigation, and "this is Retry 1 of
            something else" is the fact a supervisor needs before they read any
            number on the page, not a destination they should have to visit to
            discover.

            It renders nothing at all when the campaign is in no chain, which is
            almost every campaign; see the component for why it fetches anyway.
          */}
          <CampaignLineageStrip
            campaignId={campaign.id}
            tenantId={tenantId ?? undefined}
            accountId={accountId ?? undefined}
          />
        </div>

        <div className={styles.actions}>
          {canControl
            && controls.map(({ action, disabledReason }) => {
              const meta = ACTION_META[action];
              return (
                <span key={action} className={styles.control}>
                  <button
                    type="button"
                    className={`${styles.actionButton} ${meta.danger ? 'btn-danger' : 'btn-primary'}`}
                    onClick={() => onActionClick(action)}
                    disabled={busy !== null || disabledReason !== null}
                    title={disabledReason ?? undefined}
                  >
                    <meta.icon size={16} />
                    {busy === action ? 'Working…' : meta.label}
                  </button>
                  {disabledReason && (
                    <span className={styles.controlReason} data-testid={`control-reason-${action}`}>
                      {disabledReason}
                    </span>
                  )}
                </span>
              );
            })}
          {canControl && (
            <>
              {terminal ? (
                <Link
                  to="/agency/campaigns/new"
                  className={`${styles.actionButton} ${styles.secondaryAction}`}
                >
                  <Plus size={16} />
                  New campaign
                </Link>
              ) : (
                <Link
                  to={`/agency/campaigns/${campaign.id}/contacts/add`}
                  className={`${styles.actionButton} ${styles.secondaryAction}`}
                >
                  <Upload size={16} />
                  Add contacts
                </Link>
              )}
            </>
          )}
          {/*
            The second entry point into the retry dialog, and the one a
            supervisor reaches first: they are looking at the campaign that just
            finished, not at a filtered contacts list. Opened from here the
            dialog offers the default cohort — no answer, busy, and never
            dialed — which is what `origin="campaign"` names on screen, so a set
            nobody chose is never presented as one they did.

            Offered on every status rather than only on a terminal one: a paused
            campaign is a perfectly ordinary thing to retry part of, and a
            running one is told in the dialog that the child cannot start yet.
          */}
          {canRetry && (
            <button
              type="button"
              className={`${styles.actionButton} ${styles.secondaryAction}`}
              onClick={() => setRetryOpen(true)}
              data-testid="campaign-retry-action"
              title="Create a new campaign from the contacts this one did not reach"
            >
              <RotateCcw size={16} />
              Retry contacts
            </button>
          )}
          {/*
            The station entry point lives HERE, not in the sidebar, because
            `/station` is meaningless without a campaign — `AgentConsolePage`
            reads `?campaign=` and refuses without it. This is the only place in
            the workspace where an id is in scope.

            It leaves the agency shell for a full-viewport console with no way
            back, so it is styled as a secondary action and says what it does.
          */}
          {canJoinStation && (
            <Link
              to={`/station?campaign=${encodeURIComponent(campaign.id)}`}
              className={`${styles.actionButton} ${styles.stationAction}`}
              title="Join this campaign's pool and start taking its calls"
            >
              <Headphones size={16} />
              Join as agent
            </Link>
          )}
          <button
            type="button"
            className={`${styles.actionButton} ${styles.iconAction}`}
            onClick={() => {
              void load();
              /*
                The charts fetch separately and deliberately do not poll, so
                without this Refresh moved the counters and the "Updated" stamp
                while the day-by-day charts silently kept showing the older
                read. Bumped only here — never on the 10s poll, which must not
                re-request up to 92 buckets every tick.
              */
              setSeriesRefresh((n) => n + 1);
            }}
            aria-label="Refresh"
            title="Refresh campaign activity"
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>

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

      {/* No description line: core has no such column, so it was a paragraph
          that could only ever be empty. See the note on `AgencyCampaign`. */}

      {error && <ErrorAlert message={error} onRetry={() => void load()} />}

      {/*
        A blocker stays above every metric AND above the tab bar. It is the one
        thing on this screen that is worth reading before choosing what to read:
        a diagnosis that only appeared on the section you happened to be on
        would be invisible to the supervisor who opened Agents first. Capacity
        read-outs stay in the operational rail beside the agents they describe.
      */}
      <CampaignHealthStrip
        stats={stats}
        mode="diagnosis"
        campaignId={campaign.id}
        campaignStatus={campaign.status}
        role={role}
      />

      {/*
        The workspace's sections (`MAG-166`). Contacts, Call attempts, Activity
        and Settings used to be secondary buttons in the header row above —
        the same row that carries Stop — each gated on its own permission at the
        call site. They are tabs now, gated inside `CAMPAIGN_TABS` on the same
        permissions master enforces, which leaves the header holding only the
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
      />

      {panel === 'overview' && (
      <section className={styles.overview} aria-label="Campaign overview">
        {/*
          ── Zone A · the pulse strip ────────────────────────────────────────
          One row answering "how far, how well, how busy" before anything has to
          be scrolled to. It absorbs the three counters that used to sit under a
          "Dialing activity" rule at the bottom of the panel — attempts,
          connected and retries-queued — which is where a supervisor found them
          only after reading past the numbers they explain.
        */}
        <div className={`${styles.card} ${styles.pulse}`} aria-label="Campaign at a glance">
          <div className={styles.pulseRing} data-testid="total-contacts">
            <svg width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
              <circle className={styles.ringTrack} cx="36" cy="36" r={RING_RADIUS} fill="none" strokeWidth="9" />
              {/*
                Rotated so the arc starts at twelve o'clock, and `round`-capped
                so a 1% ring is still a visible mark rather than a stray pixel.
                A zero-length dash draws nothing at all, which is the right
                picture for a list nothing has touched.
              */}
              <circle
                className={styles.ringArc}
                cx="36"
                cy="36"
                r={RING_RADIUS}
                fill="none"
                strokeWidth="9"
                strokeLinecap="round"
                strokeDasharray={ring.dashArray}
                transform="rotate(-90 36 36)"
              />
              <text className={styles.ringLabel} x="36" y="40" textAnchor="middle">{ring.label}</text>
            </svg>
            <div>
              <span className={styles.kicker}>List worked</span>
              <p className={styles.pulseRingTotal}>{ring.caption}</p>
              {ring.known && (
                <p className={`${styles.hint} ${styles.pulseRingHint}`}>
                  Completed, suppressed or exhausted.
                </p>
              )}
            </div>
          </div>

          <PulseCell label="Dials placed" figure={pulse.dials} testId="pulse-dials" />
          <PulseCell label="Reached someone" figure={pulse.reached} testId="pulse-reached" />
          <PulseCell label="Spoke to a person" figure={pulse.humans} testId="pulse-humans" />
          <PulseCell label="Counted as a win" figure={pulse.wins} tone="accent" testId="pulse-wins" />
          {/*
            `active-attempts` keeps its test id from the operational rail it
            moved out of: it is the same figure, read for the same reason, and
            the poll predicate's own coverage waits on it.
          */}
          {/*
            The one figure in the strip whose LABEL is a tense. On a stopped
            campaign "On the line now" over a green-tinted 0 is a live read-out
            on a dead campaign — the rail beside it already switches to "The
            account right now" and hides the on-shift block on terminal, and this
            cell was the last thing `terminal` did not reach.

            "Still on the line" reads correctly either way: 0 is the expected
            answer and says so, and a non-zero is the same contradiction the
            funnel's stuck note names one panel down.
          */}
          <PulseCell
            label={terminal ? 'Still on the line' : 'On the line now'}
            figure={pulse.live}
            tone={terminal ? undefined : 'live'}
            testId="active-attempts"
          />
        </div>

        <div className={styles.row2}>
          {/*
            ── Zone B · the contact funnel ───────────────────────────────────
            One proportional bar instead of five equal boxes. The five states
            are simultaneous, not sequential, and equal boxes made 550 completed
            look the same size as 3 in flight — the one comparison the panel
            exists to make.
          */}
          <section className={styles.card} aria-labelledby="campaign-contacts-heading">
            <div className={styles.cardHead}>
              <div>
                <h2 className={styles.cardTitle} id="campaign-contacts-heading">
                  {terminal ? 'Where the contacts finished' : 'Where the contacts stand'}
                </h2>
                {/*
                  Neither sentence states a count.

                  "…exactly one of these five states" was false the moment a
                  contact was on a call — the roster has six states and the key
                  now lists the sixth when it has something to say — and a
                  sentence that counts the rows beneath it is a sentence that
                  goes stale every time the key changes.

                  "Nothing moves again" overclaimed in the other direction. A
                  finished campaign places no NEW calls, which is not the same as
                  nothing moving: the retries note directly below this can
                  report a queued retry scheduled days out, and the stuck note
                  beside it can report a contact still marked as on a call. Two
                  notes contradicting the sentence they sit under is worse than
                  a sentence that claims less.

                  "Finished", not "stopped": `terminal` is true for `completed`
                  as well, and this caption sits under a badge that says which.
                  Naming one ending in a line that covers both is the conflation
                  `howItEndedLines` exists to avoid.
                */}
                <p className={styles.cardDesc}>
                  {terminal
                    ? 'Final positions. A finished campaign places no new calls.'
                    : 'Every contact is in exactly one of these states.'}
                </p>
              </div>
              <span className={styles.cardTag}>
                {terminal ? 'Final' : `${funnel.totalLabel} total`}
              </span>
            </div>

            <div className={styles.funnelBody}>
              {barWithheld === null ? (
                <div className={styles.funnelBar} role="img" aria-label={funnel.barLabel}>
                  {funnel.segments.map((segment) => (
                    <div
                      key={segment.key}
                      className={styles.funnelSeg}
                      data-state={segment.key}
                      style={{ width: `${segment.widthPercent}%` }}
                    />
                  ))}
                </div>
              ) : (
                <p className={styles.funnelEmpty}>{barWithheld}</p>
              )}

              {/*
                The track count comes from the cell count. The key is a row of
                equals and `contactFunnel` lists five states or six depending on
                whether contacts are on a call, so a fixed five tracks put the
                sixth cell alone on a second row at a fifth of the width — see
                the stylesheet's own note above `.funnelKey`.
              */}
              <div
                className={styles.funnelKey}
                data-testid="contact-funnel-key"
                data-count={funnel.cells.length}
              >
                {funnel.cells.map((cell) => (
                  <div
                    key={cell.key}
                    className={styles.funnelKeyCell}
                    data-testid={`contact-state-${cell.key}`}
                  >
                    <div className={styles.funnelKeyHead}>
                      <span className={styles.swatch} data-state={cell.key} />
                      <span className={styles.funnelKeyLabel}>{cell.label}</span>
                    </div>
                    <div className={styles.funnelKeyValue} data-known={String(cell.count !== null)}>
                      {cell.derived ? (
                        <span
                          className={styles.derivedMark}
                          title="Worked out from the other counts, not reported directly."
                        >
                          {cell.value}
                        </span>
                      ) : (
                        cell.value
                      )}
                      {cell.percentLabel && (
                        <span className={styles.funnelKeyPct}>{cell.percentLabel}</span>
                      )}
                    </div>
                    <span className={styles.hint}>{cell.hint}</span>
                  </div>
                ))}
              </div>

              {/*
                "Waiting" reads as "dialable now" and a queued retry is not.
                Stated beneath the state it qualifies rather than as a sixth
                counter, which is what it used to be.
              */}
              {retries && (
                <p className={styles.retriesNote}>
                  <RefreshCw size={16} aria-hidden="true" />
                  <span>{retries}</span>
                </p>
              )}

              {/*
                A contact still marked as being on a call, on a campaign that has
                stopped. The panel above is badged "Final" and the rail beside it
                reports nobody on the line and no lines in use, so this row is
                the one place those three can be seen to disagree.
              */}
              {stuck && (
                <p className={styles.stuckNote}>
                  <AlertTriangle size={16} aria-hidden="true" />
                  <span>{stuck}</span>
                </p>
              )}
            </div>
          </section>

          {/*
            ── Zone C · the rail ─────────────────────────────────────────────
            It renders on EVERY status. Removing it once a campaign stopped is
            what left the page one narrow column with a screen of white beside
            it — and a stopped campaign is the primary case for this panel, not
            an edge of it. What changes with the status is its contents: nobody
            is on the floor of a stopped campaign, so that block is omitted and
            the heading names what is left.
          */}
          <aside
            className={`${styles.card} ${styles.rail}`}
            aria-labelledby="account-guardrails-heading"
          >
            <div className={`${styles.cardHead} ${styles.railHeadBlock}`}>
              <div>
                <h2 className={styles.cardTitle} id="account-guardrails-heading">
                  {terminal ? 'The account right now' : 'Right now'}
                </h2>
                <p className={styles.cardDesc}>
                  {terminal
                    ? 'Live account-wide limits. These describe the account today, not this campaign.'
                    : 'The live floor, and the limits this campaign shares with the account.'}
                </p>
              </div>
              <Activity size={18} className={styles.railIcon} aria-hidden="true" />
            </div>

            {!terminal && (
              <>
                <div className={`${styles.railRow} ${styles.railRowFirst}`} data-testid="floor-summary">
                  <div className={styles.railHead}>
                    <span className={styles.kicker}>Agents on shift</span>
                    <span className={styles.railValue} data-known={String(floor.known)}>
                      {floor.onShiftLabel}
                    </span>
                  </div>

                  {floor.slices.length > 0 && (
                    <>
                      <div className={styles.stateBar} role="img" aria-label={floor.shiftSub ?? ''}>
                        {floor.slices.map((slice) => (
                          <div
                            key={slice.state}
                            className={styles.stateBarSeg}
                            data-state={slice.state}
                            style={{ width: `${slice.percent}%` }}
                          />
                        ))}
                      </div>
                      <div className={styles.stateKey}>
                        {floor.slices.map((slice) => (
                          <span key={slice.state} className={styles.stateKeyItem}>
                            <span className={styles.swatch} data-state={slice.state} />
                            <span>{slice.label}</span>
                            <span>{slice.count.toLocaleString()}</span>
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {/*
                    An unread floor and an empty one are different facts and
                    only one of them is news. A zero with no breakdown behind it
                    says nothing at all, so it says nothing.
                  */}
                  {!floor.known && (
                    <span className={styles.hint}>The live floor didn’t load.</span>
                  )}
                  {floor.known && floor.slices.length === 0 && floor.onShift === 0 && (
                    <span className={styles.hint}>
                      Nobody is at a station on this campaign right now.
                    </span>
                  )}
                </div>
                <div className={styles.divider} />
              </>
            )}

            <div className={styles.railReadouts}>
              <CampaignHealthStrip
                stats={stats}
                mode="readouts"
                campaignId={campaign.id}
                campaignStatus={campaign.status}
                role={role}
                finished={terminal}
              />
            </div>

            {/*
              ── "How it ended" ────────────────────────────────────────────
              ABOVE "How it ran", because on a campaign that has stopped the
              first question is when it ended and who ended it — a supervisor
              opening this page is usually asking whether the dialer stopped
              itself. The calling window below is context for that answer, not
              a competitor to it.

              Terminal only. On a live campaign the same facts are the header's
              "Running for …", and a rail block quoting an end time that has
              not happened yet would contradict the Stop button above it.
            */}
            {howItEnded.length > 0 && (
              <>
                <div className={styles.divider} />
                <div className={styles.railRow} data-testid="how-it-ended">
                  <span className={styles.kicker}>How it ended</span>
                  <div className={styles.howItRan}>
                    {howItEnded.map((line) => (
                      <div key={line.label} className={styles.railHead}>
                        <span className={styles.hint}>{line.label}</span>
                        <span className={styles.howItRanValue}>{line.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/*
              The campaign's own settings, restated where the numbers they
              explain are being read. A campaign that looks idle at 7pm was
              outside its calling window; a wrap-up allowance is the difference
              between an agent being free and being on shift. These come off the
              campaign row, so they survive a terminal campaign — which is the
              case the block was written for.
            */}
            {howItRan.length > 0 && (
              <>
                <div className={styles.divider} />
                <div className={styles.railRow}>
                  <span className={styles.kicker}>How it ran</span>
                  <div className={styles.howItRan}>
                    {howItRan.map((line) => (
                      <div key={line.label} className={styles.railHead}>
                        <span className={styles.hint}>{line.label}</span>
                        <span className={styles.howItRanValue}>{line.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </aside>
        </div>

        {/*
          ── Zone D · the time dimension ───────────────────────────────────────
          Every counter above is a lifetime total: they say where the list has
          got to and cannot tell a campaign that has been dialing all week from
          one that woke up an hour ago. This is the panel's answer to "is it
          dialing", so it gets the panel's full width — inside `row2` it would
          be squeezed into the funnel's column, and a day-by-day bar pair read
          at 60% of a screen is a shape nobody can read a trend off.

          It owns its own fetch, range picker and four states, so nothing is
          threaded into it beyond the campaign it is about.
        */}
        <CampaignSeriesSection
          campaignId={campaign.id}
          campaign={campaign}
          chart="activity"
          reloadToken={seriesRefresh}
        />
      </section>
      )}

      {/*
        §C.3's derived figures on their own section. They are read at a
        different moment from the counters — "is this campaign healthy" rather
        than "where has the list got to" — and putting them under the counters
        meant a supervisor scrolled past four numbers with denominators and
        exclusions on the way to the floor.
      */}
      {panel === 'performance' && (
        <section className={styles.panelBody} aria-label="Campaign performance">
          <CampaignPerformance stats={stats} wrapupSeconds={campaign.wrapup_seconds} />

          {/*
            The rate trend is a SIBLING of the card above, not a section inside
            it, and the reason is that `CampaignPerformance` has a second
            caller: `AgencyAnalyticsPage` renders it once per campaign down a
            list. A fetch inside that component would be one series request per
            row on a page that never asked the question — so the component stays
            a pure function of the stats it is handed, and the screen that DOES
            want the trend mounts it beside it.

            It answers what the readouts above cannot: every one of them is a
            lifetime average, which cannot tell a campaign that fell off this
            morning from one that has been steady all week.
          */}
          <CampaignSeriesSection
            campaignId={campaign.id}
            campaign={campaign}
            chart="rates"
            reloadToken={seriesRefresh}
          />
        </section>
      )}

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
          permission master floors all four assignment routes on, so the gate
          here is the gate there.
        */}
        <CampaignAgentAssignments
          campaignId={campaign.id}
          canSupervise={canControl}
          /*
            The floor's own data, handed over rather than fetched again — it is
            what lets the staffing list say "assigned, but not at this station".
            `undefined` agents means core produced no per-agent rows (or the
            stats read failed), which is NOT an empty floor, so it is passed
            through as `null` and the list claims nothing.
          */
          liveAgentUserIds={stats?.agents ? stats.agents.map((a) => a.agent_user_id) : null}
        />
      </div>
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
            Contract §8's default, used because this entry point has no filtered
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
