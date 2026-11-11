import type { AgencyCampaignStats } from '../../types/agency-campaign';
import type {
  AgencyHomeActiveStatus,
  AgencyHomeBoard,
  AgencyHomeCampaign,
  AgencyHomeCampaignStats,
} from '@magick-agency/contracts/api/agency/home';
import type { HomeCampaignRef } from '../../utils/agency/home';

/** Home's fixtures: a campaign, a stats payload with an empty, idle floor, and the board. */
export function campaign(id: string, status: AgencyHomeActiveStatus = 'running', name = `Campaign ${id}`): HomeCampaignRef {
  return { id, name, status };
}

export function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    stall: null,
    other_stalls: [],
    agents_live: 0,
    attempts_live: 0,
    abandoned_24h: 0,
    answered_24h: 0,
    abandonment_ceiling_pct: 3,
    agents_by_state: { offline: 0, available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0 },
    ...over,
  } as AgencyCampaignStats;
}

/** One campaign on the board: idle stats and no overdue callbacks unless given. */
export function onBoard(
  id: string,
  over: {
    status?: AgencyHomeActiveStatus;
    name?: string;
    stats?: AgencyHomeCampaignStats | null;
    overdue?: number | null;
  } = {},
): AgencyHomeCampaign {
  return {
    ...campaign(id, over.status ?? 'running', over.name),
    stats: over.stats === undefined ? stats() : over.stats,
    callbacks_overdue: over.overdue === undefined ? 0 : over.overdue,
  };
}

/** `GET /proxy/agency/home`: these campaigns, the total and "any campaign" following them unless given. */
export function board(
  campaigns: AgencyHomeCampaign[],
  over: Partial<Pick<AgencyHomeBoard, 'active_total' | 'any_campaign'>> = {},
): AgencyHomeBoard {
  return {
    campaigns,
    active_total: over.active_total ?? campaigns.length,
    any_campaign: over.any_campaign ?? campaigns.length > 0,
  };
}
