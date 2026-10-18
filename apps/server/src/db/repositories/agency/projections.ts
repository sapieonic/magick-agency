/**
 * Row → wire-shape projections shared by the agency repository files. A leaf: it
 * imports nothing from this folder.
 */
import type { AgencyCallAttemptRecord, AgencyContactRecord } from '../../models/agency.model.js';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyAttemptRow,
  type AgencyContactRow,
} from '@magick-agency/contracts/agency';

/**
 * Does this row have enough CONNECTS behind it to quote a rate whose denominator is
 * `connected`?
 *
 * ── One spelling, because three places need exactly this comparison ─────────
 *
 * `success_rate_pct` divides by `connected` and so does `aht_seconds`, where
 * `rates_reportable` floors `attempts`. Those are different denominators, and the
 * gap between them is the whole reason this exists: a row with 400 dials and one
 * connect clears the `attempts` floor and still carries a 100% conversion built
 * from a single conversation. The three call sites are
 * {@link AgencyRosterAgentRow.success_rate_reportable},
 * {@link AgencyGroupRow.success_rate_reportable}, and `rosterBenchmark`'s
 * `success_rate` and `aht` percentile pools — which must agree, because the flag on
 * the wire is what a console uses to decide whether to print the same number the
 * pools decided was too thin to rank.
 *
 * Named rather than restated inline at each site: four textually identical copies of
 * `row.connected >= CONSTANT` are four things to change when the threshold is
 * argued about, and the one that gets missed makes the payload disagree with the
 * benchmark beside it while both claim to honour "the" minimum.
 *
 * ⚠️ This IMPLIES `rates_reportable`. `connected <= attempts` always — a connect is
 * an attempt that bridged — and `rates_reportable` IS `attempts >= ` the same
 * constant, so this predicate is strictly stronger and never true where that flag
 * is false. That is what lets a consumer gate on the stronger flag ALONE, and it is
 * why the percentile pools' `rated` prefilter is (harmlessly) redundant for these
 * two metrics.
 */
export const hasRateDenominator = (row: { connected: number }): boolean =>
  row.connected >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR;

/** `Date | null` → ISO string | null, for the wire shapes. */
export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * `agency_call_attempts` row (joined to its contact and session) → the wire shape.
 *
 * Shared by the campaign-scoped and agent-scoped spines. Extracted when the second
 * one arrived rather than copied: the projection is twenty-three fields, and two
 * copies means the next field is added to one of them.
 */
export function projectAttemptRow(row: AgencyCallAttemptRecord & {
  phone_e164: string; agent_user_id: string | null;
}): AgencyAttemptRow {
  return {
    id: row.id,
    campaign_id: row.campaign_id,
    contact_id: row.contact_id,
    attempt_number: row.attempt_number,
    phone_e164: row.phone_e164,
    caller_id: row.caller_id,
    agent_user_id: row.agent_user_id,
    reserved_agent_id: row.reserved_agent_id,
    state: row.state,
    outcome: row.outcome,
    disposition_code: row.disposition_code,
    // Included deliberately — see the privacy note on `AgencyAttemptRow`.
    notes: row.notes,
    callback_at: iso(row.callback_at),
    dispositioned_by_user_id: row.dispositioned_by_user_id,
    dispositioned_at: iso(row.dispositioned_at),
    dispositioned_on_behalf: row.dispositioned_on_behalf,
    webrtc_call_id: row.webrtc_call_id,
    dialed_at: iso(row.dialed_at),
    answered_at: iso(row.answered_at),
    bridged_at: iso(row.bridged_at),
    ended_at: iso(row.ended_at),
    talk_seconds: row.talk_seconds,
    wrapup_seconds: row.wrapup_seconds,
    created_at: iso(row.created_at) ?? '',
  };
}

/** `agency_contacts` row → the wire shape, minus `context`. */
export function projectContactRow(row: AgencyContactRecord): AgencyContactRow {
  return {
    id: row.id,
    phone_e164: row.phone_e164,
    state: row.state,
    attempt_count: row.attempt_count,
    our_fault_attempts: row.our_fault_attempts,
    last_outcome: row.last_outcome,
    last_disposition: row.last_disposition,
    next_attempt_at: iso(row.next_attempt_at) ?? '',
    suppressed_reason: row.suppressed_reason,
    timezone: row.timezone,
    csv_line_number: row.csv_line_number,
    created_at: iso(row.created_at) ?? '',
    updated_at: iso(row.updated_at) ?? '',
  };
}
