import { Link } from 'react-router-dom';
import { ChevronRight, Clock, Phone } from 'lucide-react';
import { formatRelativeTime } from '@magick-agency/web-ui/format';
import { lineagePositionLabel } from '../../../utils/agencyCampaignLineage';
import { campaignGroup, scheduleLabel } from '../../../utils/agencyCampaignsHome';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import styles from '../AgencyCampaignsPage.module.css';

/**
 * When it ran, in a few words. `started_at: null` is "the server says it never
 * started" and reads "Not started", as the contract asks; `undefined` is "not
 * carried", which says nothing rather than guess.
 */
function rowTiming(campaign: AgencyCampaign): string | null {
  const group = campaignGroup(campaign.status);
  if (group === 'draft') return 'Not started';
  if (group === 'finished' && campaign.ended_at) return `Ended ${formatRelativeTime(campaign.ended_at)}`;
  if (campaign.started_at) return `Started ${formatRelativeTime(campaign.started_at)}`;
  if (campaign.started_at === null) return 'Not started';
  return null;
}

export function CampaignRow({ campaign }: { campaign: AgencyCampaign }) {
  const schedule = scheduleLabel(campaign);
  const callerIds = campaign.caller_ids?.length ?? 0;
  const generation = campaign.retry_generation ?? 0;
  const meta = [rowTiming(campaign), generation > 0 ? lineagePositionLabel(generation) : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link to={`/agency/campaigns/${campaign.id}`} className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{campaign.name}</span>
        {meta && <span className={styles.rowMeta}>{meta}</span>}
      </div>
      <div className={styles.rowStatus}>
        <AgencyCampaignStatusBadge status={campaign.status} />
      </div>
      <div className={styles.rowDetail}>
        {/* Every campaign has calling hours (the columns are NOT NULL with
            defaults), so a missing one means the payload did not carry it,
            and the row says nothing rather than "none set". */}
        {schedule && (
          <span className={styles.rowFact}>
            <Clock size={13} aria-hidden="true" />
            {schedule}
          </span>
        )}
        {callerIds > 0 && (
          <span className={styles.rowFact}>
            <Phone size={13} aria-hidden="true" />
            {callerIds} {callerIds === 1 ? 'number' : 'numbers'}
          </span>
        )}
      </div>
      <ChevronRight size={16} className={styles.rowChevron} aria-hidden="true" />
    </Link>
  );
}
