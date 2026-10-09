/**
 * The agency error vocabularies, each as a closed union plus an `as const` list.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * Each vocabulary is declared exactly once, here. Separate copies (the
 * dialer runtime's union, the public API layer's mirror and error-mask
 * allow-list, the console's own copy) would drift: a code added in one place and
 * not the others would be rewritten by the error mask into "contact support and
 * quote this request id" — status intact, explanation destroyed, nothing red
 * anywhere. One application, one file.
 *
 * ── The two-sided exhaustiveness trick ──────────────────────────────────────
 * For every vocabulary:
 *
 *   1. `as const satisfies readonly Union[]` proves every LISTED value is a
 *      member of the union;
 *   2. `Missing = Exclude<Union, (typeof LIST)[number]>` assigned through a
 *      conditional proves every UNION MEMBER is listed.
 *
 * Either direction drifting is a `tsc --noEmit` failure, i.e. `pnpm lint`.
 *
 * Where `./agency` (`./agency`, the frozen contract) already declares a union, it is
 * RE-EXPORTED here, never re-declared — a second declaration is exactly the
 * drift this file exists to end.
 */

import type { AgencyActionErrorCode, AgencyStationErrorCode } from './agency';

export type { AgencyActionErrorCode, AgencyStationErrorCode } from './agency';

// ─── 1. Agent action-route refusals ─────────────────────────────────────────

/**
 * Runtime list of {@link AgencyActionErrorCode} (the union in `./agency` is the
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
type MissingCode = Exclude<AgencyActionErrorCode, (typeof AGENCY_ACTION_ERROR_CODES)[number]>;
const _allCodesListed: MissingCode extends never ? true : MissingCode = true;
void _allCodesListed;

// ─── 2. Roster refusal codes ────────────────────────────────────────────────
//
// The destructive roster change is in-process, and these are simply the refusals
// it answers with (see `AGENCY_ROSTER_REPLACE_ENABLED`).

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
 * here is a compile error rather than a silently masked error body.
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
type MissingRosterCode = Exclude<
  AgencyRosterRefusalCode,
  (typeof AGENCY_ROSTER_REFUSAL_CODES)[number]
>;
const _allRosterCodesListed: MissingRosterCode extends never ? true : MissingRosterCode = true;
void _allRosterCodesListed;

// ─── 3. Campaign-lifecycle codes ────────────────────────────────────────────
//
// These are deliberately OUTSIDE `AGENCY_ACTION_ERROR_CODES` because they are not
// members of the action union; the error mask forwards them by allow-list. The
// member set is exactly the seven campaign-lifecycle codes below.

export type AgencyCampaignLifecycleErrorCode =
  /**
   * D9's one-running-campaign-per-account rule surfacing as a 409 instead of a
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

type MissingLifecycleCode = Exclude<
  AgencyCampaignLifecycleErrorCode,
  (typeof AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES)[number]
>;
const _allLifecycleCodesListed: MissingLifecycleCode extends never
  ? true
  : MissingLifecycleCode = true;
void _allLifecycleCodesListed;

// ─── 4. Station frame error codes ───────────────────────────────────────────

/**
 * Runtime list of {@link AgencyStationErrorCode} — the `code` on an
 * `AgencyStationErrorFrame` (authority: the union in `./agency`).
 *
 * `not_your_attempt` and `campaign_not_running` are ALSO members of
 * {@link AgencyActionErrorCode}; the two vocabularies overlap by design (one is a
 * socket frame, one an HTTP body), and each list states its own union whole.
 * `session_ended` is NOT a station frame code — it is listed beside
 * these only because the error mask allow-lists it via the action list.
 */
export const AGENCY_STATION_ERROR_CODES = [
  'unauthorized',
  'unknown_attempt',
  'not_your_attempt',
  'invalid_frame',
  'campaign_not_running',
] as const satisfies readonly AgencyStationErrorCode[];

type MissingStationCode = Exclude<
  AgencyStationErrorCode,
  (typeof AGENCY_STATION_ERROR_CODES)[number]
>;
const _allStationCodesListed: MissingStationCode extends never
  ? true
  : MissingStationCode = true;
void _allStationCodesListed;
