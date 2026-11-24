import { memo, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, Send, TriangleAlert } from 'lucide-react';
import { getAgencyCampaign } from '../../../api/agencyCampaigns';
import { useTenant } from '../../../contexts/TenantContext';
import { campaignCards, type LiveFloorCampaignCard } from '../../../utils/agency/liveFloor';
import type { HomeCampaignRead } from '../../../utils/agency/home';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { formatCount } from '../../../utils/format/number';
import { formatTimeOrDate } from '../../../utils/format/date';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import { useCampaignLifecycle } from '../campaign-detail/useCampaignLifecycle';
import { FloorPane } from './FloorPane';
import styles from './LiveFloor.module.css';

/** A time on today's date ("11:03 am"), else the date and time. */
const whenShort = (iso: string) => formatTimeOrDate(iso, new Date());

/**
 * Campaigns: one card per active campaign on the board (or the one picked), with its status, its
 * calls live, how much of its list is done (the Active cards' list-worked rule), its top stall,
 * and Pause or Resume. Every reader of Live floor holds `agency.supervise`, the campaign header's
 * gate for the lifecycle buttons (`canControl`), so the buttons need no other check. A card's
 * action is the header's own (`useCampaignLifecycle`: the click lock, the re-read before Resume,
 * the refusals and their toasts, and the warning before resuming a campaign the abandonment
 * guardrail paused or one over its ceiling, AW1–AW3); Pause asks for no confirmation there, so
 * none here.
 * The board is read again after a change, and at once when the card's re-read of the campaign
 * (before Resume, after a 409) finds a status other than the board's. `willPay` is each promise-recording campaign's
 * count from the promises summary (`willPayByCampaign`, B28b): its card says "71 will pay". A
 * `FloorPane`, like Needs you now beside it: many campaigns scroll inside the card, with "N more
 * campaigns below", rather than pushing the agents' panel down the page.
 */
export const CampaignsPanel = memo(function CampaignsPanel({
  reads,
  onChanged,
  willPay,
}: {
  reads: readonly HomeCampaignRead[];
  onChanged: () => void;
  willPay?: Readonly<Record<string, number>>;
}) {
  const cards = useMemo(() => campaignCards(reads, whenShort), [reads]);
  const running = reads.filter((r) => r.campaign.status === 'running').length;
  return (
    <FloorPane
      headingId="home-campaigns-heading"
      icon={Send}
      moreNoun="campaign"
      testId="home-campaigns-pane"
      title={(
        <>
          Campaigns
          {reads.length > 0 && <span className={styles.cardTitleNote}>{`${running} running`}</span>}
        </>
      )}
      head={<Link to="/agency/campaigns" className={styles.cardLink}>All campaigns</Link>}
    >
      {cards.length > 0 ? (
        <ul className={styles.campaignList} data-testid="home-campaigns">
          {cards.map((card) => (
            <CampaignCard key={card.campaign.id} card={card} onChanged={onChanged} willPay={willPay?.[card.campaign.id]} />
          ))}
        </ul>
      ) : (
        <p className={styles.quiet} data-testid="home-floor-empty">
          No campaign is running or paused.
        </p>
      )}
    </FloorPane>
  );
});

function CampaignCard({ card, onChanged, willPay }: {
  card: LiveFloorCampaignCard;
  onChanged: () => void;
  willPay?: number;
}) {
  const { tenantId, accountId } = useTenant();
  const { campaign } = card;
  // The status the board last said: the hook reads it at click time.
  const campaignRef = useRef<Pick<AgencyCampaign, 'status'>>({ status: campaign.status });
  campaignRef.current = { status: campaign.status };
  /*
    The hook re-reads the campaign before Resume and after a 409, and on either returns quietly
    when the action is no longer offered. Here that read is also how the board learns it is behind
    (the campaign moved in another tab): a status other than the board's reads the board again at
    once, so the card's button is repaired now, not on the next poll up to 10 s later.
  */
  const refreshCampaign = useCallback(async () => {
    if (!tenantId || !accountId) return null;
    let latest: AgencyCampaign;
    try {
      latest = await getAgencyCampaign(campaign.id, tenantId, accountId);
    } catch {
      return null;
    }
    if (latest.status !== campaignRef.current.status) onChanged();
    return latest;
  }, [campaign.id, tenantId, accountId, onChanged]);
  const lifecycle = useCampaignLifecycle({
    id: campaign.id,
    tenantId: tenantId ?? null,
    accountId: accountId ?? null,
    campaignRef,
    refreshCampaign,
    // The board is the page's one source: the change shows on its next read, asked for at once.
    commitCampaign: () => {},
    reload: onChanged,
    fromTab: 'live_floor',
  });
  const subParts = [card.callsLive, willPay !== undefined ? `${formatCount(willPay)} will pay` : null]
    .filter((part): part is string => Boolean(part));

  return (
    <li className={styles.campaign} data-pane-item data-testid={`home-campaign-${campaign.id}`}>
      <div className={styles.campaignTop}>
        <Link to={card.to} className={styles.campaignName2}>{campaign.name}</Link>
        {card.stale && <span className={styles.staleTag} data-testid="home-floor-stale">Not refreshed</span>}
        {/* Together, so on a narrow card they wrap as one, under the name. */}
        <span className={styles.campaignControls}>
          <AgencyCampaignStatusBadge status={campaign.status} />
          {card.action && (
            <button
              type="button"
              className={`btn-secondary ${styles.smallButton}`}
              onClick={() => lifecycle.onAction(card.action!)}
              disabled={lifecycle.busy !== null}
              aria-label={`${card.action === 'pause' ? 'Pause' : 'Resume'} ${campaign.name}`}
            >
              {card.action === 'pause' ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
              {lifecycle.busy ? 'Working…' : card.action === 'pause' ? 'Pause' : 'Resume'}
            </button>
          )}
        </span>
      </div>
      {card.statusLine && (
        <span className={styles.campaignSub} data-testid={`home-campaign-status-${campaign.id}`}>{card.statusLine}</span>
      )}
      {subParts.length > 0 && <span className={styles.campaignSub}>{subParts.join(' · ')}</span>}
      {card.stall && (
        <p className={styles.campaignStall}>
          <TriangleAlert size={14} aria-hidden="true" />
          <span>{card.stall}</span>
        </p>
      )}
      <div className={styles.progressHead}>
        <span>
          List done: <b>{card.list.label}</b>
        </span>
        <span>{card.list.caption}</span>
      </div>
      <div
        className={styles.bar}
        role="progressbar"
        aria-label={`List done, ${campaign.name}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={card.list.percent === null ? undefined : Math.round(card.list.percent)}
        aria-valuetext={card.list.known ? undefined : 'Not known yet'}
      >
        <i style={{ width: `${Math.min(Math.max(card.list.percent ?? 0, 0), 100)}%` }} />
      </div>
      {lifecycle.confirmDialog}
    </li>
  );
}
