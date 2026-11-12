import type { AgencyCampaignStats } from '../../types/agency-campaign';
import type {
  AgencyAttentionAllocation,
  AgencyAttentionRangeFigures,
  AgencyAttentionSettings,
  AgencyAttentionStaffing,
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

/** The allocation's attention figures: nothing overdue, nobody away, unless given. */
export function allocationFacts(over: Partial<AgencyAttentionAllocation> = {}): AgencyAttentionAllocation {
  return {
    callbacks_overdue: 0,
    callbacks_overdue_unassigned: 0,
    callbacks_overdue_absent_owner: 0,
    held_by_absent: 0,
    absent_after_minutes: 15,
    ...over,
  };
}

/** Today's figures: no failures, nothing connected, unless given. */
export function todayFacts(over: Partial<AgencyAttentionRangeFigures> = {}): AgencyAttentionRangeFigures {
  return { carrier_failures: 0, recording: { connected: 0, recorded: 0 }, ...over };
}

/** The campaign's settings: recording off, calling hours set, unless given. */
export function settingsFacts(over: Partial<AgencyAttentionSettings> = {}): AgencyAttentionSettings {
  return {
    record_calls: false,
    calling_hours_default: false,
    calling_window_start: '09:00',
    calling_window_end: '20:00',
    calling_days: [1, 2, 3, 4, 5],
    ...over,
  };
}

/** One agent assigned and on the floor. */
export const STAFFED: AgencyAttentionStaffing = { staffed: 1, online: 1 };

/** One campaign on the board: idle stats, one agent on the floor and nothing overdue unless given. */
export function onBoard(
  id: string,
  over: {
    status?: AgencyHomeActiveStatus;
    name?: string;
    stats?: AgencyHomeCampaignStats | null;
    overdue?: number | null;
    staffing?: AgencyAttentionStaffing | null;
    today?: AgencyAttentionRangeFigures | null;
    settings?: AgencyAttentionSettings;
  } = {},
): AgencyHomeCampaign {
  return {
    ...campaign(id, over.status ?? 'running', over.name),
    stats: over.stats === undefined ? stats() : over.stats,
    staffing: over.staffing === undefined ? STAFFED : over.staffing,
    allocation: over.overdue === null ? null : allocationFacts({ callbacks_overdue: over.overdue ?? 0 }),
    today: over.today === undefined ? todayFacts() : over.today,
    settings: over.settings ?? settingsFacts(),
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
