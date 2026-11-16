import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { CallsViews } from '../../components/agency/CallsViews';
import { LiveCallsTable } from '../../components/listen/LiveCallsTable';
import { CampaignWorkspace, type CampaignWorkspaceSection } from './campaign-detail/CampaignWorkspace';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * `/agency/campaigns/:id/calls/live` — the Calls tab's Live view (`docs/listening.md` §9): the
 * live table filtered to this campaign, without the Campaign column, in the campaign's workspace
 * (header, health strip, bar with Calls marked) like every campaign screen. "Summary | Live" above
 * it switches to the analytic panel (`CallsViews`).
 *
 * The workspace's own stats read gives the campaign's average handle time, so a call past twice it
 * shows amber here (the live list carries none).
 */
export default function AgencyCampaignLiveCallsPage() {
  const { id } = useParams<{ id: string }>();
  const { role } = useTenant();
  const [liveCount, setLiveCount] = useState<number | null>(null);
  if (!id) return null;

  return (
    <CampaignWorkspace
      campaignId={id}
      active="live"
      subnav={<CallsViews campaignId={id} active="live" role={role} liveCount={liveCount} />}
    >
      {(campaign, section) => (
        <LiveSection campaignId={id} campaign={campaign} section={section} onCount={setLiveCount} />
      )}
    </CampaignWorkspace>
  );
}

function LiveSection({
  campaignId,
  campaign,
  section,
  onCount,
}: {
  campaignId: string;
  campaign: AgencyCampaign | null;
  section: CampaignWorkspaceSection;
  onCount: (count: number | null) => void;
}) {
  // The Calls tab's second view: the bar tab it sits under names it.
  useCampaignCrumbs(campaignId, campaign, 'calls');
  return (
    <LiveCallsTable
      campaignId={campaignId}
      ahtSeconds={section.stats?.aht_seconds ?? null}
      headingLevel="h2"
      onCount={onCount}
    />
  );
}
