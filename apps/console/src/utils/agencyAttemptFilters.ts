import { addDays, startOfDay } from 'date-fns';
import type { AgencyAttempt, AgencyAttemptFilters } from '../types/agency-spine';

/**
 * The filter arithmetic behind the cross-campaign attempt lists — "My calls" at
 * `/dialer/attempts` and its supervisor twin on `AgencyAnalyticsPage`.
 *
 * A LEAF module: pure functions over data, no React. It exists so the two
 * surfaces cannot disagree about what a filter means, and so the one genuinely
 * surprising thing on this screen — the date-range convention below — is written
 * down once, beside the code that implements it, rather than in a comment on a
 * JSX attribute where nobody looking for it would think to read.
 *
 * ── THE DATE RANGE HERE IS NOT THE DATE RANGE ON THE PERFORMANCE PAGE ───────
 * These two screens sit one link apart, are about the same person's shift, and
 * take date ranges with **different semantics**. That is deliberate on the server's
 * side, it is not going to be unified, and a maintainer who "fixes" either one
 * silently changes which rows an agent sees.
 *
 *   `/proxy/agency/my-attempts` (this list)
 *     · `to` is **INCLUSIVE**
 *     · the range filters **`created_at`** — when the attempt was CREATED
 *
 *   `/proxy/agency/my-stats` (the performance page, `periodRange`)
 *     · `to` is **EXCLUSIVE**
 *     · the range filters **`dialed_at`** — when the attempt was DIALLED
 *
 * Both are right for what they are asked to do, and the reason is the whole
 * point of the attempts list existing at all:
 *
 *  - **`created_at`, not `dialed_at`, because an attempt that never dialled must
 *    not vanish.** `dialed_at` is `null` on an `orphaned` attempt (the reaper
 *    ended it after a replica died) and on anything that failed before the
 *    carrier was reached. Filtering a LIST on a nullable column silently drops
 *    exactly the rows the list was built to surface — the same defect as building
 *    this screen on `webrtc_calls`. A STATS read has the opposite duty: a call
 *    that was never placed belongs in no day's talk time, so `dialed_at` is the
 *    honest column there.
 *  - **Inclusive `to`, because a day picker means the whole day.** Somebody
 *    choosing "to 3 August" in a list of their own calls means the end of the
 *    3rd. The stats page's exclusive `to` is invisible to its reader — it selects
 *    a named period, never two raw dates — so it costs nothing there and would
 *    cost a whole day of rows here. `AgencyCampaignAttemptsPage` keeps the same
 *    inclusive convention, for the same reason, on the same spine.
 *
 * So the UI copy on this list must not borrow the performance page's language.
 * See {@link ATTEMPT_RANGE_NOTE}.
 */

/**
 * What the date range actually does, in the reader's words.
 *
 * On screen rather than in a tooltip. The two facts it carries — the day is
 * included, and the range is about when the call was *made* rather than when it
 * *connected* — are both things a reader would otherwise have to discover by
 * noticing a row missing, which is the one way of finding out that also destroys
 * their trust in the rest of the list.
 *
 * It deliberately avoids the performance page's vocabulary ("today", "this week",
 * "this month", "dialled in"): those name periods with the other convention, and
 * a shared word between two different meanings is worse than two different words.
 */
export const ATTEMPT_RANGE_NOTE =
  'Both dates are included. The range covers when each call was created — so a call that '
  + 'never got dialled still shows up on the day it was queued.';

/**
 * The one write-up code this filter cannot find, said on screen.
 *
 * ── Why a sentence rather than a comment ───────────────────────────────────
 * A code containing a comma is unfilterable end to end and no client-side
 * spelling changes that: The API's `forwardAllowedQuery` joins a repeated param's
 * values with a comma and the server's `multiParam` splits on one, so `Not interested,
 * will call back` reaches the server as two codes, matches no row, and returns **an
 * empty list**. Empty is exactly the answer that reads as a fact about the
 * person — "you have no calls written up that way" — rather than as a fact about
 * the encoding, which is the failure this whole screen's honesty rules exist to
 * avoid. `isAttemptFiltered` cannot help: the filter genuinely was applied.
 *
 * Operator-configured free text makes such a code entirely plausible — a comma is
 * ordinary punctuation in a phrase somebody typed into a catalog. So the limit is
 * named where the code is typed, in the reader's words, with no mention of which
 * service does the joining.
 */
export const DISPOSITION_COMMA_NOTE =
  'A code with a comma in it can’t be searched for — it comes back empty rather '
  + 'than wrong. Search on a code without one, or narrow by day instead.';

/** A single day as `yyyy-mm-dd`, straight off a native `<input type="date">`. */
export type DayString = string;

/**
 * The two day pickers turned into the instants the API expects.
 *
 * `to` is the last instant of the chosen day — the inclusive end. The off-by-one
 * this closes is not cosmetic: `T00:00:00` on the `to` day drops every call made
 * after midnight on the last day of the range, which on a range of one day is
 * *the entire result*, presented as "you took no calls".
 *
 * Local, not UTC, for the same reason the timestamps in the table are formatted
 * in the viewer's zone: somebody picking "3 August" means their own 3rd of
 * August. The API takes ISO-8601 instants and does the rest.
 *
 * ── Why the end is derived and not written down ─────────────────────────────
 * It used to be `new Date(\`${to}T23:59:59.999\`)`, and that literal is
 * **ambiguous** wherever the clocks go back AT midnight — Chile, Paraguay, Cuba
 * and Lebanon all do. In `Asia/Beirut`, 2026-10-25 00:00 sends the clocks to
 * 2026-10-24 23:00, so the wall-clock hour 23:00–23:59 on the 24th happens
 * TWICE, at two different offsets. JS resolves the ambiguity to the earlier
 * offset, so the range ended an hour before the day did and the last hour of
 * calls was silently missing — under rendered copy promising *"Both dates are
 * included"*, which is the part that makes it a lie rather than a rounding error.
 *
 * The end is therefore one millisecond before the NEXT local day starts, which is
 * the definition of "the end of this day" and has no second reading. `date-fns`
 * is used rather than hand arithmetic because `addDays` is calendar-aware — the
 * next day is not "24 hours later" on either kind of transition — and it is
 * already the dependency `periodRange` derives its ranges with.
 *
 * The anchor is **noon**, not midnight, for the mirror-image reason: Cuba and
 * Chile spring forward at 00:00, so a local midnight can be a time that does not
 * exist at all, and `startOfDay` of a non-existent instant is the engine's
 * business rather than the contract's. Noon exists exactly once in every zone
 * there has ever been.
 *
 * `from` is derived the same way for the same reason, and reads more plainly for
 * it: the first instant of the chosen day rather than a spelling of it that
 * happens to be right.
 */
export function attemptDateRange(
  from: DayString,
  to: DayString,
): { from?: string; to?: string } {
  return {
    ...(from ? { from: startOfDay(noon(from)).toISOString() } : {}),
    ...(to ? { to: new Date(startOfDay(addDays(noon(to), 1)).getTime() - 1).toISOString() } : {}),
  };
}

/**
 * A `yyyy-mm-dd` as local NOON.
 *
 * The anchor for both ends above. Midnight is unusable as an anchor because it is
 * the instant the transitions land on: in `America/Havana` on 2026-03-08 there is
 * no 00:00, and in `Asia/Beirut` on 2026-10-24 there are two 23:00s. Noon is
 * unambiguous everywhere, and `startOfDay` walks back to the day's real
 * beginning from there.
 */
function noon(day: DayString): Date {
  return new Date(`${day}T12:00:00`);
}

/**
 * A range whose end is before its start.
 *
 * Caught before it is sent, not because the API fails to refuse it — it answers
 * 400 — but because telling somebody their two dates are the wrong way round is
 * the difference between a correction and a support ticket. `AgencyCampaignAttemptsPage`
 * does the same, and string comparison is sound on `yyyy-mm-dd`.
 */
export function isInvertedDayRange(from: DayString, to: DayString): boolean {
  return Boolean(from && to && from > to);
}

/**
 * Whether anything at all is narrowing the list.
 *
 * Used for one thing only, and it is the thing that matters: deciding whether an
 * empty result is a fact about the FILTER or a fact about the PERSON. Getting it
 * wrong tells an agent who filtered to one bad afternoon that they have never
 * taken a call — which `AgencyCampaignAttemptsPage` shipped once, by omitting
 * `contact_id` from its own version of this check.
 *
 * Every key is therefore listed explicitly rather than counted with
 * `Object.keys().length`: a filter left at `[]` or `''` is not a filter, and a
 * key added to `AgencyAttemptFilters` that nobody wires up here would silently
 * inflate the count.
 */
export function isAttemptFiltered(
  filters: AgencyAttemptFilters & { campaign_id?: string },
): boolean {
  return Boolean(
    filters.outcome?.length
    || filters.state?.length
    || filters.disposition_code?.length
    || filters.campaign_id
    /*
      `phone` IS counted, and the reason is worth keeping because it inverted.
      It used to be excluded here on the grounds that the agent routes did not
      forward the param: The API's whitelist dropped it silently, so the control
      returned an unfiltered list presented as a search result, and counting it
      would have made an empty page read as "your search matched nothing" when no
      search happened. Both halves have since landed — `phone` is in
      `AGENT_ATTEMPT_QUERY_PARAMS` for both agent routes, and `forwardAllowedQuery`
      now 400s on an unknown key instead of dropping it — so the exclusion had
      become the defect it was written to prevent, in the opposite direction: an
      applied search with no Clear button and a badge counting nothing.

      The rule under both readings is the same one, which is why this is a leaf
      module: count exactly the filters this surface can really send. When that
      set changes, this is the line that changes, not each caller.
    */
    || filters.phone
    || filters.from
    || filters.to,
  );
}

/**
 * How many independent filter GROUPS are applied, for the badge on the filter
 * card.
 *
 * Groups, not values: three outcomes ticked is one narrowing of the list, and a
 * badge reading "3 active" beside a single row of chips invites the reader to hunt
 * for two more controls they have already found. The date range counts once for
 * the same reason — one range, two inputs.
 */
export function attemptFilterGroupCount(
  filters: AgencyAttemptFilters & { campaign_id?: string },
): number {
  let n = 0;
  if (filters.outcome?.length) n += 1;
  if (filters.state?.length) n += 1;
  if (filters.disposition_code?.length) n += 1;
  if (filters.campaign_id) n += 1;
  // `phone` counts — see `isAttemptFiltered` for why this inverted. A badge that
  // ignores an applied search tells the reader their list is unnarrowed when it is
  // not, which is the same lie the old exclusion avoided, told the other way.
  if (filters.phone) n += 1;
  if (filters.from || filters.to) n += 1;
  return n;
}

/**
 * The write-up codes visible on the rows currently loaded, plus whatever is
 * already selected.
 *
 * ── Why this is a suggestion list and never an option list ──────────────────
 * Disposition codes are **operator-configured free text**, held per campaign in
 * that campaign's `disposition_catalog`. The campaign-scoped attempts view can
 * therefore offer a complete list: one campaign, one catalog. This list cannot.
 * It spans every campaign the person has ever worked — that is the entire reason
 * it exists — so there is no single catalog to read, and no client-side set that
 * is provably complete.
 *
 * Fetching every catalog was rejected: it is one request per campaign in the
 * staffing history, on a page an agent opens between calls, for a filter most
 * readers never touch — and it would still be incomplete, because a code that was
 * renamed or removed since the call was dispositioned lives on in the attempt row
 * and in no catalog at all.
 *
 * So the codes on the loaded rows are offered as a **shortcut to what is already
 * on screen**, the caller says so in as many words, and free text stays the way
 * to reach anything else. The selected codes are folded in so a code that was
 * typed by hand, or one whose only row has since been paged past, still renders
 * as a chip that can be switched off — a selected filter with no visible control
 * is a list nobody can un-narrow.
 *
 * Sorted, so the chips do not reorder themselves under the reader's cursor as
 * "load more" brings new codes in.
 */
export function observedDispositionCodes(
  rows: readonly Pick<AgencyAttempt, 'disposition_code'>[],
  selected: readonly string[] = [],
): string[] {
  const codes = new Set<string>(selected);
  for (const row of rows) {
    if (row.disposition_code) codes.add(row.disposition_code);
  }
  return [...codes].sort((a, b) => a.localeCompare(b));
}
