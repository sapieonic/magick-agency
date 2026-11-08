/**
 * The account report (`kind: 'account'`, supervisor audience only): every covered campaign of
 * one account side by side, the account's agents on the roster, and the account's day-by-day
 * volume, over the window in the zone the request named (RP3).
 *
 * ── Sources ─────────────────────────────────────────────────────────────────
 * - Per campaign: the Insights range reads (`compute*`, docs/insights.md) over
 *   `[range.start, range.end)`. `calls` is that campaign's `AgencyInsightsActivity['calls']`
 *   verbatim; the other figures are named fields of `activity`, `trends` (summed over its
 *   buckets) and `health`.
 * - `totals`: the campaigns' figures SUMMED field by field (`by_outcome` per outcome, `redials`
 *   and `agent_retries` per member). Rates of the totals are recomputed from the summed
 *   numerators and denominators, never averaged across campaigns.
 * - `agents` and `benchmark`: the account roster (`GET /proxy/agency/agents/stats`,
 *   `campaign_id` unset) over the same window, as served to the console. The roster covers the
 *   whole account, whatever `campaign_ids` narrowed the campaign rows to.
 * - `daily`: the Insights rollup's 15-minute buckets of the covered campaigns, re-bucketed into
 *   local days of `range.timezone` (which need not be any campaign's zone).
 *
 * Insights' counts carry no rates; the two floors say where rates render as words (RP9).
 */
import type { AgencyCampaignStatus } from '../agency/enums';
import type { AgencyRosterAgentRowWithName } from '../api/agency/agency-stats';
import type { AgencyInsightsCalls, AgencyInsightsHealth } from '../api/agency/insights';
import type { ReportDatasetBase, ReportRosterBenchmark } from './dataset';

/** One campaign's figures, or the account's summed ({@link AccountReportDataset.totals}). */
export interface AccountReportFigures {
  /** `AgencyInsightsActivity['calls']`: dials, connected, human connects, conversations, successes, outcomes, redials, talk and wrap-up. */
  calls: AgencyInsightsCalls;
  /** `activity.callbacks.booked`: callbacks booked in the window. */
  callbacks_booked: number;
  /** Σ `trends.buckets[].abandoned`: answered calls that reached no agent. */
  abandoned: number;
  /** Σ `trends.buckets[].answered`: the abandonment rate's denominator. */
  answered: number;
  /** `abandoned / answered × 100`; null when `answered` is 0. */
  abandoned_pct: number | null;
  /** `health.recording.connected`: connected calls (the recording share's denominator). */
  recording_connected: number;
  /** `health.recording.recorded`: of those, recorded. */
  recorded: number;
}

/** One covered campaign. */
export interface AccountReportCampaignRow extends AccountReportFigures {
  id: string;
  name: string;
  /** As of `generated_at`. */
  status: AgencyCampaignStatus;
  /** The campaign's resolved zone. */
  timezone: string;
}

/**
 * One local day of the covered campaigns together. Every day of the window is present, zeros
 * included (`daily.length === range.days`). Counts as on `AgencyInsightsTrendBucket`.
 */
export interface AccountReportDailyRow {
  date: string;
  dials: number;
  /** Placed dials that were not wrap-up redials: the connect rate's denominator. */
  first_dials: number;
  connected: number;
  /** One per conversation: the success rate's denominator. */
  conversations: number;
  /** The connect rate's numerator. */
  human_connects: number;
  successes: number;
  /**
   * Distinct agents online on any covered campaign at the day's busiest moment; null when the
   * builder cannot measure it (a sum of per-campaign peaks would over-count agents who moved
   * between campaigns, so it is never served as one).
   */
  agents_online_peak: number | null;
}

/** One covered campaign's health over the window: fields of its `AgencyInsightsHealth`. */
export interface AccountReportHealthRow {
  campaign_id: string;
  /** `health.abandonment.auto_pauses.length` (that list is capped at 200). */
  auto_pauses: number;
  /** `health.stalls.minutes_by_reason`. */
  stall_minutes_by_reason: AgencyInsightsHealth['stalls']['minutes_by_reason'];
  /** `health.concurrency_limit_minutes`. */
  concurrency_limit_minutes: number;
  /** `health.carrier_failures`. */
  carrier_failures: number;
  /** `health.our_fault_retired`. */
  our_fault_retired: number;
  /** `health.predial_blocks`. */
  predial_blocks: AgencyInsightsHealth['predial_blocks'];
}

export interface AccountReportDataset extends ReportDatasetBase {
  kind: 'account';
  audience: 'supervisor';
  account: { id: string; name: string };
  /** The covered campaigns, by name. */
  campaigns: AccountReportCampaignRow[];
  /** The campaigns' figures summed; rates recomputed from the sums. */
  totals: AccountReportFigures;
  /** The roster rows for the window, as the roster orders them by default (attempts, descending). */
  agents: AgencyRosterAgentRowWithName[];
  benchmark: ReportRosterBenchmark;
  daily: AccountReportDailyRow[];
  /** One row per covered campaign, in `campaigns` order. */
  health: AccountReportHealthRow[];
  floors: {
    /** Insights' floor (25, RP9) for campaign and account figures. */
    campaign_rate_min_first_dials: number;
    /** The roster's floor (20, RP9) for agent rows and bands. */
    agent_rate_min_first_dials: number;
  };
}
