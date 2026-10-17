import type { AgencyRosterPage } from '../../../types/agency-stats';
import { formatCount, plural } from '../../format/number';
import { SORT_LABELS } from './columns';

/*
  The roster's page-level sentences: how many agents the page shows, what was
  truncated or left out, and why a page can have no rows to draw. Out of
  `agencyAgentRoster.ts`, which re-exports everything here.
*/

/**
 * `8 agents dialled · 2,495 dials` — the POPULATION, not the row count.
 *
 * ── Why `total_agents` and not `rows.length` ───────────────────────────────
 * They are different facts and the readout is about the floor rather than about
 * the table: `total_agents` is how many people dialled in this window and scope,
 * and `benchmark.attempts` is what they dialled between them. Both come off the
 * same object as the percentiles, so this sentence and the pinned team row cannot
 * disagree.
 *
 * `rows.length` would make the readout move when a former member was dropped or
 * when `limit` cut the page, which reads as the floor having changed size. What
 * was NOT shown is said separately — see {@link truncationNote} and
 * {@link inactiveNote}, and the note on why the three never combine.
 */
export function rosterCountReadout(page: AgencyRosterPage): string {
  const agents =
    `${plural(page.total_agents, 'agent')} dialled`;
  const dials = plural(page.benchmark.attempts, 'dial');
  return `${agents} · ${dials}`;
}

/**
 * "Showing the top 100 by conversions", or `null` when nothing was cut.
 *
 * ── There is deliberately NO "showing N of M" fraction here ────────────────
 * It is tempting and it is not computable. Three numbers on this payload are
 * related but independent, because of the ORDER the server and the API apply their
 * rules in:
 *
 *  - The server scopes, ranks, and cuts to `limit`; `total_agents` is its pre-`limit`
 *    population and is also the benchmark's population;
 *  - **The API then filters the page it was handed**, dropping departed members and
 *    reporting how many in `inactive_omitted`.
 *
 * So `rows.length` is "the top `limit`, minus the departed ones that happened to be
 * in it". A default read can legitimately come back with 1 row, `total_agents: 3`
 * and `inactive_omitted: 1`: "showing 1 of 3" is wrong, and "showing 1 of 2" is not
 * computable either, because the server never saw the two agents the dialer runtime cut. The
 * alternative — the server shipping hundreds of agent ids to the dialer runtime on a GET so the
 * filter could happen first — is not phase 01's trade.
 *
 * The honest form is therefore three separate true statements, and this is one of
 * them: the roster was cut, and by which order. The order is named because "the
 * rest" only means something relative to the ranking that selected these rows.
 *
 * The guard adds BOTH of the API's drop counts back in before comparing —
 * `inactive_omitted` and `unattributed_omitted` — so a page that fitted
 * comfortably under the limit and simply had rows removed does not claim to have
 * been truncated.
 */
export function truncationNote(page: AgencyRosterPage): string | null {
  /*
    The key first, and its absence means SILENCE rather than a comparison.

    `inactive_omitted` is the API's addition, and the API has a documented degrade
    path that serves the server's body unfiltered — with no such key on it. Read
    straight, `total_agents <= rows.length + undefined` is `1 <= NaN`, which is
    `false`, so the note fired on EVERY page: a supervisor looking at their whole
    floor was told the rest of it was further down an order. The guard is the
    client's own robustness and stays even though the API is being fixed in
    parallel to always emit the field — the two fixes are independent, and a
    comparison against `undefined` should never be reachable from a typed field
    the wire can omit.
  */
  if (typeof page.inactive_omitted !== 'number') return null;
  /*
    And the third state (an id with no membership at all) is now COUNTED rather than reasoned about. The API drops an
    id with no membership row of any status ("never in this tenant") and reports it
    separately, because folding it into `inactive_omitted` would claim a person left
    a team they were never on. `total_agents` counts those rows and `rows` does not,
    so without adding them back the comparison below is false with nothing
    truncated — and the note then tells a supervisor looking at their whole floor
    that the rest of it is further down an order. The paragraph above called that
    "structurally unreachable and cheap to be wrong about quietly"; it was neither.

    Absent means 0, which is exactly the behaviour that shipped before the field.
  */
  const unattributed =
    typeof page.unattributed_omitted === 'number' ? page.unattributed_omitted : 0;
  if (page.total_agents <= page.rows.length + page.inactive_omitted + unattributed) return null;
  return `Showing the top ${formatCount(page.limit)} by ${SORT_LABELS[page.sort]} — the rest of the floor is further down that order.`;
}

/**
 * "2 former members hidden", or `null`.
 *
 * The dialer runtime returns departed agents because it cannot know they departed; the server drops
 * them. This sentence is what stops that from being a silent edit — and it names
 * them as FORMER MEMBERS rather than "hidden rows", because the reader's question
 * is "where is Priya", not "why are there fewer rows".
 */
export function inactiveNote(page: AgencyRosterPage): string | null {
  // Same guard as `truncationNote`, for the same degrade path. `undefined <= 0`
  // is `false`, so this one already fell silent on an absent key — stated rather
  // than relied on, because the coincidence is not the reason it is correct.
  if (typeof page.inactive_omitted !== 'number' || page.inactive_omitted <= 0) return null;
  const people =
    plural(page.inactive_omitted, 'former member');
  return `${people} hidden — they dialled in this window but have since left the team.`;
}

/**
 * Which fact explains an EMPTY `rows` on a page that dropped something, or `null`
 * when nothing was dropped.
 *
 * ── Why "everyone left" was not a safe thing to assume ─────────────────────
 * Both screens derived this as `rows.length === 0` on a `ready` page and printed
 * *"Everyone who dialled in this window has since left the team"*. The API has TWO
 * independent reasons to drop a row and they mean opposite things to the reader:
 *
 *  - `inactive_omitted` — a former member. Revealable: the toggle exists for it,
 *    and the sentence can name a remedy.
 *  - `unattributed_omitted` — the third state, an id with no membership row of
 *    ANY status. **The toggle cannot bring these back**, because
 *    `include_inactive` widens the membership filter and these rows match no
 *    membership at all. Telling the reader to tick it is advice that does nothing.
 *
 * So `{ rows: [], unattributed_omitted: 3 }` — an ordinary the API response, not a
 * shape violation — claimed three people had resigned. On a supervisory surface
 * that is not a wording nit: it is a statement about named colleagues, made from a
 * count that says nothing of the kind.
 *
 * ── Shared, structurally typed, because the bug was in the DERIVATION ──────
 * The roster and the grouped read carry these three fields identically and both
 * screens got this wrong in the same way, so the predicate lives once. The COPY
 * stays with each screen: one says "this window", the other names a campaign, and
 * one sentence bent to fit both would name neither well.
 *
 * `null` on a page with rows is the important arm: this asks "why is the table
 * empty", and a page with rows does not have that question.
 */
export type RosterHiddenReason = 'departed' | 'unattributed' | 'both';

export function allRowsHiddenReason(page: {
  rows: readonly unknown[];
  inactive_omitted: number;
  unattributed_omitted?: number;
}): RosterHiddenReason | null {
  if (!Array.isArray(page.rows) || page.rows.length > 0) return null;
  // Both through `typeof`, for `truncationNote`'s reason: The API has a degrade path
  // that serves the server's body unfiltered, and `undefined > 0` is a comparison this
  // client should never make against a field the wire can omit.
  const departed = typeof page.inactive_omitted === 'number' ? page.inactive_omitted : 0;
  const unattributed =
    typeof page.unattributed_omitted === 'number' ? page.unattributed_omitted : 0;
  if (departed > 0 && unattributed > 0) return 'both';
  if (departed > 0) return 'departed';
  if (unattributed > 0) return 'unattributed';
  return null;
}
