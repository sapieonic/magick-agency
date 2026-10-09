/**
 * Why a destructive roster change is refused: the 409 codes in the specification
 * of `POST /internal/agency-campaigns/:id/roster/supersede`.
 *
 * ── Why this list exists separately from the action codes ────────────────────
 * These are not members of `AgencyActionErrorCode` (`@magick-agency/contracts`):
 * they are campaign-lifecycle refusals raised by the supersede, and folding them
 * in would make that union claim members the agent actions never emit.
 *
 * ── Why the codes matter ─────────────────────────────────────────────────────
 * The roster clear route answers 409 with `code: err.coreCode` — a *variable*, so
 * nothing about the call site says which strings can arrive. Each of these
 * refusals is something the operator can fix in seconds (pause the campaign, wait
 * for the live attempt, re-read the count and confirm again), so the code has to
 * reach the console intact; "contact support" is the one answer that helps with
 * none of them.
 *
 * ── Nothing emits them yet ───────────────────────────────────────────────────
 * The supersede is not implemented (decision B15; `AGENCY_ROSTER_REPLACE_ENABLED`
 * is off for that reason): `supersedeRoster` always fails `unsupported`. The
 * specification in `supersedeRoster`'s docstring is the contract of record, and
 * this is that specification as a value.
 */
export type AgencyRosterRefusalCode =
  /** The campaign can dial right now, so retiring its roster is refused. */
  | 'campaign_dialing'
  /** A dial attempt is live; the supersede refuses until it settles. */
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
 * `satisfies` ties it to the type, so a code that is not in the union is a
 * compile error.
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
