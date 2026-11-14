import type { AgencyCampaignLineage, AgencyCampaignStats } from '../../types/agency-campaign';

/**
 * What a campaign screen in `CampaignWorkspace` reads besides its own section: the
 * campaign (each test file mocks `getAgencyCampaign` with the campaign it is about), its
 * stats (the header's lines, the health strip, the bar's on-shift count) and its lineage
 * (the header's strip). A file that renders such a screen mocks `../../api/agencyCampaigns`
 * with all three and answers the last two with these.
 *
 * Quiet by default: nothing live and nobody on the floor, so a campaign that is not
 * running does not start the header's poll, and `agents: []` gives the bar its count
 * without a read of its own.
 */
export function workspaceStats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    campaign_id: 'camp-1',
    contacts_total: 100,
    contacts_pending: 40,
    contacts_in_flight: 0,
    contacts_completed: 55,
    contacts_suppressed: 2,
    contacts_exhausted: 3,
    retries_pending: 0,
    attempts_live: 0,
    attempts_total: 140,
    attempts_connected: 61,
    agents_live: 0,
    agents: [],
    stall: null,
    other_stalls: [],
    concurrency_limit: 5,
    concurrency_in_use: 0,
    abandonment_ceiling_pct: 3,
    ...over,
  };
}

/** A campaign in no chain: the lineage read answers with it alone, so the header's strip renders nothing. */
export function noLineage(campaignId = 'camp-1'): AgencyCampaignLineage {
  return {
    root_campaign_id: campaignId,
    campaigns: [
      {
        id: campaignId,
        name: 'Campaign',
        status: 'running',
        retry_generation: 0,
        parent_campaign_id: null,
        contacts_total: 100,
        created_at: '2026-08-01T09:00:00.000Z',
        started_at: '2026-08-01T10:00:00.000Z',
        ended_at: null,
      },
    ],
  };
}
