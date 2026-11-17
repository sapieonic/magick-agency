import { useLocation } from 'react-router-dom';
import { visibleCallsViews, type CallsViewId } from '../../utils/agencyCampaignTabs';
import { useGateReaders } from '../../hooks/useGateReaders';
import type { Role } from '../../types/auth';
import { CampaignViewSwitch } from './CampaignViewSwitch';

interface CallsViewsProps {
  campaignId: string;
  /** The view showing: `…/calls` (Summary) or `…/calls/live` (Live). */
  active: CallsViewId;
  role: Role | undefined;
  /** The calls in progress, when the Live view has read them; null or absent says nothing. */
  liveCount?: number | null;
}

/**
 * The Calls tab's two views (`docs/listening.md` §9): "Summary" (`…/calls`, the analytic panel)
 * and "Live" (`…/calls/live`, the campaign's calls in progress). The same segmented control as
 * Call log's (`CampaignViewSwitch`), the bar marking Calls for both. Live is offered only with
 * the listening flag on (LS1); with one view left there is nothing to choose, so nothing renders.
 */
export function CallsViews({ campaignId, active, role, liveCount = null }: CallsViewsProps) {
  // The Summary link keeps the panels' range (`?range=…`); Live owns no query.
  const { search } = useLocation();
  return (
    <CampaignViewSwitch
      campaignId={campaignId}
      views={visibleCallsViews(role, useGateReaders().isFlagEnabled)}
      active={active}
      ariaLabel="Calls views"
      testId="calls-views"
      linkTestIdPrefix="calls-view"
      search={active === 'calls' ? search : ''}
      counts={{ live: liveCount }}
    />
  );
}
