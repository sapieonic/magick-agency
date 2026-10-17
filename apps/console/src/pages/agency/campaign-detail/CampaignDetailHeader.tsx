import { Link } from 'react-router-dom';
import {
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
import type {
  AgencyCampaignAction as Action,
  agencyCampaignControls,
} from '../../../utils/agencyCampaignControls';
import { formatClockTime } from '../../../utils/format/date';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import styles from '../AgencyCampaignDetailPage.module.css';

const ACTION_META: Record<Action, { label: string; icon: typeof Play; danger?: boolean }> = {
  start: { label: 'Start dialing', icon: Play },
  pause: { label: 'Pause', icon: Pause },
  resume: { label: 'Resume', icon: Play },
  stop: { label: 'Stop', icon: Square, danger: true },
};

interface CampaignDetailHeaderProps {
  campaign: AgencyCampaign;
  /** When this screen last read the server, or `null` before the first answer. */
  lastUpdatedAt: Date | null;
  /** The page is polling — said beside the stamp. */
  autoRefreshing: boolean;
  /** "Started …" / "Running for …", absent facts already dropped. */
  timelineParts: string[];
  tenantId: string | null;
  accountId: string | null;
  /** `agency.supervise`: the lifecycle buttons and the secondary actions. */
  canControl: boolean;
  controls: ReturnType<typeof agencyCampaignControls>;
  /** The lifecycle action in flight, which disables every button. */
  busy: Action | null;
  onAction: (action: Action) => void;
  terminal: boolean;
  canRetry: boolean;
  onRetry: () => void;
  canJoinStation: boolean;
  onRefresh: () => void;
}

/**
 * The campaign's title, status, clocks and lineage on the left, and on the right
 * every affordance that CHANGES the campaign: the lifecycle controls, Add
 * contacts / New campaign, Retry contacts, Join as agent and Refresh. Out of
 * `AgencyCampaignDetailPage`, which owns the state those controls act on.
 */
export function CampaignDetailHeader({
  campaign,
  lastUpdatedAt,
  autoRefreshing,
  timelineParts,
  tenantId,
  accountId,
  canControl,
  controls,
  busy,
  onAction,
  terminal,
  canRetry,
  onRetry,
  canJoinStation,
  onRefresh,
}: CampaignDetailHeaderProps) {
  return (
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
          {autoRefreshing ? ' · Auto-refreshing' : ''}
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
                  onClick={() => onAction(action)}
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
            onClick={onRetry}
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
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh campaign activity"
        >
          <RefreshCw size={17} />
        </button>
      </div>
    </header>
  );
}
