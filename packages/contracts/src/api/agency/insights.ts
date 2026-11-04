/**
 * The campaign insights page: `GET /proxy/agency/campaigns/:id/insights/*`.
 *
 * One analytic surface per campaign (the Insights tab, which replaces Overview and
 * Performance). Sections are separate reads so the cheap "as of now" numbers paint first
 * and the heavy sections load on their own:
 *
 * | Read | What | Range | Polled |
 * |---|---|---|---|
 * | `summary` | header, settings, status headline, roster buckets | none (as of now) | while running/stopping, and while calls finish on paused |
 * | `readiness` | the draft "Ready to launch?" checklist | none | no |
 * | `allocation` | per-agent allocation table, imbalance, at risk | none (as of now) | with summary |
 * | `activity` | calls, outcomes, callbacks, overrides, per-agent activity | `from`/`to` | no (manual refresh) |
 * | `trends` | series by 15 min / hour / day, best hours | `from`/`to`/`bucket` | no |
 * | `health` | abandonment, pre-dial blocks, caller IDs, pacing history, recording | `from`/`to` | no |
 * | `uploads` | roster upload history | none | no |
 *
 * ── Rules every section follows ─────────────────────────────────────────────
 * - **Counts only, no rates on the wire**, the rule of `agency-campaign-series.ts`. The
 *   console derives every rate and withholds it below {@link AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR}
 *   ("Not enough calls yet"). A rate with a zero denominator is null, never 0.
 * - **Every breakdown reconciles, and says so.** Each section that splits a total carries a
 *   `reconciliation` block computed by the server in the same statement as the counts, so
 *   the page can show "states add up" as a fact rather than assume it.
 * - **Ranges are half-open `[from, to)`**, ISO-8601 instants, at most
 *   {@link AGENCY_INSIGHTS_MAX_RANGE_DAYS} days. Omitting both means lifetime (the campaign's
 *   first dial to now). Day buckets are calendar days in the campaign's time zone.
 * - Access: `agency.supervise` on every read (account admin and up; tenant owners pass;
 *   agents never). Account scoping and the ownership probe as on every campaign route.
 * - Wire codes stay as the dialer spells them (`canceled`); console copy is British English.
 */
import type {
  AgencyAgentState,
  AgencyAttemptOutcome,
  AgencyCampaignStatus,
} from '../../agency/enums';
import type { AgencyAssignmentMode } from '../../agency/assignment';
import type { AgencyStall, AgencyStallCode } from '../../agency/campaign-stats';
import type { AllListed } from '../../primitives';

/** Rates on the insights page are withheld below this many calls in the denominator (decision 5). */
export const AGENCY_INSIGHTS_MIN_RATE_DENOMINATOR = 25;

/** The widest `[from, to)` an insights range read accepts. */
export const AGENCY_INSIGHTS_MAX_RANGE_DAYS = 92;

/** A callback dialled within this many minutes of its booked time is "on time" (decision 4). */
export const AGENCY_INSIGHTS_CALLBACK_ON_TIME_MINUTES = 15;

/** Trend bucket widths. `quarter_hour` exists because UTC+05:30 hours do not align to UTC hours. */
export type AgencyInsightsBucket = 'quarter_hour' | 'hour' | 'day';
export const AGENCY_INSIGHTS_BUCKETS = ['quarter_hour', 'hour', 'day'] as const;

/** A sum the server checked in the same statement as the counts it covers. */
export interface AgencyInsightsReconciliation {
  /** What was summed, e.g. `contact_states_vs_total`. Stable identifier, not copy. */
  check: string;
  expected: number;
  actual: number;
  ok: boolean;
}

/** A user reference with a display name (null for a user who no longer exists). */
export interface AgencyInsightsActor {
  user_id: string;
  name: string | null;
}

/** One lifecycle transition and who made it; `actor` is null for the system (pacing, guardrail). */
export interface AgencyInsightsTransition {
  to_status: AgencyCampaignStatus;
  at: string;
  actor: AgencyInsightsActor | null;
  /** `supervisor` | `abandonment_ceiling` | `completed_by_dialler` | ... (stable identifier). */
  reason: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// summary
// ─────────────────────────────────────────────────────────────────────────────

/** Contact states as of now. `waiting_*` + `on_call` + `in_wrapup` + finished = `total`. */
export interface AgencyInsightsRoster {
  total: number;
  waiting_due_now: number;
  /** Pending with `next_attempt_at` in the future that is NOT a callback. */
  waiting_retry: number;
  waiting_callback: number;
  /** `in_flight`. */
  on_call: number;
  /** `connected`: bridged and owing an outcome (live or in wrap-up). */
  in_wrapup: number;
  completed: number;
  exhausted: number;
  suppressed_dnc: number;
  suppressed_invalid: number;
  /** `max_attempts` and `manual` suppressions. */
  suppressed_other: number;
  /** Contacts attempted at least once (penetration numerator). */
  attempted: number;
  /** Attempts per contact over EVERY dial including redials (decision 6): 1, 2, 3, 4+. */
  attempts_per_contact: { one: number; two: number; three: number; four_plus: number };
  /** Total dials placed across the roster; average = dials_placed / attempted. */
  dials_placed: number;
  reconciliation: AgencyInsightsReconciliation[];
}

export interface AgencyInsightsSettings {
  timezone: string;
  calling_window_start: string;
  calling_window_end: string;
  calling_days: number[];
  /** True while the window is still the 09:00–20:00 default (decision 7). */
  calling_hours_default: boolean;
  caller_ids: string[];
  max_attempts: number;
  wrapup_seconds: number | null;
  wrapup_auto_return: boolean;
  allow_wrapup_redial: boolean;
  wrapup_redial_limit: number;
  allow_agent_retry: boolean;
  agent_retry_rounds: number;
  agent_retry_cooldown_minutes: number;
  /** Outcome codes whose catalog entry carries an override, with what each overrides. */
  override_outcomes: Array<{ code: string; label: string; extra_attempts: number | null; retry_delay: boolean; calling_hours: boolean }>;
  record_calls: boolean;
  analysis_profile: { id: string; name: string | null } | null;
  abandonment_ceiling_pct: number;
  assignment_mode: AgencyAssignmentMode;
}

/** The status-aware block at the top of the page. Exactly one member is non-null. */
export interface AgencyInsightsHeadline {
  running: null | {
    agents_by_state: Record<AgencyAgentState, number>;
    calls_live: number;
    concurrency_in_use: number;
    concurrency_limit: number | null;
    /** Dials placed in the last 15 minutes, scaled to per hour. Null before any dial. */
    dials_per_hour: number | null;
    /** Seconds to finish the open contacts at that pace, inside calling hours; null when unknown. */
    eta_seconds: number | null;
    stall: AgencyStall | null;
    other_stalls: AgencyStallCode[];
    abandonment_rate_24h: { abandoned: number; answered: number };
  };
  paused: null | {
    paused_at: string;
    actor: AgencyInsightsActor | null;
    reason: 'supervisor' | 'abandonment_ceiling';
    /** The 24 h abandonment rate the guardrail measured, for an auto-pause. */
    abandonment_rate_pct_at_pause: number | null;
    calls_finishing: number;
    waiting_to_resume: number;
    callbacks_missed_while_paused: number;
    callbacks_due_before_window_end: number;
  };
  stopping: null | { stopped_at: string; actor: AgencyInsightsActor | null; calls_finishing: number };
  stopped: null | {
    stopped_at: string;
    actor: AgencyInsightsActor | null;
    pending: number;
    callbacks_scheduled: number;
    never_attempted: number;
    /** What the default retry selector would pick up now (retry preview `matched`). */
    retry_matched: number;
  };
  completed: null | {
    completed_at: string;
    duration_seconds: number;
    reached: number;
    successes: number;
    not_reached: number;
    dnc: number;
    retry_matched: number;
  };
  /** Draft carries no numbers here: the checklist is the `readiness` read. */
  draft: null | { ready: boolean };
}

export interface AgencyInsightsSummary {
  campaign_id: string;
  name: string;
  status: AgencyCampaignStatus;
  account: { id: string; name: string | null };
  created_at: string;
  /** Null for campaigns created before the creator was recorded. */
  created_by: AgencyInsightsActor | null;
  started_at: string | null;
  ended_at: string | null;
  /** Every lifecycle transition still in the audit window, oldest first. */
  transitions: AgencyInsightsTransition[];
  /** Duplicate column of the latest committed upload; null = phone (the default). */
  dedupe_column: string | null;
  parent_campaign: { id: string; name: string } | null;
  child_campaigns: Array<{ id: string; name: string; status: AgencyCampaignStatus }>;
  settings: AgencyInsightsSettings;
  headline: AgencyInsightsHeadline;
  roster: AgencyInsightsRoster;
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// readiness (draft)
// ─────────────────────────────────────────────────────────────────────────────

export type AgencyReadinessCheckCode =
  | 'roster_uploaded'
  | 'phone_column_mapped'
  | 'outcomes_configured'
  | 'caller_ids_present'
  | 'calling_hours_set'
  | 'agents_staffed'
  | 'contacts_allocated'
  | 'abandonment_clip'
  | 'contacts_on_dnc';
export const AGENCY_READINESS_CHECK_CODES = [
  'roster_uploaded',
  'phone_column_mapped',
  'outcomes_configured',
  'caller_ids_present',
  'calling_hours_set',
  'agents_staffed',
  'contacts_allocated',
  'abandonment_clip',
  'contacts_on_dnc',
] as const;

export type AgencyReadinessCheckResult = 'pass' | 'warn' | 'fail';

export interface AgencyReadinessCheck {
  code: AgencyReadinessCheckCode;
  result: AgencyReadinessCheckResult;
  /** The number behind the check (contacts, agents, unassigned, on DNC); null when none applies. */
  count: number | null;
  /** Extra facts the console renders into copy, e.g. `{ rejected: 212, duplicates: 96 }`. */
  detail: Record<string, number | string | null>;
}

export interface AgencyInsightsReadiness {
  campaign_id: string;
  /** No `fail` checks. Warnings do not block. */
  ready: boolean;
  checks: AgencyReadinessCheck[];
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// allocation
// ─────────────────────────────────────────────────────────────────────────────

export interface AgencyInsightsAllocationRow {
  agent_user_id: string;
  agent_name: string | null;
  staffed: boolean;
  /** Current agent state on the campaign, `offline` when not joined. */
  state: AgencyAgentState;
  last_seen_at: string | null;
  allocated: number;
  attempted: number;
  not_attempted: number;
  due_now: number;
  waiting_retry: number;
  callbacks_due_today: number;
  callbacks_overdue: number;
  reached: number;
  /** Contacts whose latest disposition is a success, owner attribution. */
  successes: number;
  not_reached: number;
  exhausted: number;
  dnc: number;
  redials: number;
  retries_reopened: number;
  retries_manual: number;
  overrides_used: number;
  last_activity_at: string | null;
  /** Open due contacts while away longer than `absent_after_minutes`. */
  due_while_absent: number;
}

export interface AgencyInsightsAllocation {
  campaign_id: string;
  assignment_mode: AgencyAssignmentMode;
  agents: AgencyInsightsAllocationRow[];
  /** The pool (no owner), same columns where they apply; agent fields null. */
  unassigned: Omit<AgencyInsightsAllocationRow, 'agent_user_id' | 'agent_name' | 'staffed' | 'state' | 'last_seen_at' | 'due_while_absent'>;
  totals: Omit<AgencyInsightsAllocationRow, 'agent_user_id' | 'agent_name' | 'staffed' | 'state' | 'last_seen_at' | 'due_while_absent'>;
  /** Agents whose due backlog is at least `factor` times the staffed average, and agents with none. */
  imbalance: { high: Array<{ agent_user_id: string; factor: number }>; empty: string[] };
  at_risk: {
    /** Due contacts held by agents away longer than the threshold, or no longer staffed. */
    held_by_absent: Array<{ agent_user_id: string; due: number; away_since: string | null; staffed: boolean }>;
    overdue_callbacks_absent_owner: number;
  };
  absent_after_minutes: number;
  /** Bulk assignment operations, newest first (capped at 50). */
  history: Array<{ at: string; actor: AgencyInsightsActor | null; kind: string; moved: number; batch_id: string | null }>;
  reconciliation: AgencyInsightsReconciliation[];
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// activity (range)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgencyInsightsRange {
  /** Inclusive start; for lifetime, the first dial (or created_at when none). */
  from: string;
  /** Exclusive end. */
  to: string;
  lifetime: boolean;
  timezone: string;
}

export interface AgencyInsightsCalls {
  /** Every placed dial (`dialed_at` in range), wrap-up redials included. */
  dials: number;
  connected: number;
  /** Placed dials by outcome; `null_outcome` is still live or unrecorded. Sums to `dials`. */
  by_outcome: Record<AgencyAttemptOutcome, number> & { null_outcome: number };
  redials: { placed: number; connected: number; chains_at_limit: number; refused_at_limit: number };
  agent_retries: { reopened_dials: number; reopened_connected: number; manual_dials: number; manual_connected: number };
  /** Soft-phone calls tagged to this campaign; outside every other count here. */
  softphone_calls: number;
  talk_seconds: number;
  wrapup_seconds: number;
  /** Connected calls whose wrap-up was measured (denominator for average wrap-up). */
  wrapup_measured: number;
}

export interface AgencyInsightsOutcomeRow {
  /** Disposition code; null groups the connected calls closed without one. */
  code: string | null;
  label: string | null;
  is_success: boolean;
  count: number;
}

export interface AgencyInsightsCallbacks {
  /** Callbacks booked in range. */
  booked: number;
  /** As of now. */
  open_due_today: number;
  open_overdue: number;
  /** Booked callbacks whose time fell in range, by how the follow-up went (decision 4). */
  kept_on_time: number;
  kept_late: number;
  missed: number;
  /** Still in the future or not yet resolved. */
  pending: number;
  by_owner: Array<{ agent_user_id: string | null; open: number; overdue: number }>;
}

export interface AgencyInsightsOverrideRow {
  code: string;
  granted: number;
  used: number;
  by_agent: Array<{ agent_user_id: string; granted: number; used: number }>;
}

export interface AgencyInsightsAgentActivityRow {
  agent_user_id: string;
  agent_name: string | null;
  online_seconds: number;
  /** Seconds per state; `break` split by reason, soft phone under `soft_phone`. */
  state_seconds: { available: number; on_call: number; wrapup: number; break_by_reason: Record<string, number> };
  dials: number;
  connected: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  wrapup_measured: number;
  redials: number;
  retries: number;
  overrides: number;
}

export interface AgencyInsightsActivity {
  campaign_id: string;
  range: AgencyInsightsRange;
  calls: AgencyInsightsCalls;
  outcomes: AgencyInsightsOutcomeRow[];
  callbacks: AgencyInsightsCallbacks;
  overrides: AgencyInsightsOverrideRow[];
  /** Connected calls closed with no outcome (lapsed wrap-ups), by how wrap-up ended. */
  no_outcome: { total: number; by_resolution: Record<string, number> };
  dnc_marked: { total: number; by_agent: Array<{ user_id: string | null; count: number }> };
  agents: AgencyInsightsAgentActivityRow[];
  /** Staffed agents with no session on the campaign in range. */
  never_joined: string[];
  reconciliation: AgencyInsightsReconciliation[];
  /** Rollup freshness: the newest attempt change folded in. Null when the rollup is empty. */
  as_of: string | null;
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// trends (range + bucket)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgencyInsightsTrendBucket {
  /** Instant (ISO-8601) for sub-day buckets; `YYYY-MM-DD` in the campaign zone for `day`. */
  bucket_start: string;
  dials: number;
  connected: number;
  successes: number;
  abandoned: number;
  answered: number;
  /** Peak agents online on the campaign within the bucket. */
  agents_online_peak: number;
}

export interface AgencyInsightsTrends {
  campaign_id: string;
  range: AgencyInsightsRange;
  bucket: AgencyInsightsBucket;
  /** Every bucket in range, zeros included. */
  buckets: AgencyInsightsTrendBucket[];
  /** Connect counts by hour of day in each CONTACT's time zone (campaign zone when unset), 0–23. */
  best_hours: Array<{ hour: number; dials: number; connected: number }>;
  as_of: string | null;
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// health (range)
// ─────────────────────────────────────────────────────────────────────────────

/** Why the dialler did not dial, as recorded per minute by pacing (decision 2). */
export type AgencyPacingIdleReason =
  | 'no_agents'
  | 'no_slots'
  | 'no_contacts'
  | 'no_reservations'
  | 'no_caller_ids'
  | 'nothing_due';
export const AGENCY_PACING_IDLE_REASONS = [
  'no_agents',
  'no_slots',
  'no_contacts',
  'no_reservations',
  'no_caller_ids',
  'nothing_due',
] as const;

export interface AgencyInsightsStallEpisode {
  reason: AgencyPacingIdleReason | 'outside_calling_hours';
  started_at: string;
  /** Null while still stalled. */
  ended_at: string | null;
  minutes: number;
}

export interface AgencyInsightsHealth {
  campaign_id: string;
  range: AgencyInsightsRange;
  abandonment: {
    rolling_24h: { abandoned: number; answered: number };
    ceiling_pct: number;
    auto_pauses: Array<{ at: string; measured_pct: number | null; ceiling_pct: number | null }>;
  };
  predial_blocks: { dnc: number; invalid: number; outside_calling_hours_deferrals: number };
  caller_ids: Array<{ caller_id: string; dials: number; connected: number }>;
  concurrency_limit_minutes: number;
  carrier_failures: number;
  our_fault_retired: number;
  stalls: { minutes_by_reason: Record<AgencyPacingIdleReason | 'outside_calling_hours', number>; episodes: AgencyInsightsStallEpisode[] };
  recording: { connected: number; recorded: number };
  analysis: null | {
    analysed: number;
    sentiment: { positive: number; neutral: number; negative: number };
    top_topics: Array<{ topic: string; count: number }>;
  };
  /** Pacing history is recorded from the day it shipped; earlier minutes are absent, not zero. */
  pacing_history_since: string | null;
  as_of: string | null;
  generated_at: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// uploads
// ─────────────────────────────────────────────────────────────────────────────

export interface AgencyInsightsUpload {
  job_id: string;
  file_name: string | null;
  uploaded_by: AgencyInsightsActor | null;
  created_at: string;
  finished_at: string | null;
  status: string;
  mode: string;
  rows_read: number;
  accepted: number;
  rejected: number;
  rejected_by_reason: Record<string, number>;
  duplicates: number;
  /** Null = phone. */
  dedupe_column: string | null;
  has_rejected_export: boolean;
}

export interface AgencyInsightsUploads {
  campaign_id: string;
  /** Committed (non-dry-run) uploads, newest first. */
  uploads: AgencyInsightsUpload[];
  generated_at: string;
}

const _bucketsListed: AllListed<AgencyInsightsBucket, typeof AGENCY_INSIGHTS_BUCKETS> = true;
const _checksListed: AllListed<AgencyReadinessCheckCode, typeof AGENCY_READINESS_CHECK_CODES> = true;
const _idleListed: AllListed<AgencyPacingIdleReason, typeof AGENCY_PACING_IDLE_REASONS> = true;
void _bucketsListed;
void _checksListed;
void _idleListed;
