/**
 * Row → wire-shape projections shared by the agency repository files. A leaf: it
 * imports nothing from this folder.
 */
import type {
  AgencyCallAttemptRecord,
  AgencyContactRecord,
  AgencyManualCallRecord,
} from '../../models/agency.model.js';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  SOFTPHONE_OUTCOME_LAPSE_MS,
  type AgencyAttemptRow,
  type AgencyContactRow,
  type AgencyContactState,
  type AgencyManualCall,
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

/**
 * An `agency_manual_calls` row with what its wire shape joins: the tag's name
 * (`agency_campaigns`, LEFT — the tag has no FK) and the matched contact's current
 * state and `context` (`agency_contacts`, LEFT — no FK either). The columns the
 * manual-call reads project beside `m.*`.
 */
export interface AgencyManualCallJoinedRow extends AgencyManualCallRecord {
  /** NULL when untagged, or when the tagged campaign row is gone. */
  campaign_name: string | null;
  /** NULL when there is no contact, or the contact row is gone. */
  contact_state: AgencyContactState | null;
  /** Only projected by the reads that serve a live call or the detail. */
  contact_context?: Record<string, unknown> | null;
}

/** The tag name shown when the tagged campaign row no longer exists (no FK). */
export const MANUAL_CALL_DELETED_CAMPAIGN_NAME = '(deleted campaign)';

/**
 * Whether a manual call waits for an outcome before its session can dial again
 * (`AgencyManualCall.requires_disposition`): it ended after it BRIDGED and is not
 * settled. Keyed on `bridged_at`, as an attempt's disposition is
 * (`dispositionRefusal`): a call whose media never joined has nothing to write up,
 * and `AgencyManualCallRepository.recordDisposition` refuses it.
 */
export function manualCallRequiresDisposition(
  row: Pick<AgencyManualCallRecord, 'state' | 'settled_at' | 'bridged_at'>,
): boolean {
  return row.state === 'ended' && row.settled_at === null && row.bridged_at !== null;
}

/**
 * `agency_manual_calls` row (joined, see {@link AgencyManualCallJoinedRow}) → the
 * wire row `AgencyManualCall`.
 *
 * - `agent_name` is ALWAYS null here: names live in `users`, which the dialer
 *   tables do not join; the public API layer fills it on the list, the detail and
 *   bootstrap (`agency-agent-identity.ts`), and the station frame carries null.
 * - `contact.context` is carried only with `withContext` (the live call and the
 *   detail; never a list row — the spine's privacy rule). `prior_attempts` is
 *   never filled here: the caller adds it from the attempt repository.
 * - `tag.campaign_name` falls back to {@link MANUAL_CALL_DELETED_CAMPAIGN_NAME}
 *   when the campaign row is gone; `contact` is null when the contact row is.
 */
export function projectManualCallRow(
  row: AgencyManualCallJoinedRow,
  opts: { withContext?: boolean } = {},
): AgencyManualCall {
  const requiresDisposition = manualCallRequiresDisposition(row);
  const endedAt = row.ended_at === null ? null : new Date(row.ended_at);
  return {
    id: row.id,
    session_id: row.session_id,
    agent_user_id: row.agent_user_id,
    agent_name: null,
    destination_e164: row.destination_e164,
    caller_id: row.caller_id,
    tag: row.campaign_id === null
      ? null
      : { campaign_id: row.campaign_id, campaign_name: row.campaign_name ?? MANUAL_CALL_DELETED_CAMPAIGN_NAME },
    contact: row.contact_id === null || row.contact_state === null
      ? null
      : {
        contact_id: row.contact_id,
        state: row.contact_state,
        claimed: row.contact_claimed,
        ...(opts.withContext ? { context: row.contact_context ?? {} } : {}),
      },
    state: row.state,
    outcome: row.outcome,
    end_reason: row.end_reason,
    recording_requested: row.recording_requested,
    dnc_overridden: row.dnc_override_note !== null,
    hours_overridden: row.hours_override_note !== null,
    requires_disposition: requiresDisposition,
    outcome_due_at: requiresDisposition && endedAt
      ? new Date(endedAt.getTime() + SOFTPHONE_OUTCOME_LAPSE_MS).toISOString()
      : null,
    disposition_code: row.disposition_code,
    disposition_source: row.disposition_source,
    notes: row.notes,
    callback_at: iso(row.callback_at),
    fields: row.fields ?? {},
    dispositioned_by_user_id: row.dispositioned_by_user_id,
    dispositioned_at: iso(row.dispositioned_at),
    dispositioned_on_behalf: row.dispositioned_on_behalf,
    webrtc_call_id: row.webrtc_call_id,
    dialed_at: iso(row.dialed_at),
    answered_at: iso(row.answered_at),
    bridged_at: iso(row.bridged_at),
    ended_at: iso(row.ended_at),
    talk_seconds: row.talk_seconds,
    settled_at: iso(row.settled_at),
    created_at: iso(row.created_at) ?? '',
    updated_at: iso(row.updated_at) ?? '',
  };
}
