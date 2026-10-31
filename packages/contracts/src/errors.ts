/**
 * The agency error vocabularies, each as a closed union plus an `as const` list.
 *
 * `AgencyStationErrorCode` (the `code` on a station `error` frame) is re-exported
 * here as a union only: no server path sends that frame today, so it has no
 * runtime list.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Each vocabulary is declared exactly once, here. Separate copies (the
 * dialer runtime's union, the public API layer's mirror, the console's own copy)
 * would drift: a code the server raises and the console's copy lacks reaches the
 * agent as a generic failure instead of the sentence keyed to it, with nothing red
 * anywhere. One application, one file.
 *
 * The app-wide error mask (`apps/server/src/api/middleware/error-mask.middleware.ts`)
 * passes every 4xx through unchanged and masks only 5xx, so none of these lists is
 * an allow-list: they are the vocabularies the console switches on.
 *
 * ── The two-sided exhaustiveness trick ──────────────────────────────────────
 * For every vocabulary:
 *
 *   1. `as const satisfies readonly Union[]` proves every LISTED value is a
 *      member of the union;
 *   2. `const _x: AllListed<Union, typeof LIST> = true` (`./primitives`) proves
 *      every UNION MEMBER is listed.
 *
 * Either direction drifting is a `tsc --noEmit` failure, i.e. `pnpm lint`.
 *
 * The action union `AgencyActionErrorCode` is DECLARED here, beside its list, and
 * `./agency` (the frozen contract) re-exports it. Where the frozen contract
 * declares a union itself (`AgencyStationErrorCode`), it is RE-EXPORTED here, never
 * re-declared — a second declaration is exactly the drift this file exists to end.
 */

import type { AllListed } from './primitives';

export type { AgencyStationErrorCode } from './agency/station';

// ─── 1. Agent action-route refusals ─────────────────────────────────────────

/**
 * Why an agent action was refused.
 *
 * These exist as a closed union because the public API layer must surface
 * the dialer runtime's validation errors **intact**, and "intact" is not a property a free-text
 * message has: a proxy that re-words or flattens them leaves the console unable to
 * do anything but show a red box. The console keys its copy off `code`; `message`
 * is the fallback for a code it does not recognise.
 */
export type AgencyActionErrorCode =
  /** No `agent_user_id` on the request. The public API layer must always attribute the action. */
  | 'missing_actor'
  /** The caller is not the reserved agent and did not assert `on_behalf`. */
  | 'not_your_attempt'
  /** `disposition_code` is not in the campaign's catalog. `allowed_codes` is set. */
  | 'unknown_disposition_code'
  /**
   * `scope` on a mark-DNC is neither `campaign` nor `tenant`. `allowed_codes` is
   * set to both. Refused rather than defaulted on purpose: the two scopes are
   * different promises to a customer, and guessing which one a misspelling meant
   * would make one of those promises false silently.
   */
  | 'invalid_dnc_scope'
  /** The catalog entry sets `requires_note` and `notes` was empty. */
  | 'note_required'
  /** The catalog entry sets `requires_datetime` and `callback_at` was absent. */
  | 'datetime_required'
  /** `callback_at` is unparseable or in the past. */
  | 'invalid_callback_at'
  /**
   * The attempt is not in a state that can be dispositioned — it never reached the
   * agent, or its wrap-up is long over and the reaper already wrote
   * `no_disposition`. Distinct from `already_dispositioned` so the console can
   * offer "this call was auto-closed" rather than "you already did this".
   */
  | 'attempt_not_dispositionable'
  /** A disposition is already recorded. Deliberately not an overwrite (see below). */
  | 'already_dispositioned'
  /** `reason` is not in the campaign's `break_reasons`. `allowed_codes` is set. */
  | 'unknown_break_reason'
  /**
   * `break/cancel` on a break that is already in effect. There is nothing queued
   * left to cancel; the agent wants `/available` instead.
   */
  | 'break_already_applied'
  /** The session has left; re-bootstrap rather than retrying. */
  | 'session_ended'
  /**
   * `POST /sessions` refused: the agent already holds a LIVE session on a
   * DIFFERENT campaign in the same tenant. There is one live
   * session per (tenant, agent), because the reservation CAS key is per SESSION
   * (`agency:agent:{sessionId}:state`) while a human has one pair of ears — two
   * live sessions are two independently reservable agents and two customers
   * bridged into one headset.
   *
   * The only member of this union that sets `campaign_id` / `campaign_name` /
   * `state`; see {@link AgencySessionCampaignConflict}, which narrows this shape
   * for it. Those fields are read against this code exactly as `allowed_codes` is
   * read against its three producers — nothing else sets them.
   */
  | 'session_on_other_campaign'
  /**
   * `POST /sessions/:id/leave` refused: this replica is still driving an attempt
   * for the session.
   *
   * Not a politeness. Leaving clears the lease and sets `left_at`, and a left row
   * no longer participates in `uq_agency_agent_live_tenant` — so an `on_call`
   * agent who left could join a second campaign and be bridged a second customer
   * while the first call is still up. That is the double-bridge the one-live-session-per-agent rule
   * exists to prevent, reachable in one click, and the constraint cannot see it
   * because both rows satisfy the index once the first has left.
   *
   * `releaseStationOnClose` has carried the same guard for socket close since
   * the socket-close fix; this is the deliberate-leave half of the same rule. The remedy
   * is `POST /attempts/:id/hangup`, or finishing the call — the dialer runtime will not end a
   * live conversation as a side effect of an agent tidying up.
   *
   * The console has no copy for this one, a narrow gap rather than an oversight:
   * `agencyStationExit.ts` blocks Leave client-side for `reserved` / `on_call` /
   * `wrapup`, so this refusal is the backstop for the race where state changes
   * between render and click. It is listed because the union is the full contract,
   * not the subset the console renders.
   */
  | 'agent_on_live_call'
  /** The agent has no attached station socket, so they cannot go available. */
  | 'no_station'
  /**
   * Hangup was asked for on an attempt this replica is not bridging, and whose row
   * is not terminal either. Distinct from a terminal attempt, which is
   * an idempotent success — an agent's hangup routinely races the customer's, and
   * erroring on that would show a failure for the thing that just happened.
   *
   * Reachable in exactly one situation today: the bridging replica restarted while
   * the row was live. The bridge session is in-process memory and there is
   * no cross-replica hangup channel, so the dialer runtime says so instead of returning a
   * success that hangs up nothing.
   */
  | 'attempt_not_live'
  | 'campaign_not_running'
  /** The agency dialer flag is off for this tenant/account. */
  | 'feature_disabled';

/**
 * Runtime list of {@link AgencyActionErrorCode} (the union above is the
 * authority).
 *
 * ⚠️ **18 members, not 16** — any older note saying 16 predates
 * `session_on_other_campaign` and `agent_on_live_call`. `test/errors.test.ts`
 * snapshots the list.
 *
 * Order is the declaration order of the union.
 */
export const AGENCY_ACTION_ERROR_CODES = [
  'missing_actor',
  'not_your_attempt',
  'unknown_disposition_code',
  'invalid_dnc_scope',
  'note_required',
  'datetime_required',
  'invalid_callback_at',
  'attempt_not_dispositionable',
  'already_dispositioned',
  'unknown_break_reason',
  'break_already_applied',
  'session_ended',
  'session_on_other_campaign',
  'agent_on_live_call',
  'no_station',
  'attempt_not_live',
  'campaign_not_running',
  'feature_disabled',
] as const satisfies readonly AgencyActionErrorCode[];

/**
 * Exhaustiveness in the other direction: every member of the union appears in the
 * list. `satisfies` alone only proves the list holds *valid* codes, not *all* of
 * them, and a missing entry is the failure mode that matters here.
 */
const _allCodesListed: AllListed<AgencyActionErrorCode, typeof AGENCY_ACTION_ERROR_CODES> = true;
void _allCodesListed;

// ─── 2. Roster refusal codes ────────────────────────────────────────────────
//
// The 409 codes of the destructive roster change (`POST /proxy/agency/campaigns/:id/
// roster/clear`, registered only under `AGENCY_ROSTER_REPLACE_ENABLED`). That route
// forwards the supersede's `coreCode` unchanged. Nothing emits these yet: the
// supersede is not implemented (decision B15) and always fails `unsupported`. The
// specification of record is `supersedeRoster` in `agency-roster.client.ts`; this
// is that specification as a value.

/**
 * Why a destructive roster change was refused.
 *
 * Deliberately NOT members of {@link AgencyActionErrorCode}: these are
 * campaign-lifecycle refusals raised by the roster-replace path, and folding them
 * into the action union would make it claim members the dialer runtime's runtime does not raise
 * there.
 */
export type AgencyRosterRefusalCode =
  /** The campaign can dial right now, so retiring its roster is refused. */
  | 'campaign_dialing'
  /** A dial attempt is live; the dialer runtime refuses until it settles. */
  | 'attempts_live'
  /**
   * The compare-and-swap failed: the roster is not the size the operator was
   * shown, so "retire everything" is not what they asked for. The remedy is to
   * re-read the count and confirm again — never a bare retry, which re-asserts
   * the same stale number.
   */
  | 'contacts_total_mismatch';

/**
 * Runtime list of the union above.
 *
 * `satisfies` pins it to the type, so a code added to the union and forgotten
 * here is a compile error rather than a code the console cannot name.
 */
export const AGENCY_ROSTER_REFUSAL_CODES = [
  'campaign_dialing',
  'attempts_live',
  'contacts_total_mismatch',
] as const satisfies readonly AgencyRosterRefusalCode[];

/**
 * Exhaustiveness in the other direction: every member of the union appears in
 * the list. `satisfies` alone only proves the list holds *valid* codes, not
 * *all* of them, and a missing entry is the failure mode that matters here.
 */
const _allRosterCodesListed: AllListed<
  AgencyRosterRefusalCode,
  typeof AGENCY_ROSTER_REFUSAL_CODES
> = true;
void _allRosterCodesListed;

// ─── 3. Campaign-lifecycle codes ────────────────────────────────────────────
//
// These are deliberately OUTSIDE `AGENCY_ACTION_ERROR_CODES` because they are not
// members of the action union: they are the campaign routes' refusals, not an
// agent action's. The member set is exactly the seven campaign-lifecycle codes below.

export type AgencyCampaignLifecycleErrorCode =
  /**
   * The one-running-campaign-per-account rule surfacing as a 409 instead of a
   * raw unique violation. The remedy is "pause the other campaign first".
   */
  | 'another_campaign_running'
  /** Carries `current_status` so the console can re-sync rather than guess. */
  | 'invalid_campaign_transition'
  | 'campaign_not_found'
  /** `POST /:id/start` on a campaign that never had a roster: "upload a roster". */
  | 'campaign_roster_empty'
  /**
   * `POST /:id/start` on a campaign whose roster is fully worked: "upload a fresh
   * one". Its message states the exhausted count.
   */
  | 'campaign_roster_exhausted'
  /** `abandon_announcement_id` names no active announcement on the account. */
  | 'announcement_not_found'
  /**
   * `analysis_profile_id` names a profile this account does not own, or one that
   * no longer exists (the dialer runtime `analysis/profile-preflight.ts`).
   */
  | 'analysis_profile_not_found';

export const AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES = [
  'another_campaign_running',
  'invalid_campaign_transition',
  'campaign_not_found',
  'campaign_roster_empty',
  'campaign_roster_exhausted',
  'announcement_not_found',
  'analysis_profile_not_found',
] as const satisfies readonly AgencyCampaignLifecycleErrorCode[];

const _allLifecycleCodesListed: AllListed<
  AgencyCampaignLifecycleErrorCode,
  typeof AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES
> = true;
void _allLifecycleCodesListed;

// ─── 4. Soft-phone refusals ─────────────────────────────────────────────────
//
// The codes of the soft-phone routes (`/proxy/agency/softphone/*`, `docs/softphone.md`
// §6) and the two soft-phone refusals the campaign session routes raise
// (`wrong_session_kind`, `manual_call_live`). Outside the action union for the same
// reason the lifecycle codes are: these are not an attempt action's refusals, and
// folding them in would make that union claim members its routes never raise. The
// body is `AgencySoftphoneErrorResponse` (`./agency/softphone`), narrowed per code
// where a refusal carries structured fields. HTTP status beside each code.

/** Why a soft-phone route refused. */
export type AgencySoftphoneErrorCode =
  /** 403. `agency_softphone_enabled` is off for this tenant/account (SP4), on a route that starts work (open a session, dial, switch) or the recording / settings. Finishing a call is never refused by it. */
  | 'softphone_disabled'
  /** 400. `to` does not normalise to a dialable E.164 number. */
  | 'invalid_number'
  /** 400. `caller_id` is not the tag's `caller_ids`, or not one of the account's numbers when untagged. `allowed_codes` lists the allowed set. */
  | 'caller_id_not_allowed'
  /** 403. `campaign_id` is not a campaign the caller may log to (bootstrap's `taggable_campaigns`). */
  | 'campaign_not_taggable'
  /** 409. The number is on the DNC list (SP1). Overridable with `overrides.dnc_note`; carries the entry. */
  | 'dnc_listed'
  /** 503. The DNC lookup failed. Fails closed and cannot be overridden (SP1). */
  | 'dnc_unavailable'
  /** 409. The tagged campaign's calling window is closed (SP2). Overridable with `overrides.hours_note`. */
  | 'outside_calling_hours'
  /** 400. An override note is outside `SOFTPHONE_OVERRIDE_NOTE_MIN`–`_MAX` characters after trimming. */
  | 'override_note_invalid'
  /** 409. A campaign attempt is live on the matched roster contact. No override (§4.1 step 2). */
  | 'contact_in_flight'
  /** 409. `POST /sessions` while the agent is live on a campaign; switch that session instead (§4.2). */
  | 'session_on_campaign'
  /** 409. The campaign join while the agent's live session is a soft-phone session. */
  | 'session_on_softphone'
  /** 404. `session_id` is not the caller's live session in this tenant. */
  | 'session_not_found'
  /** 409. A campaign session route (`available`, `break`, `break/cancel`, `force-available`) on a soft-phone session, or a switch route on one. */
  | 'wrong_session_kind'
  /** 409. A dial from a session that is not on the soft phone (`break/soft_phone`), e.g. a campaign session that has not switched yet. */
  | 'not_on_softphone'
  /** 409. The session has a manual call that is live (or, for `/softphone/return` and `available`, ended and awaiting its outcome). */
  | 'manual_call_live'
  /** 409. A dial while the session's last call awaits its outcome: one unsettled call per session. */
  | 'outcome_pending'
  /** 429. The account, provider or global concurrency guard refused the dial. */
  | 'concurrency_limit'
  /** 409. The session has no attached station socket to dial the agent leg on. */
  | 'station_unavailable'
  /** 503. The dial could not be placed for a reason that is not the caller's: the agent state store did not answer, or the bridge refused in a way this version does not name. Nothing was dialled; retry. Also the switch to the soft phone and the return from it when the agent state store cannot take the write: nothing changed. */
  | 'dial_failed'
  /** 404. No such call, or one the caller may not see (an agent sees only their own). */
  | 'call_not_found'
  /** 409. The call's outcome is already saved (with a different code) or lapsed. */
  | 'call_settled'
  /** 400. The outcome code is not in the call's catalog (`allowed_codes` is set), or its note / callback time is missing or invalid. */
  | 'disposition_invalid'
  /** 400. A call-field value is of the wrong type, an unknown key, or a required field is empty on the outcome. `details` per key. */
  | 'fields_invalid'
  /** 400. `PUT /settings` body is invalid (catalog, call fields, profile or caller ID). `details` per path. */
  | 'settings_invalid';

/** Runtime list of {@link AgencySoftphoneErrorCode}, in declaration order. */
export const AGENCY_SOFTPHONE_ERROR_CODES = [
  'softphone_disabled',
  'invalid_number',
  'caller_id_not_allowed',
  'campaign_not_taggable',
  'dnc_listed',
  'dnc_unavailable',
  'outside_calling_hours',
  'override_note_invalid',
  'contact_in_flight',
  'session_on_campaign',
  'session_on_softphone',
  'session_not_found',
  'wrong_session_kind',
  'not_on_softphone',
  'manual_call_live',
  'outcome_pending',
  'concurrency_limit',
  'station_unavailable',
  'dial_failed',
  'call_not_found',
  'call_settled',
  'disposition_invalid',
  'fields_invalid',
  'settings_invalid',
] as const satisfies readonly AgencySoftphoneErrorCode[];

const _allSoftphoneCodesListed: AllListed<
  AgencySoftphoneErrorCode,
  typeof AGENCY_SOFTPHONE_ERROR_CODES
> = true;
void _allSoftphoneCodesListed;
