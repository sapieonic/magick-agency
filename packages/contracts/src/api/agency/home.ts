/**
 * Home's board: `GET /proxy/agency/home` (decision B28a). Everything Home, the sidebar's Home
 * badge and the Campaigns page's Active cards read about the account's active campaigns, in ONE
 * request instead of a list read plus a `/stats` read and the insights reads per campaign.
 *
 * - **Gate:** `agency.campaigns.read` (the campaign list's and `/stats`' floor, so a viewer or
 *   operator on the Campaigns page reads it), then the dialer flag (`403 feature_disabled`, the
 *   campaign reads' refusal). Account-scoped: the request's tenant and account, nothing else.
 * - **Withheld below `agency.supervise`:** `staffing`, `allocation`, `today` and `settings` come
 *   from the insights reads, which floor at `agency.supervise` (Home's own gate, `HOME_GATE`).
 *   Below it they are `null` on every campaign (withheld, not failed) and the server does not
 *   read them. Everything else is the list's and `/stats`' own.
 * - **Which campaigns:** the active ones ({@link AGENCY_HOME_ACTIVE_STATUSES}), in the Campaigns
 *   page's order (running, then stopping, then paused; newest first within a status), the first
 *   {@link AGENCY_HOME_CAMPAIGN_CAP} of them. `active_total` is the count before the cap.
 * - **Per campaign:** what the campaign Overview's "Needs your attention" rules read, so Home's
 *   list is the Overview's (B28a: Home never disagrees with the page it links to):
 *   - `stats`: the fields of `/stats` Home reads ({@link AgencyHomeCampaignStats}, the internal
 *     stats handler's own payload, so the stall and the floor are the health strip's);
 *   - `staffing`: assigned agents and how many are on the floor ({@link attentionStaffing} over
 *     the insights allocation's own staffing and state reads), read with the stats;
 *   - `allocation`: the insights allocation's overdue callbacks and the due contacts held by agents
 *     who are away ({@link attentionAllocation} of the allocation, through the same server cache
 *     the Insights tab and the Callbacks badge read);
 *   - `today`: carrier failures and recording over today in the campaign's zone, exactly what the
 *     Health tab serves for its "Today" range ({@link attentionRangeFigures});
 *   - `settings`: the campaign's recording and calling-hours settings, as the insights summary
 *     serves them.
 * - **A part that failed is `null`**, never a guess: a campaign whose stats read failed has
 *   `stats: null`, one whose allocation failed `allocation: null`, and so on. The console keeps
 *   what it showed for that campaign, and says so. The request as a whole fails only when the
 *   campaign list does.
 * - **Freshness:** stats and staffing of a campaign that is moving (running or stopping, or with
 *   live calls or agents on shift) are read on every request; a still campaign's are reused for up
 *   to a minute while its floor does not change. The allocation and today's figures are reused for
 *   up to a minute (follow-up counts, not a live queue). A transition or a settings edit misses
 *   every one at once (keyed by the campaign's status and `updated_at`).
 */
import type { AgencyCampaignStats } from './agency-campaign';
import type { AgencyInsightsAllocation, AgencyInsightsHealth, AgencyInsightsSettings } from './insights';

/** At most this many active campaigns are on the board (and get per-campaign reads). */
export const AGENCY_HOME_CAMPAIGN_CAP = 25;

/** The statuses Home calls active, in the board's order. */
export const AGENCY_HOME_ACTIVE_STATUSES = ['running', 'stopping', 'paused'] as const;
export type AgencyHomeActiveStatus = (typeof AGENCY_HOME_ACTIVE_STATUSES)[number];

/**
 * The fields of `/stats` (`AgencyCampaignStats`) Home reads: the top stall (the health strip's
 * diagnosis), the guardrail's 24-hour abandonment pair and its ceiling, and the floor.
 */
export type AgencyHomeCampaignStats = Pick<
  AgencyCampaignStats,
  'stall' | 'abandoned_24h' | 'answered_24h' | 'abandonment_ceiling_pct' | 'agents_live' | 'agents_by_state'
>;

// ── What the attention rules read (the Overview's and Home's) ────────────────────

/** The insights allocation's as-of-now figures the attention rules read. */
export interface AgencyAttentionAllocation {
  /** `totals.callbacks_overdue`. */
  callbacks_overdue: number;
  /** Of them, the ones nobody owns (`unassigned.callbacks_overdue`). */
  callbacks_overdue_unassigned: number;
  /** Of them, the ones whose owner is away (`at_risk.overdue_callbacks_absent_owner`). */
  callbacks_overdue_absent_owner: number;
  /** Due contacts held by agents away longer than `absent_after_minutes`, or no longer assigned. */
  held_by_absent: number;
  absent_after_minutes: number;
}

/** {@link AgencyAttentionAllocation} of an allocation: the one projection, used by the server and the console. */
export function attentionAllocation(
  allocation: Pick<AgencyInsightsAllocation, 'totals' | 'unassigned' | 'at_risk' | 'absent_after_minutes'>,
): AgencyAttentionAllocation {
  return {
    callbacks_overdue: allocation.totals.callbacks_overdue,
    callbacks_overdue_unassigned: allocation.unassigned.callbacks_overdue,
    callbacks_overdue_absent_owner: allocation.at_risk.overdue_callbacks_absent_owner,
    held_by_absent: allocation.at_risk.held_by_absent.reduce((n, row) => n + row.due, 0),
    absent_after_minutes: allocation.absent_after_minutes,
  };
}

/** The agents assigned to a campaign, and how many of them are on the floor now. */
export interface AgencyAttentionStaffing {
  staffed: number;
  /** Assigned agents whose state is anything but `offline`. */
  online: number;
}

/** {@link AgencyAttentionStaffing} of the allocation's agent rows (or rows built by its rule). */
export function attentionStaffing(agents: ReadonlyArray<{ staffed: boolean; state: string }>): AgencyAttentionStaffing {
  const staffed = agents.filter((a) => a.staffed);
  return { staffed: staffed.length, online: staffed.filter((a) => a.state !== 'offline').length };
}

/** The range figures the attention rules read (counted over a range: the Health tab's). */
export interface AgencyAttentionRangeFigures {
  carrier_failures: number;
  recording: { connected: number; recorded: number };
}

/** {@link AgencyAttentionRangeFigures} of a health read. */
export function attentionRangeFigures(
  health: Pick<AgencyInsightsHealth, 'carrier_failures' | 'recording'>,
): AgencyAttentionRangeFigures {
  return {
    carrier_failures: health.carrier_failures,
    recording: { connected: health.recording.connected, recorded: health.recording.recorded },
  };
}

/** The campaign settings the attention rules read, as the insights summary serves them. */
export type AgencyAttentionSettings = Pick<
  AgencyInsightsSettings,
  'record_calls' | 'calling_hours_default' | 'calling_window_start' | 'calling_window_end' | 'calling_days'
>;

/** {@link AgencyAttentionSettings} of the summary's settings. */
export function attentionSettings(settings: AgencyAttentionSettings): AgencyAttentionSettings {
  return {
    record_calls: settings.record_calls,
    calling_hours_default: settings.calling_hours_default,
    calling_window_start: settings.calling_window_start,
    calling_window_end: settings.calling_window_end,
    calling_days: [...settings.calling_days],
  };
}

/** One active campaign on the board. */
export interface AgencyHomeCampaign {
  id: string;
  name: string;
  status: AgencyHomeActiveStatus;
  /** Null when the stats read failed. */
  stats: AgencyHomeCampaignStats | null;
  /** Assigned agents and how many are on the floor now; null when that read failed, or below `agency.supervise`. */
  staffing: AgencyAttentionStaffing | null;
  /**
   * The insights allocation's attention figures (overdue callbacks, held by away agents); null when
   * that read failed, or below `agency.supervise`.
   */
  allocation: AgencyAttentionAllocation | null;
  /** Today in the campaign's zone, as the Health tab serves "Today"; null when that read failed, or below `agency.supervise`. */
  today: AgencyAttentionRangeFigures | null;
  /** The campaign's recording and calling-hours settings; null below `agency.supervise`. */
  settings: AgencyAttentionSettings | null;
}

/** `GET /proxy/agency/home`. */
export interface AgencyHomeBoard {
  /** At most {@link AGENCY_HOME_CAMPAIGN_CAP}, in the Campaigns page's order. */
  campaigns: AgencyHomeCampaign[];
  /** Active campaigns before the cap. */
  active_total: number;
  /** Whether the account has any campaign at all, in any status. */
  any_campaign: boolean;
}
