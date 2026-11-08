/**
 * The agent performance review (`kind: 'agent'`): one agent across every campaign of the
 * account over the window, drawn from this dataset alone.
 *
 * ── Sources, and which wire type each reuses ────────────────────────────────
 * - `record`: the agent record's window totals (`GET /proxy/agency/agents/:userId/stats`,
 *   `…/my-stats` for `self`), as the CONSOLE wire type `AgencyApi.AgencyAgentStatsTotals`.
 *   That is the type the public proxy serves and the agent page renders; it differs from the
 *   dialer contract's only in `occupancy` being optional and nullable (CONTRACT-DIFF.md §1), so
 *   a dialer-contract value assigns to it unchanged and the renderer handles "occupancy not
 *   measured" exactly as the agent page does.
 * - `per_campaign`: the same record's `by_campaign[]` rows (`AgencyAgentStatsByCampaign`) plus
 *   the campaign's name.
 * - `roster_row` and `benchmark`: the account roster (`GET /proxy/agency/agents/stats`,
 *   `campaign_id` unset) over the same window, as served to the console
 *   (`AgencyRosterAgentRowWithName`, `AgencyApi.AgencyRosterBenchmark`).
 * - Everything else (`presence`, `daily`, `timeline`, `outcomes`, `follow_through`, `quality`)
 *   is built for the report from the session event log, the attempts and the Insights rollup's
 *   agent rows, cut in `range.timezone`.
 *
 * ── Two "day" rules, stated because they differ ─────────────────────────────
 * The agent record cuts its own buckets in each CAMPAIGN's zone; this dataset's `daily`,
 * `timeline` and `presence.days_worked` are cut in the REPORT's zone (RP3). Every attempt and
 * every state second still lands in exactly one day, so `daily` sums to the window totals, but a
 * date here can differ from the agent page's bucket label for the same call.
 */
import type {
  AgencyAgentStatsByCampaign,
  AgencyAgentStatsTotals,
  AgencyRosterAgentRowWithName,
} from '../api/agency/agency-stats';
import type { ReportDatasetBase, ReportRosterBenchmark } from './dataset';

/** The four states time is reported in. `reserved` (structurally 0) is folded into `available`. */
export interface ReportStateSeconds {
  available: number;
  on_call: number;
  wrapup: number;
  break: number;
}

/** A state on the timeline: the four above, and `offline` for gaps between sessions. */
export type ReportTimelineState = 'available' | 'on_call' | 'wrapup' | 'break' | 'offline';
export const REPORT_TIMELINE_STATES = ['available', 'on_call', 'wrapup', 'break', 'offline'] as const satisfies readonly ReportTimelineState[];

/** A campaign the review mentions. */
export interface ReportCampaignRef {
  id: string;
  name: string;
  /** The campaign's resolved `default_timezone`. */
  timezone: string;
}

/** Where the agent's logged-in time went over the window. */
export interface AgentReviewPresence {
  /** Local days with any logged-in time (`daily` rows with `station_s > 0`). */
  days_worked: number;
  /** Logged-in seconds: the sum of `by_state`. */
  station_seconds: number;
  /**
   * From the session event log, clipped to the window, in WHOLE seconds (each state's window
   * total rounded once). When `record.occupancy` is measured it agrees with its `by_state` on
   * these four states (its `reserved` added to `available`) to within half a second each: the
   * record serves fractional seconds.
   */
  by_state: ReportStateSeconds;
  /** `by_state.break` by reason, largest first; sums to it. The soft phone is the reason `soft_phone`. */
  break_by_reason: Array<{ reason: string; label: string; seconds: number }>;
  /** Calls reserved to the agent that ended `agent_disconnected` (their station went away mid-call). */
  drops: number;
}

/**
 * One local day in `range.timezone`. Every day of the window is present, zeros included, so
 * `daily.length === range.days`. Columns sum to the window figures: `dials` to
 * `record.attempts`, `connected` and `conversations` to `record.connected`, `successes` to
 * `record.successes`, `talk_s` to `record.talk_seconds`, the state seconds to `presence.by_state`.
 *
 * Seconds (`station_s`, the four state columns, `talk_s`) are WHOLE seconds: each column is
 * rounded across the days so the days sum exactly to the window's total rounded once. Where the
 * record serves fractional seconds (`record.talk_seconds`, `record.occupancy`), Σ `talk_s` and
 * each Σ state column can therefore differ from it by under a second (at most half a second).
 */
export interface AgentReviewDailyRow {
  date: string;
  /** First session join (or first state event) of the day; null when not logged in. */
  first_in: string | null;
  /** Last session leave (or last state event) of the day, clipped to the day's end; null when not logged in. */
  last_out: string | null;
  /** Sessions with logged-in time that day. */
  sessions: number;
  drops: number;
  /** Logged-in seconds: `available_s + on_call_s + wrapup_s + break_s`. */
  station_s: number;
  on_call_s: number;
  wrapup_s: number;
  available_s: number;
  break_s: number;
  /** Placed dials reserved to the agent, wrap-up redials included (the record's `attempts`). */
  dials: number;
  /** Placed dials that were not wrap-up redials: the connect rate's denominator. */
  first_dials: number;
  /**
   * The agent record's `connected` for the day: CONVERSATIONS, not bridged legs. A conversation
   * the agent redialled from wrap-up counts once, at the attempt that carries its outcome (the
   * one not closed `redialed`), even when that redial did not bridge itself; a bridged first
   * dial counts when it was not closed `redialed`.
   */
  connected: number;
  /**
   * One per conversation (a redial chain once): the success rate's denominator. The record's
   * `connected` already counts conversations, so in this dataset `conversations` ALWAYS EQUALS
   * `connected` (same count, same rule). Both are kept so a day row names the success rate's
   * denominator as the campaign and account rows do; there the two differ (`connected` is
   * Insights' `attempts_connected`: outcome `connected`, not a wrap-up redial).
   */
  conversations: number;
  /** Conversations coded neither voicemail nor `no_disposition`: the connect rate's numerator. */
  human_connects: number;
  /** Conversations closed with a success code of the campaign's current catalog. */
  successes: number;
  /** The agent's leg of connected calls (the record's `talk_seconds` definition). */
  talk_s: number;
}

/** One state interval on the timeline. Contiguous: each `start` is the previous `end`. */
export interface AgentReviewTimelineSegment {
  start: string;
  end: string;
  state: ReportTimelineState;
  /** The break reason code when `state` is `break`, else null. */
  break_reason: string | null;
}

/**
 * One representative worked day, drawn as a strip. The day is the one with the most logged-in
 * seconds; on a tie, the most recent. Segments cover that whole local day (00:00 to the next
 * 00:00 in `range.timezone`, `offline` where not logged in), clipped to `range.end`.
 */
export interface AgentReviewTimeline {
  date: string;
  segments: AgentReviewTimelineSegment[];
}

/**
 * Conversations by disposition code, largest first; `conversations` sums to the window's
 * conversations (`daily` summed).
 */
export interface AgentReviewOutcomeRow {
  /** Disposition code; null groups conversations closed without one. */
  code: string | null;
  /** The catalog label, or the server's words for a null or retired code. */
  label: string;
  is_success: boolean;
  conversations: number;
  /** `conversations / Σ conversations × 100`; null when the sum is 0. */
  share_pct: number | null;
  /**
   * Agent-leg talk seconds of the attempt that carries each conversation's outcome
   * `/ conversations`, whole seconds; null when `conversations` is 0. In a wrap-up redial chain
   * that is the redial's leg only: the earlier legs (closed `redialed`) are not in it, while
   * `record.talk_seconds` counts every bridged leg. So Σ (`avg_talk_s` × `conversations`) can be
   * less than `record.talk_seconds`.
   */
  avg_talk_s: number | null;
}

/** One campaign's slice of the record, with its name. */
export interface AgentReviewCampaignRow extends AgencyAgentStatsByCampaign {
  campaign_name: string;
}

/**
 * What the agent did after the conversation. Callback classes are Insights' (IN4,
 * `AgencyInsightsCallbacks`), over callbacks this agent booked.
 */
export interface AgentReviewFollowThrough {
  callbacks: {
    /** Booked by the agent's dials in the window (counted at the booking dial, whenever it is due). */
    booked: number;
    /**
     * The classes below count a different set from `booked`: callbacks the agent booked (at any
     * time before the window's end) that are DUE in the window (`callback_at` in it), so they do
     * not sum to `booked`. On time: the follow-up was dialled within 15 minutes of the booked
     * time (or early), whoever dialled it.
     */
    on_time: number;
    /** Dialled later than that. */
    late: number;
    /** Never dialled and the contact closed or the campaign ended. */
    missed: number;
    /** Not dialled yet, booked time still ahead. */
    pending_future: number;
    /** Not dialled yet, booked time passed (overdue). */
    pending_due: number;
  };
  /** Wrap-up redials the agent placed, and how many of them connected. */
  redials_placed: number;
  redials_connected: number;
  /** Agent-led retry dials (reopened plus manual). */
  agent_retries: number;
  /** Outcome overrides the agent's dials used. */
  overrides_used: number;
  /** Do Not Call entries the agent wrote. */
  dnc_marked: number;
  /**
   * Soft-phone calls the agent placed (outside every campaign count above): started
   * (`created_at`) in the window and dialled, Insights' soft-phone rule. The calls sheet and the
   * sentiment set take soft-phone calls by the same rule.
   */
  softphone_calls: number;
}

/**
 * Call analysis over the agent's analysed calls (supervisor audience only, RP5). Null for `self`,
 * and null when analysis is off or no call in the window was analysed.
 */
export interface AgentReviewQuality {
  /** Analysed calls whose overall sentiment is one of the analysis's four labels (`SentimentLabel`). */
  analysed_calls: number;
  /**
   * Those calls by overall sentiment, one count per `SentimentLabel` (`mixed` is its own count,
   * never folded into `neutral`). Sums to `analysed_calls`.
   */
  sentiment: { positive: number; neutral: number; negative: number; mixed: number };
}

/** RP11: occupancy shown three ways, each with its numerator and denominator stated. */
export interface AgentReviewOccupancy {
  /** The roster's `occupancy_pct`: (talk + wrap-up) ÷ logged-in seconds. The figure benchmarked against the floor. Null when `roster_row` is null or unmeasured. */
  handling_pct: number | null;
  /** `record.occupancy.by_state.on_call ÷ record.occupancy.shift_seconds × 100`; null when unmeasured or 0. */
  on_call_pct: number | null;
  /** As `on_call_pct`, with break seconds taken out of the denominator; null when that is 0. */
  on_call_pct_excl_break: number | null;
}

export interface AgentReviewDataset extends ReportDatasetBase {
  kind: 'agent';
  agent: { user_id: string; name: string };
  /** Every campaign named in `per_campaign`, plus any the agent was logged in on without dialling. */
  campaigns: ReportCampaignRef[];
  /** The agent record's window totals (see the module note for the type choice). */
  record: AgencyAgentStatsTotals;
  /**
   * The agent's roster row for the window; null when they placed no dial (the roster has no row
   * then), and null when they are below the 200th row of the roster read (attempts, descending)
   * on a floor of more than 200 dialling agents.
   */
  roster_row: AgencyRosterAgentRowWithName | null;
  /** Null for the `self` audience (RP5). */
  benchmark: ReportRosterBenchmark | null;
  occupancy: AgentReviewOccupancy;
  presence: AgentReviewPresence;
  daily: AgentReviewDailyRow[];
  /** Null when the agent had no logged-in time in the window. */
  timeline: AgentReviewTimeline | null;
  outcomes: AgentReviewOutcomeRow[];
  /** Unsorted; sums to `record` on every counter (the record's own rule). */
  per_campaign: AgentReviewCampaignRow[];
  follow_through: AgentReviewFollowThrough;
  /** Null for `self` (RP5) or when not available. */
  quality: AgentReviewQuality | null;
  floors: {
    /** The roster's floor (`AGENCY_ROSTER_MIN_RATE_DENOMINATOR`, 20 first dials, RP9): below it an agent rate renders as words. */
    agent_rate_min_first_dials: number;
  };
}
