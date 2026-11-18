import { useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Pause, Play, Send, TriangleAlert } from 'lucide-react';
import { formatDate } from '@magick-agency/web-ui/format';
import { getAgencyCampaign } from '../../../api/agencyCampaigns';
import { useTenant } from '../../../contexts/TenantContext';
import { campaignCards, type LiveFloorCampaignCard } from '../../../utils/agency/liveFloor';
import type { HomeCampaignRead } from '../../../utils/agency/home';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { formatCount } from '../../../utils/format/number';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import { useCampaignLifecycle } from '../campaign-detail/useCampaignLifecycle';
import styles from './LiveFloor.module.css';

/**
 * What a later phase adds to a card, each optional (Phase 2): "71 will pay" from the promises
 * read, and who paused a paused campaign and when, from the board.
 */
export interface CampaignCardExtras {
  willPay?: number;
  pausedBy?: { name: string; at: string };
}

/**
 * Campaigns: one card per active campaign on the board (or the one picked), with its status, its
 * calls live, how much of its list is done (the Active cards' list-worked rule), its top stall,
 * and Pause or Resume. Every reader of Live floor holds `agency.supervise`, the campaign header's
 * gate for the lifecycle buttons (`canControl`), so the buttons need no other check. A card's
 * action is the header's own (`useCampaignLifecycle`: the click lock, the re-read before Resume,
 * the refusals and their toasts); Pause and Resume ask for no confirmation there, so none here.
 * The board is read again after a change. `extras` is Phase 2's seam, by campaign id.
 */
export function CampaignsPanel({
  reads,
  onChanged,
  extras,
}: {
  reads: readonly HomeCampaignRead[];
  onChanged: () => void;
  extras?: Readonly<Record<string, CampaignCardExtras>>;
}) {
  const cards = useMemo(() => campaignCards(reads, formatDate), [reads]);
  const running = reads.filter((r) => r.campaign.status === 'running').length;
  return (
    <section className={styles.card} aria-labelledby="home-campaigns-heading">
      <div className={styles.cardHead}>
        <h2 id="home-campaigns-heading" className={styles.cardTitle}>
          <Send size={18} aria-hidden="true" />
          Campaigns
          {reads.length > 0 && <span className={styles.cardTitleNote}>{`${running} running`}</span>}
        </h2>
        <Link to="/agency/campaigns" className={styles.cardLink}>All campaigns</Link>
      </div>
      {cards.length > 0 ? (
        <ul className={styles.campaignList} data-testid="home-campaigns">
          {cards.map((card) => (
            <CampaignCard key={card.campaign.id} card={card} onChanged={onChanged} extras={extras?.[card.campaign.id]} />
          ))}
        </ul>
      ) : (
        <p className={styles.quiet} data-testid="home-floor-empty">
          No campaign is running or paused.
        </p>
      )}
    </section>
  );
}

function CampaignCard({ card, onChanged, extras }: {
  card: LiveFloorCampaignCard;
  onChanged: () => void;
  extras?: CampaignCardExtras;
}) {
  const { tenantId, accountId } = useTenant();
  const { campaign } = card;
  // The status the board last said: the hook reads it at click time.
  const campaignRef = useRef<Pick<AgencyCampaign, 'status'>>({ status: campaign.status });
  campaignRef.current = { status: campaign.status };
  const refreshCampaign = useCallback(async () => {
    if (!tenantId || !accountId) return null;
    try {
      return await getAgencyCampaign(campaign.id, tenantId, accountId);
    } catch {
      return null;
    }
  }, [campaign.id, tenantId, accountId]);
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
  const subParts = [card.callsLive, extras?.willPay !== undefined ? `${formatCount(extras.willPay)} will pay` : null]
    .filter((part): part is string => Boolean(part));

  return (
    <li className={styles.campaign} data-testid={`home-campaign-${campaign.id}`}>
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
      {extras?.pausedBy && campaign.status === 'paused' && (
        <span className={styles.campaignSub}>{`Paused by ${extras.pausedBy.name} at ${extras.pausedBy.at}`}</span>
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
