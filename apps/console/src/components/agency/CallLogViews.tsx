import { visibleCallLogViews, type CallLogViewId } from '../../utils/agencyCampaignTabs';
import { useGateReaders } from '../../hooks/useGateReaders';
import type { Role } from '../../types/auth';
import { CampaignViewSwitch } from './CampaignViewSwitch';

interface CallLogViewsProps {
  campaignId: string;
  /** The view showing: `/attempts` (Dialler calls) or `/manual-calls` (Soft-phone calls). */
  active: CallLogViewId;
  role: Role | undefined;
}

/**
 * Call log's two views (decision IN14): "Dialler calls" (`…/attempts`) and "Soft-phone
 * calls" (`…/manual-calls`), each still its own page and URL (`CampaignViewSwitch`).
 *
 * Each view is gated as its screen (`CAMPAIGN_TABS`); Soft-phone calls also needs the soft
 * phone's flag. With one view left there is nothing to choose, so nothing renders.
 */
export function CallLogViews({ campaignId, active, role }: CallLogViewsProps) {
  return (
    <CampaignViewSwitch
      campaignId={campaignId}
      views={visibleCallLogViews(role, useGateReaders().isFlagEnabled)}
      active={active}
      ariaLabel="Call log views"
      testId="call-log-views"
      linkTestIdPrefix="call-log-view"
    />
  );
}
