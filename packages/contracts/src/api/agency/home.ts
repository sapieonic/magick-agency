/**
 * Home's board: `GET /proxy/agency/home` (decision B28a). Everything Home and the sidebar's
 * Home badge read about the account's active campaigns, in ONE request instead of a list read
 * plus a `/stats` and an insights allocation read per campaign.
 *
 * - **Gate:** `agency.supervise` (Home's own gate, `HOME_GATE`), then the dialer flag
 *   (`403 feature_disabled`, the campaign reads' refusal). Account-scoped: the request's tenant
 *   and account, nothing else.
 * - **Which campaigns:** the active ones ({@link AGENCY_HOME_ACTIVE_STATUSES}), in the Campaigns
 *   page's order (running, then stopping, then paused; newest first within a status), the first
 *   {@link AGENCY_HOME_CAMPAIGN_CAP} of them. `active_total` is the count before the cap.
 * - **Per campaign:** the fields of `/stats` Home reads ({@link AgencyHomeCampaignStats}, the
 *   internal stats handler's own payload, so the stall and the floor are the health strip's) and
 *   `callbacks_overdue`, the insights allocation's `totals.callbacks_overdue` through the same
 *   server cache the Insights tab and the Callbacks badge read.
 * - **A part that failed is `null`**, never a guess: a campaign whose stats read failed has
 *   `stats: null`, one whose allocation failed `callbacks_overdue: null`. The console keeps what it
 *   showed for that campaign. The request as a whole fails only when the campaign list does.
 * - **Freshness:** stats of a campaign that is moving (running or stopping, or with live calls or
 *   agents on it) are read on every request; a still campaign's are reused for up to a minute,
 *   and so is every campaign's overdue count (a follow-up count, not a live queue). A transition
 *   or a settings edit misses both at once (keyed by the campaign's status and `updated_at`).
 */
import type { AgencyCampaignStats } from './agency-campaign';

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

/** One active campaign on the board. */
export interface AgencyHomeCampaign {
  id: string;
  name: string;
  status: AgencyHomeActiveStatus;
  /** Null when the stats read failed. */
  stats: AgencyHomeCampaignStats | null;
  /** Callbacks overdue now (the insights allocation's totals); null when that read failed. */
  callbacks_overdue: number | null;
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
