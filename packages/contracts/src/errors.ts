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
   * session per agent (across tenants since 0035; a live session in another tenant is `session_in_other_tenant`), because the reservation CAS key is per SESSION
   * (`agency:agent:{sessionId}:state`) while a human has one pair of ears — two
   * live sessions are two independently reservable agents and two customers
   * bridged into one headset.
   *
   * The only member of this union that sets `campaign_id` / `campaign_name` /
   * `state` / `session_id` / `account_id` / `account_name`; see
   * {@link AgencySessionCampaignConflict}, which narrows this shape for it. Those fields are read against this code exactly as `allowed_codes` is
   * read against its three producers — nothing else sets them.
   */
  | 'session_on_other_campaign'
  /**
   * `POST /sessions/:id/leave` refused: this replica is still driving an attempt
   * for the session.
   *
   * Not a politeness. Leaving clears the lease and sets `left_at`, and a left row
   * no longer participates in `uq_agency_agent_live_agent` — so an `on_call`
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
  | 'feature_disabled'
  /**
   * `POST /sessions` refused (403): the caller is not actively staffed on this campaign
   * (`agency_campaign_agents`, the rows `/my-assignments` lists) and their ROLE does not
   * hold `agency.supervise`. Staffing narrows where an agent may START a session; it
   * grants nothing, and a supervisor covering a shift still joins any campaign.
   *
   * Only a NEW session is refused. Re-bootstrapping the agent's own live session on
   * this campaign (a page reload, an app resume) is not: an agent unassigned mid-shift
   * keeps that session until they leave it, because refusing the rehydrate would strand
   * a live call on a station they can no longer open. Leaving ends it; the next join is
   * refused.
   */
  | 'not_staffed'
  /**
   * `POST /sessions/:id/break` with the mobile app's `device_away` or `phone_call` reason refused (409):
   * the agent's state kept changing under the request (every compare-and-swap lost to a
   * reservation or a release, re-decided and lost again). Nothing changed; retry. A
   * concurrency refusal, not a fault, so it is a 4xx the error mask passes unchanged.
   */
  | 'state_changing'
  /**
   * `POST /sessions/:id/redial` refused. The statuses the route answers with it:
   *  - 400: the request named no well-formed attempt id;
   *  - 404: the attempt is not this session's to redial (missing, another session's,
   *    another tenant's: one answer, so nothing is learned about calls that are not
   *    yours);
   *  - 409: the campaign does not allow wrap-up redial (or is not running), the session
   *    is not in a wrap-up for this attempt, redial is not offered on this wrap-up, the
   *    attempt is not one an outcome is owed on, or the customer is no longer held for it.
   * Nothing changed; the agent can still save the outcome. The other redial codes below
   * are 409, except `redial_blocked`, which is also 503 when the agent's state could not
   * be read.
   */
  | 'redial_not_allowed'
  /** `POST /sessions/:id/redial` refused (409): `AGENCY_WRAPUP_REDIAL_LIMIT` redials already made. */
  | 'redial_limit_reached'
  /** `POST /sessions/:id/redial` refused (409): an outcome is already saved for this call. */
  | 'disposition_already_submitted'
  /**
   * `POST /sessions/:id/redial` refused (409) by the pre-dial checks: the number is on a
   * do-not-call list. The agent stays in wrap-up and can still save the outcome.
   */
  | 'redial_blocked_dnc'
  /** As `redial_blocked_dnc`, for the contact's calling window being closed. */
  | 'redial_blocked_calling_hours'
  /**
   * As `redial_blocked_dnc` (409), for every other reason the dial could not be placed:
   * an invalid number, the DNC registry unreachable (fails closed), no usable caller ID,
   * or the agent's station not connected. 503 when the agent's state could not be read
   * (Redis did not answer): nothing changed, try again. `message` says which.
   */
  | 'redial_blocked'
  /**
   * 409 (OS3): another device holds this session's station and the request (the campaign join,
   * the soft-phone open or `POST /sessions/:id/station-token`) did not ask to take it over.
   * Nothing changed. Body: `AgencyStationOnOtherDeviceRefusal` (`./agency/station-device`).
   * The soft-phone open answers it (and `session_in_other_tenant`) with this union's code, not
   * the soft-phone union's: the two unions never share a string.
   */
  | 'station_on_other_device'
  /**
   * The campaign join or the soft-phone open refused (409, OS1): the agent is live, on a campaign
   * or the soft phone, in ANOTHER tenant. One live session per agent across every tenant. Body:
   * `AgencySessionInOtherTenantRefusal`.
   */
  | 'session_in_other_tenant'
  /**
   * `POST /sessions/:id/force-available` refused (409, Mode B, IQ67): the agent is on `away_ring`,
   * away from the app with their phone ringing for inbound callers. There is no station to make
   * them available on (the release would write them `offline` and end their ringing). Nothing
   * changed; force-break and sign-off work as before.
   */
  | 'agent_away_ring'
  // ── Promise to pay (PT8): the disposition's promise fields. 400s; nothing was written.
  /** The catalog entry sets `requires_promise` and `promise_date` was absent. */
  | 'promise_required'
  /**
   * `promise_date` is not a real `YYYY-MM-DD` date, is before the customer's today (the
   * contact's timezone, else the campaign's) or more than `AGENCY_PROMISE_MAX_DAYS_AHEAD`
   * days after it.
   */
  | 'invalid_promise_date'
  /** `promise_amount` is not a decimal ≥ 0 with at most two places and twelve digits before them. */
  | 'invalid_promise_amount'
  /** A promise was sent with an outcome whose entry does not set `requires_promise`. */
  | 'promise_not_expected';

/**
 * Runtime list of {@link AgencyActionErrorCode} (the union above is the
 * authority).
 *
 * ⚠️ **33 members** — 16 before `session_on_other_campaign` and
 * `agent_on_live_call`, 18 before `not_staffed`, 19 before `state_changing`, 20 before
 * the six wrap-up redial codes, 26 before `station_on_other_device` and
 * `session_in_other_tenant` (OS1, OS3), 28 before `agent_away_ring` (Mode B), 29 before the
 * four promise-to-pay codes (PT8).
 * `test/errors.test.ts` snapshots the list.
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
  'not_staffed',
  'state_changing',
  'redial_not_allowed',
  'redial_limit_reached',
  'disposition_already_submitted',
  'redial_blocked_dnc',
  'redial_blocked_calling_hours',
  'redial_blocked',
  'station_on_other_device',
  'session_in_other_tenant',
  'agent_away_ring',
  'promise_required',
  'invalid_promise_date',
  'invalid_promise_amount',
  'promise_not_expected',
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
// agent action's. The member set is exactly the eleven campaign-lifecycle codes below.
// `another_campaign_running` is retired (decisions MC6): an account may run several
// campaigns at once, so Start and Resume no longer refuse on another running campaign.

export type AgencyCampaignLifecycleErrorCode =
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
  | 'analysis_profile_not_found'
  /**
   * 404. `telephony_credential_id` names no carrier credential of this tenant on the
   * campaign's `telephony_provider` (unknown, another tenant's, or another carrier's:
   * the three are not told apart).
   */
  | 'telephony_credential_not_found'
  /**
   * 409. The tenant carrier credential is not `active` (disabled, invalid or revoked):
   * a campaign cannot be pinned to it, and a campaign pinned to it cannot start or
   * resume until a platform administrator re-enables it or the campaign is moved.
   */
  | 'telephony_credential_not_active'
  /**
   * 409. Start or resume of a campaign on a tenant's own carrier account none of whose
   * caller IDs is still active on that account and available to the campaign's account
   * (decision PL13): it would run and place no calls.
   */
  | 'campaign_caller_ids_unavailable'
  /**
   * 409. Start or resume of a campaign whose account splits its concurrency by carrier
   * and gives the campaign's carrier no lines (decision PL14): it would run and place no
   * calls. Support adds the capacity.
   */
  | 'carrier_capacity_unallocated'
  /**
   * 409. `POST /:id/start` on an archived draft (decisions AR2): restore it first. Carries
   * `current_status` and `archived_at`. Also one of the archive routes' own codes
   * ({@link AgencyCampaignArchiveErrorCode}).
   */
  | 'campaign_archived';

export const AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES = [
  'invalid_campaign_transition',
  'campaign_not_found',
  'campaign_roster_empty',
  'campaign_roster_exhausted',
  'announcement_not_found',
  'analysis_profile_not_found',
  'telephony_credential_not_found',
  'telephony_credential_not_active',
  'campaign_caller_ids_unavailable',
  'carrier_capacity_unallocated',
  'campaign_archived',
] as const satisfies readonly AgencyCampaignLifecycleErrorCode[];

const _allLifecycleCodesListed: AllListed<
  AgencyCampaignLifecycleErrorCode,
  typeof AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES
> = true;
void _allLifecycleCodesListed;

// ─── 3a. Campaign archive codes (decisions AR1–AR7) ─────────────────────────
//
// The 409s of `POST /proxy/agency/campaigns/:id/{archive,unarchive}`. Each carries
// `current_status` and `archived_at` as the row stands. `campaign_archived` is also a
// lifecycle code (Start on an archived draft), so it is in both lists.

export type AgencyCampaignArchiveErrorCode =
  /** Archive of a campaign that is not `draft` or `stopped`. */
  | 'campaign_not_archivable'
  /** Archive of a campaign already archived. */
  | 'campaign_archived'
  /** Restore (`/unarchive`) of a campaign that is not archived. */
  | 'campaign_not_archived';

export const AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES = [
  'campaign_not_archivable',
  'campaign_archived',
  'campaign_not_archived',
] as const satisfies readonly AgencyCampaignArchiveErrorCode[];

const _allArchiveCodesListed: AllListed<
  AgencyCampaignArchiveErrorCode,
  typeof AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES
> = true;
void _allArchiveCodesListed;

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
  /** 403. `agency_softphone_enabled` is off for this tenant/account (SP4), on a route that starts work (open a NEW session, dial, switch) or the recording / settings. Finishing a call is never refused by it. */
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
  /** 409. `POST /sessions` while the agent is live on a campaign (in this account or a sibling one: `account_id`); switch that session instead (§4.2). */
  | 'session_on_campaign'
  /** 409. The campaign join while the agent's live session is a soft-phone session; and `POST /sessions` while it is one in another account (`account_id`). */
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
  /** 429. The account, provider or global concurrency guard refused the dial, or the carrier account's calls-per-second limit gave it no slot. Nothing was dialled; retry in a moment. */
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
  | 'settings_invalid'
  /** 409. Contact assignment: the tagged campaign is `strict` and the number's contact belongs to another agent. A supervisor is not refused. */
  | 'contact_assigned_elsewhere'
  /** 409. The carrier account the caller ID's number is on cannot place calls: it is no longer active (disabled, invalid, revoked) or the carrier refused its credentials. Nothing was dialled, and retrying cannot help until support has fixed the account; another caller ID may. */
  | 'carrier_account_unavailable'
  /** 409. The number is on an inbound call to the account right now: the customer is waiting for an agent, talking to one, or their call's outcome is still owed (docs/inbound.md §5.4, MC4). No override; `inbound_call_id` names the call. */
  | 'customer_on_inbound_call';

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
  'contact_assigned_elsewhere',
  'carrier_account_unavailable',
  'customer_on_inbound_call',
] as const satisfies readonly AgencySoftphoneErrorCode[];

const _allSoftphoneCodesListed: AllListed<
  AgencySoftphoneErrorCode,
  typeof AGENCY_SOFTPHONE_ERROR_CODES
> = true;
void _allSoftphoneCodesListed;

// ─── 5. Report refusals ─────────────────────────────────────────────────────
//
// The codes of the report routes (`/proxy/agency/reports*`, `/proxy/agency/report-subscriptions*`,
// docs/reports.md; shapes in `./api/agency/reports`). Outside the action union for the lifecycle
// codes' reason: these are not an attempt action's refusals. The body is `{ error, code, message }`.
// HTTP status beside each code. The flag gate (`agency_reports_enabled` off) answers the dialer
// gate's `403 feature_disabled`, not one of these.

/** Why a report route refused. */
export type AgencyReportErrorCode =
  /** 400. `from` or `to` is not a `YYYY-MM-DD` date, `to` is before `from`, or `to` is after today in the report zone. */
  | 'report_window_invalid'
  /** 400. More than `REPORT_MAX_WINDOW_DAYS` local days and not exactly one calendar month (RP2). */
  | 'report_window_too_long'
  /** 400. `timezone` is missing (agent, account) or not an IANA zone the server knows. */
  | 'report_timezone_invalid'
  /** 404. The subject (agent, campaign or account), or an id in `campaign_ids`, is not one the caller may report on in this account. */
  | 'report_subject_not_found'
  /** 429. The tenant already has `AGENCY_REPORTS_TENANT_PENDING_LIMIT` runs queued, assembling or rendering. Retry when one finishes. */
  | 'report_queue_full'
  /** 429. The caller asked for more than `AGENCY_REPORTS_USER_PER_MINUTE` ad hoc runs in the last minute. */
  | 'report_rate_limited'
  /** 404. No such run, or one the caller may not see. */
  | 'report_not_found'
  /** 409. A download of a run that is not `ready` (still in flight, or `failed`). */
  | 'report_not_ready'
  /** 410. A download of a run past its `expires_at` (RP8): its files are gone. */
  | 'report_expired'
  /** 404. A download in a format the run did not produce. */
  | 'report_format_unavailable'
  /** 404. No such subscription in this account. */
  | 'report_subscription_not_found'
  /** 400. The schedule is inconsistent: a day field missing for its cadence or set for another, or a malformed `send_local_time`. */
  | 'report_subscription_invalid'
  /** 400. A recipient is not a member of the tenant with `agency.supervise` on the account (RP4), or there are too many. */
  | 'report_recipient_invalid';

/** Runtime list of {@link AgencyReportErrorCode}, in declaration order. */
export const AGENCY_REPORT_ERROR_CODES = [
  'report_window_invalid',
  'report_window_too_long',
  'report_timezone_invalid',
  'report_subject_not_found',
  'report_queue_full',
  'report_rate_limited',
  'report_not_found',
  'report_not_ready',
  'report_expired',
  'report_format_unavailable',
  'report_subscription_not_found',
  'report_subscription_invalid',
  'report_recipient_invalid',
] as const satisfies readonly AgencyReportErrorCode[];

const _allReportCodesListed: AllListed<
  AgencyReportErrorCode,
  typeof AGENCY_REPORT_ERROR_CODES
> = true;
void _allReportCodesListed;

// ─── 6. Inbound refusals ────────────────────────────────────────────────────
//
// The codes of the account's inbound routes (`/proxy/agency/inbound/*`, docs/inbound.md §7, §8;
// shapes in `./api/agency/inbound`). The body is `{ error, message, details? }`. HTTP status
// beside each code. The route repository's refusal reasons map onto them one to one
// (`apps/server/src/db/repositories/agency/inbound-route.repository.ts`).
//
// P2 adds the inbound CALL's codes (the agent's panel, docs/inbound.md §6): its finish routes
// (`/proxy/agency/inbound/calls/*`), and `inbound_call_live`, which the campaign session routes
// answer beside their action codes (as they answer the soft phone's `manual_call_live`). None of
// them may overlap the action, soft-phone or report unions (`test/errors.test.ts`), so the outcome
// refusal is `inbound_disposition_invalid`, not the soft phone's `disposition_invalid`.

/** Why an inbound route refused. */
export type AgencyInboundErrorCode =
  /** 403. `agency_inbound_enabled` is off for the tenant or account. */
  | 'inbound_disabled'
  /** 400. The route body is invalid; `details` lists `{ path, message }` per problem (`weekly_hours[2].end`, `clips.greeting`, …). */
  | 'inbound_route_invalid'
  /** 404. No such live route in this account. */
  | 'inbound_route_not_found'
  /** 409. Another live route of the account has this name (case-insensitive). */
  | 'inbound_route_name_taken'
  /** 409. A number is not one of the tenant's active numbers this account may use. `details.phone_number_id`. */
  | 'inbound_number_not_found'
  /** 409. A number is not linked to inbound: only the service's operators link numbers (IB6, PL15, "contact support"). `details.phone_number_id`. */
  | 'inbound_number_not_linked'
  /** 409. A number already answers another live route. `details.phone_number_id`, `details.route_id`. */
  | 'inbound_number_in_use'
  /** 404. No such Missed inbound row the caller may see. */
  | 'inbound_missed_call_not_found'
  /** 409. `POST /sessions/:id/available`, `force-available`, `leave` and the return from the soft phone (P2): the session holds an inbound call that is offered, connected or awaiting its outcome. `inbound_call_id` names it. */
  | 'inbound_call_live'
  /** 404. No such inbound call the caller may act on (the agent who took it, or `agency.supervise`). */
  | 'inbound_call_not_found'
  /** 409. The call cannot take an outcome: it is still live, or it ended without reaching an agent. */
  | 'inbound_call_not_dispositionable'
  /** 400. The outcome code is not in the call's catalog (`allowed_codes`), or its note or callback time is missing or invalid (`reason`). */
  | 'inbound_disposition_invalid'
  /** 409. Another outcome is already saved on the call, or it lapsed `no_disposition`. */
  | 'inbound_outcome_already_saved'
  /** 404. No such recording (audio file) in this account. */
  | 'inbound_clip_not_found'
  /** 409. A live route of the account plays the recording; `routes` names them. Choose another recording there first. */
  | 'inbound_clip_in_use'
  /** 400 (413 when the file is over the size limit). The upload is not a usable recording; `upload_reason` says why. */
  | 'inbound_clip_invalid'
  /** 409. Another recording of the account already has that name. */
  | 'inbound_clip_name_taken'
  /** 503. This deployment has no audio storage, so recordings cannot be uploaded. */
  | 'inbound_clip_storage_unavailable'
  /** 409. `POST /inbound/missed/:id/assign` and `/claim`: the Missed row is already handled (marked, or closed because the customer was reached); a follow-up that is done is not handed on. */
  | 'inbound_missed_call_handled'
  /** 400. `POST /inbound/missed/:id/assign`: the person named is not an active member who can work this account's Missed calls. */
  | 'inbound_assignee_invalid'
  /**
   * 409. `POST /inbound/missed/:id/claim` (IQ49): the row is no longer unassigned: someone else
   * claimed it first, or a supervisor gave it to someone. Nothing changed; refresh the Team view.
   */
  | 'inbound_missed_call_claimed'
  /**
   * 404 (Mode B, IQ71). The ring routes (`…/ring/answering`, `…/ring/decline`, `…/ring/accept`):
   * no ring on this call answers to that offer token (unknown, spent, expired, or the call is
   * not ringing). Uniform on purpose, so a token-only route says nothing about a wrong token.
   */
  | 'ring_not_offered'
  /**
   * 409 (Mode B). `…/ring/accept` after the ring window and, once answered, the accept grace ran
   * out (`AGENCY_INBOUND_RING_MS`, `AGENCY_INBOUND_ACCEPT_GRACE_MS`): the caller has moved on.
   */
  | 'ring_expired'
  /**
   * 409 (Mode B, N4). `…/ring/answering` or `…/ring/decline` after the ring was accepted: the
   * station's hang-up is the way out from here.
   */
  | 'already_accepted';

/** Runtime list of {@link AgencyInboundErrorCode}, in declaration order. */
export const AGENCY_INBOUND_ERROR_CODES = [
  'inbound_disabled',
  'inbound_route_invalid',
  'inbound_route_not_found',
  'inbound_route_name_taken',
  'inbound_number_not_found',
  'inbound_number_not_linked',
  'inbound_number_in_use',
  'inbound_missed_call_not_found',
  'inbound_call_live',
  'inbound_call_not_found',
  'inbound_call_not_dispositionable',
  'inbound_disposition_invalid',
  'inbound_outcome_already_saved',
  'inbound_clip_not_found',
  'inbound_clip_in_use',
  'inbound_clip_invalid',
  'inbound_clip_name_taken',
  'inbound_clip_storage_unavailable',
  'inbound_missed_call_handled',
  'inbound_assignee_invalid',
  'inbound_missed_call_claimed',
  'ring_not_offered',
  'ring_expired',
  'already_accepted',
] as const satisfies readonly AgencyInboundErrorCode[];

const _allInboundCodesListed: AllListed<
  AgencyInboundErrorCode,
  typeof AGENCY_INBOUND_ERROR_CODES
> = true;
void _allInboundCodesListed;

// ─── 7. Live call listening refusals ────────────────────────────────────────
//
// The codes of the live-call routes (`/proxy/agency/live-calls*`, docs/listening.md; shapes in
// `./api/agency/live-calls`) and the reason a listener socket is refused at its upgrade (the close
// `reason`, `./agency/listen.ts`). The body is `{ error, code, message }`. HTTP status beside each
// code. The flag gate (`agency_live_listen_enabled` off) answers the dialer gate's
// `403 feature_disabled`, not one of these, as the reports routes do. Three of them double as a
// live row's `not_listenable_reason` (`AGENCY_LIVE_CALL_NOT_LISTENABLE_REASONS`), so the row and
// the grant say the same thing.

/** Why a listen was refused. */
export type AgencyListenErrorCode =
  /**
   * 404. No call the caller may see is live and bridged under that id now: it ended, it never
   * reached an agent, or it is in another account (uniform, so the answer never says a call
   * exists elsewhere). At the upgrade (close 4404): the bridge no longer has the call.
   */
  | 'listen_call_not_live'
  /**
   * 409. The call is not being recorded (`agency_calls.recording_requested` false) and
   * `agency_live_listen_unrecorded` is off for its tenant or account (LS4).
   */
  | 'listen_recording_off'
  /** 409. The call already has `AGENCY_LISTEN_MAX_PER_CALL` listeners (2 by default). Close 4429 at the upgrade. */
  | 'listen_limit_call'
  /** 503. The process that owns the call already carries `AGENCY_LISTEN_MAX_PER_PROCESS` listeners (20 by default). Close 4429 at the upgrade. */
  | 'listen_limit_server'
  /** 409. The caller is the agent on this call (LS3). */
  | 'listen_own_call'
  /**
   * 503. The listen could not be opened for a reason that is not the caller's: the grant could
   * not be stored, the process that owns the call did not answer, or the session row could not be
   * written (no row, no audio: close 1011 at the upgrade). Nothing was opened; try again.
   */
  | 'listen_unavailable';

/** Runtime list of {@link AgencyListenErrorCode}, in declaration order. */
export const AGENCY_LISTEN_ERROR_CODES = [
  'listen_call_not_live',
  'listen_recording_off',
  'listen_limit_call',
  'listen_limit_server',
  'listen_own_call',
  'listen_unavailable',
] as const satisfies readonly AgencyListenErrorCode[];

const _allListenCodesListed: AllListed<
  AgencyListenErrorCode,
  typeof AGENCY_LISTEN_ERROR_CODES
> = true;
void _allListenCodesListed;

/**
 * Why the number reveal (`GET /live-calls/:callId/number`) has no number to show, apart from the
 * listen codes (a call not live there is still `listen_call_not_live`):
 *  - `live_call_number_withheld`: 404. The caller withheld their number (an inbound caller with no
 *    readable number). The live row says so first (`customer_phone_withheld`), so the console
 *    offers no Show for it; this answers a reveal asked for anyway.
 * Its own union rather than a listen code, so the listen codes (the grant's refusals, a live row's
 * reasons, the console's copy for each) are unchanged by it.
 */
export type AgencyLiveCallNumberErrorCode = 'live_call_number_withheld';

/** Runtime list of {@link AgencyLiveCallNumberErrorCode}. */
export const AGENCY_LIVE_CALL_NUMBER_ERROR_CODES = [
  'live_call_number_withheld',
] as const satisfies readonly AgencyLiveCallNumberErrorCode[];

const _allLiveCallNumberCodesListed: AllListed<
  AgencyLiveCallNumberErrorCode,
  typeof AGENCY_LIVE_CALL_NUMBER_ERROR_CODES
> = true;
void _allLiveCallNumberCodesListed;

// ─── 8. Floor assist refusals (Need help and supervisor messages) ───────────
//
// The codes of `POST`/`DELETE /proxy/agency/sessions/:id/help` and
// `POST /proxy/agency/sessions/:id/messages` (LF4, LF5; shapes in `./agency/floor-assist.ts`). The
// body is `{ error, code, message }`. HTTP status beside each code. A session that is not the
// caller's own (Need help), or not in the caller's account (messages), is the agent routes'
// uniform `404 { error: 'Not Found', message: 'Session not found' }`, with no code, so the answer
// never says a session exists elsewhere; a Need help on a session that has ended is the action
// union's `409 session_ended`.

/** Why a Need help or a supervisor message was refused. */
export type AgencyFloorAssistErrorCode =
  /** 403. `agency_floor_assist_enabled` is off for the account (LF11). */
  | 'floor_assist_disabled'
  /** 409. Need help is raised during a call or wrap-up (a soft-phone call, live or owing its outcome, included). */
  | 'help_not_on_call'
  /**
   * 409. The agent has no live station that can receive the message: no station socket attached
   * (or the session has ended), or an app build that cannot show it. Nothing was shown.
   */
  | 'agent_not_live'
  /** 400. The message's `text` is missing, empty after trimming, or longer than `AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS`. */
  | 'message_invalid';

/** Runtime list of {@link AgencyFloorAssistErrorCode}, in declaration order. */
export const AGENCY_FLOOR_ASSIST_ERROR_CODES = [
  'floor_assist_disabled',
  'help_not_on_call',
  'agent_not_live',
  'message_invalid',
] as const satisfies readonly AgencyFloorAssistErrorCode[];

const _allFloorAssistCodesListed: AllListed<
  AgencyFloorAssistErrorCode,
  typeof AGENCY_FLOOR_ASSIST_ERROR_CODES
> = true;
void _allFloorAssistCodesListed;

/** The body of a floor assist refusal. */
export interface AgencyFloorAssistErrorResponse {
  error: string;
  code: AgencyFloorAssistErrorCode;
  message: string;
}

// ─── 9. Compare agents refusals ─────────────────────────────────────────────
//
// The codes of the Compare agents routes (`/proxy/agency/compare/*`, docs/compare-agents.md; shapes
// in `./api/agency/compare`). The body is `{ error, code, message }`. HTTP status beside each code.
// The flag gate (`agency_compare_enabled` off) answers the dialer gate's `403 feature_disabled`, and
// a caller without `agency.supervise` the RBAC 403, not one of these. None may overlap the report
// codes (the page is a Reports tab and the console reads both).

/** Why a compare route refused. */
export type AgencyCompareErrorCode =
  /** 400. `campaign_id` is missing: a comparison is always of one campaign (CP8). */
  | 'compare_campaign_required'
  /** 404. `campaign_id` (of a query, the options, a view or the view list) is not a campaign of the context account. Uniform: it never says a campaign exists elsewhere. */
  | 'compare_campaign_not_found'
  /** 400. More than `COMPARE_PAGE_MAX_AGENTS` agents (CP1). */
  | 'compare_too_many_agents'
  /** 400. More than `COMPARE_MAX_METRICS` metrics. */
  | 'compare_too_many_metrics'
  /**
   * 400. A metric or the trend cannot be compared: a malformed ref (`compareMetricRefProblem`), two
   * refs with one id, an outcome code not in the campaign's current catalog, `promises_rate` or
   * `promised_amount` on a catalog without a `requires_promise` entry, or a trend that is not
   * countable.
   */
  | 'compare_metric_invalid'
  /** 400. `from` or `to` is malformed, `to` is before `from` or after today in the zone, or the window is longer than the reports allow (`compareWindowProblem`). */
  | 'compare_window_invalid'
  /** 400. `timezone` is missing or not an IANA zone the server knows. */
  | 'compare_timezone_invalid'
  /** 404. A picked agent has no row in the campaign's cohort for the window (did not dial it, or is not of this account). */
  | 'compare_agent_not_in_cohort'
  /**
   * 429. No compare read could start: the tenant already runs `COMPARE_TENANT_CONCURRENT_READS`, or
   * the server already runs its process-wide limit (a share of its database pool, across tenants).
   * Carries `Retry-After` and `retry_after_seconds`. Retry in a moment.
   */
  | 'compare_busy'
  /**
   * 503. The read ran past `COMPARE_READ_TIMEOUT_MS` and was cancelled. Try a shorter window. A
   * fixed, reviewed body: the server sends it through the error mask's reviewed opt-out so it is
   * not masked as "contact support".
   */
  | 'compare_timed_out'
  /** 404. No such saved view in the account, or (for `PATCH`, `DELETE`) not one the caller owns. */
  | 'compare_view_not_found'
  /** 400. The view is invalid: a bad name, metrics, trend or default (`AgencyCreateCompareViewRequest` lists each). */
  | 'compare_view_invalid'
  /** 409. The caller already owns `COMPARE_VIEWS_PER_USER_MAX` views in the account. */
  | 'compare_view_limit';

/** Runtime list of {@link AgencyCompareErrorCode}, in declaration order. */
export const AGENCY_COMPARE_ERROR_CODES = [
  'compare_campaign_required',
  'compare_campaign_not_found',
  'compare_too_many_agents',
  'compare_too_many_metrics',
  'compare_metric_invalid',
  'compare_window_invalid',
  'compare_timezone_invalid',
  'compare_agent_not_in_cohort',
  'compare_busy',
  'compare_timed_out',
  'compare_view_not_found',
  'compare_view_invalid',
  'compare_view_limit',
] as const satisfies readonly AgencyCompareErrorCode[];

const _allCompareCodesListed: AllListed<
  AgencyCompareErrorCode,
  typeof AGENCY_COMPARE_ERROR_CODES
> = true;
void _allCompareCodesListed;

/** The HTTP status of each compare refusal, for the server's replies and the route tests. */
export const AGENCY_COMPARE_ERROR_STATUS = {
  compare_campaign_required: 400,
  compare_campaign_not_found: 404,
  compare_too_many_agents: 400,
  compare_too_many_metrics: 400,
  compare_metric_invalid: 400,
  compare_window_invalid: 400,
  compare_timezone_invalid: 400,
  compare_agent_not_in_cohort: 404,
  compare_busy: 429,
  compare_timed_out: 503,
  compare_view_not_found: 404,
  compare_view_invalid: 400,
  compare_view_limit: 409,
} as const satisfies Record<AgencyCompareErrorCode, number>;

// ─── 10. Campaign template refusals ─────────────────────────────────────────
//
// The codes of the campaign template routes (`/proxy/agency/campaign-templates/*`,
// docs/campaign-templates.md §6; shapes in `./api/agency/campaign-templates`). The body is
// `{ error, code, message }`, plus the fields each code's comment names. HTTP status beside each
// code. The flag gate (`agency_campaign_templates_enabled` off) answers `403 feature_disabled`, a
// caller without the permission the RBAC 403, and an organisation template written without an
// organisation-wide seat `403 tenant_wide_membership_required` (CT3, as AA1): none of these.

/** Why a campaign template route refused. */
export type AgencyCampaignTemplateErrorCode =
  /**
   * 404. No such template the caller may see: another tenant's, another account's, or a bad id;
   * also a `template_id` (create, effective) or `based_on_template_id` that names none. Uniform: it
   * never says a template exists elsewhere.
   */
  | 'campaign_template_not_found'
  /** 409. `expected_version` is not the template's version: someone saved in between (CT6). Carries `current_version`. */
  | 'campaign_template_changed'
  /** 409. Another live template of the same scope has this name, ignoring case and repeated spaces (CT13). Carries `template` (its id and name). */
  | 'campaign_template_name_taken'
  /** 409. Archive of an organisation template that live account templates are based on (CT14). Carries `templates`, naming them. */
  | 'campaign_template_in_use'
  /**
   * 400. The scope does not fit: `organisation` sent with an account context or `account` without
   * one; `based_on_template_id` on an organisation template, or naming an account template; an
   * account-only section or field on an organisation template (CT5).
   */
  | 'campaign_template_scope_invalid'
  /** 400. A section fails the checks a campaign create runs (CT4). Carries `details`, keyed by the campaign's own field names. */
  | 'campaign_template_section_invalid'
  /** 409. The template is archived: it cannot be edited, made a default, applied, or started from; and a `based_on` may not name one. Restore it first. */
  | 'campaign_template_archived'
  /** 400. The name (trimmed, 1–80 characters, no control or invisible format characters, CT13) or the description (at most 280) is invalid, or the body is malformed. Carries `details`. */
  | 'campaign_template_invalid';

/** Runtime list of {@link AgencyCampaignTemplateErrorCode}, in declaration order. */
export const AGENCY_CAMPAIGN_TEMPLATE_ERROR_CODES = [
  'campaign_template_not_found',
  'campaign_template_changed',
  'campaign_template_name_taken',
  'campaign_template_in_use',
  'campaign_template_scope_invalid',
  'campaign_template_section_invalid',
  'campaign_template_archived',
  'campaign_template_invalid',
] as const satisfies readonly AgencyCampaignTemplateErrorCode[];

const _allCampaignTemplateCodesListed: AllListed<
  AgencyCampaignTemplateErrorCode,
  typeof AGENCY_CAMPAIGN_TEMPLATE_ERROR_CODES
> = true;
void _allCampaignTemplateCodesListed;

/** The HTTP status of each campaign template refusal, for the server's replies and the route tests. */
export const AGENCY_CAMPAIGN_TEMPLATE_ERROR_STATUS = {
  campaign_template_not_found: 404,
  campaign_template_changed: 409,
  campaign_template_name_taken: 409,
  campaign_template_in_use: 409,
  campaign_template_scope_invalid: 400,
  campaign_template_section_invalid: 400,
  campaign_template_archived: 409,
  campaign_template_invalid: 400,
} as const satisfies Record<AgencyCampaignTemplateErrorCode, number>;
