/**
 * Why core refused a destructive roster change — master's mirror of the refusal
 * codes on `POST /internal/agency-campaigns/:id/roster/supersede`.
 *
 * ── Why this list exists separately from the action codes ────────────────────
 * `agency-action-errors.ts` mirrors core's `AgencyActionErrorCode` union, which
 * this is not a member of: these are campaign-lifecycle refusals raised by the
 * supersede hop, and folding them in would make that mirror claim members core's
 * union does not have — the exact drift the mirror exists to prevent.
 *
 * ── Why the codes need a home in master at all ───────────────────────────────
 * `errorMaskHook` masks any core-forwarded 4xx that carries neither field-level
 * `details` nor an allow-listed `code`. The roster clear route answers 409 with
 * `code: err.coreCode` — a *variable*, so nothing about the call site says which
 * strings can arrive — and all three were being rewritten into "contact support
 * and quote this request id". The status stayed correct and only the remedy was
 * destroyed, which is why nobody noticed: each of these refusals is something
 * the operator can fix in seconds (pause the campaign, wait for the live
 * attempt, re-read the count and confirm again), and a support ticket is the one
 * answer that helps with none of them.
 *
 * ── Why master holds it rather than reading core's source ───────────────────
 * `error-mask.agency-contract.test.ts` scrapes core for exactly this class of
 * drift, and it could not see these: **core does not implement the supersede hop
 * yet** (`AGENCY_ROSTER_REPLACE_ENABLED` is off for that reason), so there is no
 * `code:` literal in core to scrape. The specification in `supersedeRoster`'s
 * docstring is the contract of record until core ships it, and this is that
 * specification as a value. When core does ship it, the drift detector takes
 * over as the mechanism for anything core adds — and the list below being wrong
 * then fails that test rather than this one.
 *
 * A code arriving that is NOT listed here is masked, deliberately: an
 * unrecognised refusal may carry unreviewed upstream text, and fail-closed is
 * the right default for a body master cannot vouch for.
 */
export type AgencyRosterRefusalCode =
  /** The campaign can dial right now, so retiring its roster is refused. */
  | 'campaign_dialing'
  /** A dial attempt is live; core refuses until it settles. */
  | 'attempts_live'
  /**
   * The compare-and-swap failed: the roster is not the size the operator was
   * shown, so "retire everything" is not what they asked for. The remedy is to
   * re-read the count and confirm again — never a bare retry, which re-asserts
   * the same stale number.
   */
  | 'contacts_total_mismatch';

/**
 * Runtime list of the union above, for the error mask's allow-list.
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
