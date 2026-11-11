import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';

/** Home's fixtures: a campaign and a `/stats` payload with an empty, idle floor. */
export function campaign(id: string, status: string = 'running', name = `Campaign ${id}`): AgencyCampaign {
  return { id, name, status } as AgencyCampaign;
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
