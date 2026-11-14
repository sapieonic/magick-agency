import { Link } from 'react-router-dom';
import {
  Activity,
  Headphones,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Upload,
} from 'lucide-react';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import { CampaignLineageStrip } from '../../../components/agency/CampaignLineageStrip';
import { CampaignHistoryLink } from '../../../components/agency/CampaignHistoryLink';
import type { Role } from '../../../types/auth';
import {
  agencyCampaignControls,
  campaignEnding,
  PAUSE_IN_FLIGHT_NOTE,
  showsPauseInFlightNote,
  type AgencyCampaignAction as Action,
} from '../../../utils/agencyCampaignControls';
import { campaignTimeline } from '../../../utils/agency/overview/lifecycle';
import { concurrencyLine } from '../../../utils/agencyCampaignsHome';
import { formatClockTime } from '../../../utils/format/date';
import type { AgencyCampaign, AgencyCampaignConcurrency } from '../../../types/agency-campaign';
import styles from '../AgencyCampaignDetailPage.module.css';

const ACTION_META: Record<Action, { label: string; icon: typeof Play; danger?: boolean }> = {
  start: { label: 'Start dialling', icon: Play },
  pause: { label: 'Pause', icon: Pause },
  resume: { label: 'Resume', icon: Play },
  stop: { label: 'Stop', icon: Square, danger: true },
};

/** Beside the header's "Updated" stamp while the page polls (see the stamp). */
export const HEADER_POLL_NOTE = 'status and agents auto-refresh';

interface CampaignDetailHeaderProps {
  campaign: AgencyCampaign;
  /** When this screen last read the server, or `null` before the first answer. */
  lastUpdatedAt: Date | null;
  /** The page is polling — said beside the stamp. */
  autoRefreshing?: boolean;
  /**
   * The stats' `concurrency` block, said through `concurrencyLine` against
   * `campaign.status` (the status the badge shows, not the stats' copy of it).
   * Absent or `null` on a draft, a finished campaign or an older server, and on a
   * page that reads no stats (Settings).
   */
  concurrency?: AgencyCampaignConcurrency | null;
  tenantId: string | null;
  accountId: string | null;
  /** `agency.supervise`: the lifecycle buttons. */
  canControl: boolean;
  /**
   * `agency.campaigns.write`: Add contacts (the ingest routes' permission), or New campaign in
   * its place once the campaign has ended. Not `canControl`: an upload is not a supervisory act.
   */
  canAddContacts: boolean;
  /** The lifecycle action in flight, which disables every button. */
  busy: Action | null;
  onAction: (action: Action) => void;
  /** Retry contacts, offered only when given: by the page that owns the retry dialog, to a role allowed it. */
  onRetry?: () => void;
  canJoinStation: boolean;
  /** For History, which follows its page's own gate (`audit.read`), not `canControl`. */
  role: Role | undefined;
  onRefresh: () => void;
  /** On History itself (`CampaignWorkspace` with `active="activity"`): its button is marked as where you are. */
  historyCurrent?: boolean;
}

/**
 * The campaign's header on every Monitor tab and on Settings: its title, status, clocks and
 * lineage on the left, and on the right
 * every affordance that CHANGES the campaign: the lifecycle controls, Add
 * contacts / New campaign, Retry contacts, Join as agent and Refresh; and
 * History, the campaign's activity trail (decision IN14). The page owns the state those
 * controls act on (`useCampaignLifecycle`); beneath the header, the note that a pause stops
 * new calls only.
 */
export function CampaignDetailHeader({
  campaign,
  lastUpdatedAt,
  autoRefreshing,
  concurrency,
  tenantId,
  accountId,
  canControl,
  canAddContacts,
  busy,
  onAction,
  onRetry,
  canJoinStation,
  role,
  onRefresh,
  historyCurrent = false,
}: CampaignDetailHeaderProps) {
  const linesInUse = concurrencyLine(campaign.status, concurrency);
  const controls = agencyCampaignControls(campaign.status);
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
    The two clock facts, in reading order, with the absent ones dropped rather
    than dashed — `campaignTimeline` returns `null` for anything this server did
    not carry, and "Started —" reads as a failed read (or, on a campaign that
    genuinely never started, as a wrong one). One `now` for the render: the
    page re-renders every 10s from the poll, which is what keeps "Running for
    6 hours" honest.
  */
  const timeline = campaignTimeline(campaign, ending, new Date());
  const timelineParts = [timeline.started, timeline.ran].filter(
    (part): part is string => part !== null,
  );
  return (
    <>
    <header className={styles.header}>
      <div className={styles.headerCopy}>
        <div className={styles.headerMain}>
          <h1 className={styles.title}>{campaign.name}</h1>
          <AgencyCampaignStatusBadge status={campaign.status} />
        </div>
        <p className={styles.updated}>
          {lastUpdatedAt
            ? `Updated ${formatClockTime(lastUpdatedAt)}`
            : 'Loading latest activity…'}
          {/*
            Says WHAT refreshes: this page's poll re-reads the campaign and its
            floor, never the tab's figures below, whose own stamp says whether
            they refresh. A bare "Auto-refreshing" here sat above "not refreshing"
            in the range bar and read as a contradiction.
          */}
          {autoRefreshing ? ` · ${HEADER_POLL_NOTE}` : ''}
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
          The account's lines, beneath the campaign's clock: several campaigns can
          run at once and share them (decisions MC7), so "why is this campaign
          dialling less than its agents could take" is answered here, on every tab.
          Not a live region: it changes on every poll.
        */}
        {linesInUse && (
          <p className={styles.lines} data-testid="campaign-lines">
            {linesInUse}
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

      {/*
        On a phone the lifecycle buttons keep their words and everything after
        them shrinks to its icon (the label stays as the accessible name and the
        tooltip), so the row is two lines at most and the tabs stay on the first
        screen. They used to stack a full-width row each, about 800px of buttons.
      */}
      <div className={styles.actions} data-testid="campaign-actions">
        {canControl
          && controls.map(({ action, disabledReason }) => {
            const meta = ACTION_META[action];
            return (
              <span key={action} className={styles.control}>
                <button
                  type="button"
                  className={`${styles.actionButton} ${meta.danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => onAction(action)}
                  disabled={busy !== null || disabledReason !== null}
                  title={disabledReason ?? undefined}
                >
                  <meta.icon size={16} aria-hidden="true" />
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
        {canAddContacts && (
          <>
            {terminal ? (
              <Link
                to="/agency/campaigns/new"
                className={`${styles.actionButton} ${styles.secondaryAction}`}
                title="New campaign"
              >
                <Plus size={16} aria-hidden="true" />
                <span className={styles.actionLabel}>New campaign</span>
              </Link>
            ) : (
              <Link
                to={`/agency/campaigns/${campaign.id}/contacts/add`}
                className={`${styles.actionButton} ${styles.secondaryAction}`}
                title="Add contacts"
              >
                <Upload size={16} aria-hidden="true" />
                <span className={styles.actionLabel}>Add contacts</span>
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
          running one's child can run beside it (the dialog says how).
        */}
        {onRetry && (
          <button
            type="button"
            className={`${styles.actionButton} ${styles.secondaryAction}`}
            onClick={onRetry}
            data-testid="campaign-retry-action"
            title="Create a new campaign from the contacts this one did not reach"
          >
            <RotateCcw size={16} aria-hidden="true" />
            <span className={styles.actionLabel}>Retry contacts</span>
          </button>
        )}
        {/*
          The station entry point lives HERE, not in the sidebar, because
          `/station` is meaningless without a campaign — `AgentConsolePage`
          reads `?campaign=` and refuses without it. This is the only place in
          the workspace where an id is in scope.

          It leaves the console shell for a full-viewport console with no way
          back, so it is styled as a secondary action and says what it does.
        */}
        {canJoinStation && (
          <Link
            to={`/station?campaign=${encodeURIComponent(campaign.id)}`}
            className={`${styles.actionButton} ${styles.stationAction}`}
            title="Join this campaign's pool and start taking its calls"
          >
            <Headphones size={16} aria-hidden="true" />
            <span className={styles.actionLabel}>Join as agent</span>
          </Link>
        )}
        {/*
          History (the activity trail) left the tab bar for here (decision
          IN14): who changed what is a fact about the campaign, read now and
          then, not one of the questions the tabs answer.
        */}
        <CampaignHistoryLink campaignId={campaign.id} role={role} current={historyCurrent} compactOnPhone />
        <button
          type="button"
          className={`${styles.actionButton} ${styles.iconAction}`}
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh campaign activity"
        >
          <RefreshCw size={17} aria-hidden="true" />
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
    </>
  );
}
