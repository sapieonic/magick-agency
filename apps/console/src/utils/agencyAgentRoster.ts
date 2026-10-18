import { formatDateShort } from '@magick-agency/web-ui/format';
import { AGENCY_ROSTER_MIN_RATE_DENOMINATOR } from '../types/agency-stats';
import type {
  AgencyRosterAgentRowWithName,
  AgencyRosterBenchmark,
  AgencyRosterPage,
} from '../types/agency-stats';
import { plural } from './format/number';
import { benchmarkUsable, cohortComparable } from './agency/roster/benchmark';
import { successRateReportable } from './agency/roster/cells';
// The cells, the benchmark, the page notes and the columns live in
// `./agency/roster/`, re-exported so every import of this module keeps working.
export * from './agency/roster/cells';
export * from './agency/roster/benchmark';
export * from './agency/roster/notes';
export * from './agency/roster/columns';

/**
 * The roster table's derivations, as pure functions.
 *
 * Same reasoning as `agencyAgentPerformance`, `agencyCampaignPerformance` and
 * `agencyHealthStrip`: every sentence here is a claim about a named person's
 * week, a derivation is a place to be confidently wrong, and these are tested
 * against fixtures rather than eyeballed on a screen.
 *
 * ── Nothing here re-defines a figure that already has a definition ─────────
 * The percentage and duration formats come from `agencyAgentPerformance`
 * (`agentPct`, `agentSeconds`) rather than from a local `toFixed(1)`, so the
 * roster's connect-rate column and the per-agent panel a supervisor drills into
 * cannot print `18%` and `18.0%` for the same number. The name fallback comes
 * from `agencyAgentFloor.agentDisplayName` for the same reason, and **every rate
 * this payload carries is rendered as served** — dividing again here would produce
 * a second answer that rounds differently.
 *
 * There is now exactly ONE exception, and it is a figure the payload does not
 * carry: the team row's POOLED utilisation, which the benchmark makes derivable
 * (`shift_seconds`) but does not itself state. It goes through the sibling
 * module's single `ratePct` helper rather than a local `n / d * 100` — see
 * {@link teamUtilisation}, and note that it divides the BENCHMARK's own figures,
 * never the rows'.
 *
 * ── The one rule this whole module is built around ─────────────────────────
 * A table is SCANNED, not read. On the per-agent panel a wrong absence is a
 * misleading sentence; in a column of percentages it is invisible — `0%` sitting
 * among real rates looks exactly like a bad week. So this module never produces a
 * number for something that was not measured, and it distinguishes **three**
 * absences, which the {@link RosterCell} union makes unrepresentable to confuse:
 *
 *  1. **`measured`** — a real figure, including a real `0`.
 *  2. **`unmeasured`** — the server carried the field and had nothing to divide.
 *     An em dash plus a phrase naming what has not happened.
 *  3. **`withheld`** — the server carried a real number and told us it is not
 *     reportable (`rates_reportable: false`). **Words, not a faint number.** A
 *     rate greyed out is still a rate, and it is the one a supervisor reads
 *     aloud; the whole point of the server's flag is that a 27% conversion built
 *     from eleven calls should not be presentable as 27%.
 */

// ─── Cells ───────────────────────────────────────────────────────────────────

/**
 * Why a row is worth a second look, in a few words.
 *
 * ── This is NOT a score, and the kinds are the guardrail ───────────────────
 * A composite "agent score" is explicitly out of scope until after the nightly
 * rollup lands, and a chip that blended these would be one by the back door. So
 * every kind below is a single, stated, checkable fact about ONE metric against
 * the cohort — never a weighting of several — and the label says which metric.
 *
 * ── Ordered by what a supervisor must not misread ──────────────────────────
 * `thin` outranks `below_band` deliberately. A rate that is below the bottom
 * quarter *and* built from eleven calls is not a performance finding, and a chip
 * saying so would start exactly the coaching conversation the `rates_reportable`
 * flag exists to prevent.
 *
 * ── There is no `no_dials` kind, and there cannot be ───────────────────────
 * It was removed rather than left unused. The server groups over rows filtered on
 * `dialed_at IS NOT NULL`, so every served row has `attempts >= 1` and a chip for
 * `attempts === 0` was unreachable UI with a passing test over it — see
 * {@link connectRateCell} for the same deletion and the same reasoning.
 */
export type RosterFlagKind = 'thin' | 'below_band' | 'above_band';

export interface RosterFlag {
  kind: RosterFlagKind;
  /** Always rendered, and it NAMES THE METRIC. The chip is never colour-only. */
  label: string;
  /** The sentence behind the words, for the cell's title and its accessible name. */
  detail: string;
}

/**
 * The chip for one row, or `null` when the row is unremarkable.
 *
 * `null` rather than an "OK" chip: a column where every cell carries a badge is a
 * column nobody scans, and the whole value of this one is that a marked row is
 * rare.
 *
 * ── The metric is CONVERSION rate, not connect rate ────────────────────────
 * This keyed on `connect_rate_pct` and that was the wrong choice twice over.
 * Connect rate is the metric an agent controls least — it is mostly list quality
 * and dial timing — so an agent with a healthy 38% connect rate and a 4%
 * conversion rate collected a reassuring green chip while the number the business
 * runs on went unremarked. And it is the very metric that is not comparable
 * across campaigns, which is why {@link mixedCohortNote} exists.
 *
 * Conversion rate is the closest thing on this payload to a measure of what the
 * agent did with the call they were handed. It is still ONE metric compared
 * against ONE band, and the label says which — "Conversion rate below the band",
 * not "Below the band", so the chip can be read (and quoted) without hovering it.
 *
 * ── `comparable` is the caller's decision, and it is required ──────────────
 * `false` suppresses both band chips and leaves only `thin`. The roster's
 * all-campaigns view passes `false`, because a median pooled across different
 * dealers' lead lists is not a like-for-like comparison and a chip naming a
 * person against it is the most consequential sentence this table can print. It
 * is a parameter rather than something derived here because this module never
 * sees the page; `thin` survives it because "fewer than twenty calls" is a
 * statement about volume and is true whatever the rows were pooled from.
 *
 * ── The band comparison needs the band's OWN denominator ───────────────────
 * `rates_reportable` is `attempts >= 20` — the row's headline threshold. The
 * SUCCESS-rate percentiles have a second floor on top: The server only admits a row to
 * that pool when `connected >= 20` as well. So a row with 400 dials and 3
 * connects is `rates_reportable: true`, is NOT in the pool the band came from,
 * and comparing its 33% conversion rate against that band would flag somebody
 * against a cohort they were excluded from. The extra guard is that pool's floor,
 * applied here so the chip and the percentiles agree about who was measured.
 *
 * **The SERVER states that floor, and where it does this function does not.**
 * `success_rate_reportable` IS `rates_reportable AND connected >= 20`, so a
 * client-side `connected < 20` beside it is a duplicate threshold that can only
 * ever disagree — see the comment at the guard itself. The comparison runs only
 * when the flag is absent.
 */
export function rosterFlag(
  row: AgencyRosterAgentRowWithName,
  benchmark: AgencyRosterBenchmark,
  comparable: boolean,
): RosterFlag | null {
  if (!row.rates_reportable) {
    return {
      kind: 'thin',
      label: 'Too few to rate',
      detail:
        /*
          DIALS, not "calls". `rates_reportable` is `attempts >= 20`, so dials is the
          denominator that fell short — and the withheld CELLS in the same row now
          name their own denominators (see `withheldRateTitle`), so a chip still
          saying "calls" would be the third vocabulary in one row for two quantities.
        */
        `Fewer than ${AGENCY_ROSTER_MIN_RATE_DENOMINATOR} dials, so their rates are not ` +
        'comparable and did not count towards the team’s median.',
    };
  }

  if (!comparable) return null;

  const rate = row.success_rate_pct;
  if (rate === null) return null;
  /*
    The success-rate pool's own floor. See the header: `rates_reportable` is not
    this band's basis, and a row must not be judged against a band it was never
    admitted to.

    `success_rate_reportable` is the SERVER's statement of exactly this predicate,
    so where it is PRESENT it is the whole answer and nothing here recomputes it.

    ── The bug this shape exists to prevent ──────────────────────────────────
    The `connected` comparison below used to run unconditionally, right after the
    guard above. So on a server that does send the flag, a row the dialer runtime had
    admitted to the success-rate pool (`success_rate_reportable: true`) could
    still be dropped here by this client's own `connected < 20` — a second answer
    to a question the dialer runtime had already answered, which disagrees with the server
    the moment the server tunes that threshold and disagrees with the conversion CELL
    sitting in the same row (which gates on the flag alone).
    `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`'s own doc comment forbids computing with
    it for exactly this reason: it is mirrored so the console can SAY the number,
    not so the console can apply it.

    It survives only as the fallback for a service that predates the field, so it
    is now gated on the field being absent. That is {@link successRateReportable}'s
    fallback carried one step further: the CELL can degrade to `rates_reportable`,
    but this band needs the stronger floor and with no flag on the row there is
    nothing else to derive it from.
  */
  if (!successRateReportable(row)) return null;
  if (
    typeof row.success_rate_reportable !== 'boolean' &&
    row.connected < AGENCY_ROSTER_MIN_RATE_DENOMINATOR
  ) {
    return null;
  }

  const { p25, p75 } = benchmark.success_rate;
  if (p25 !== null && rate < p25) {
    return {
      kind: 'below_band',
      label: 'Conversion rate below the band',
      detail:
        'Their conversion rate is below the bottom quarter of the team for this window, ' +
        'on this campaign.',
    };
  }
  if (p75 !== null && rate > p75) {
    return {
      kind: 'above_band',
      label: 'Conversion rate in the top quarter',
      detail:
        'Their conversion rate is above the top quarter of the team for this window, ' +
        'on this campaign.',
    };
  }
  return null;
}

/**
 * The rows on the page that carry a chip — what the "needs attention" filter lists,
 * and what its count counts.
 *
 * The filter exists because of `limit`. this console asks for the contract's maximum
 * (200) and there is no server-side paging in phase 01, so on a floor larger than
 * that the ranking decides who is visible — and under `conversions desc` the rows
 * cut are the LOWEST converters, which is the population a supervisor triaging
 * their week most needs. Sorting ascending finds them, but the flag column is
 * deliberately unsortable (it is derived from the row's relationship to the
 * benchmark, so no server can order by it). A client-side filter over the rows in
 * hand is what makes a flagged row reachable without re-asking the question.
 *
 * It filters what is ON the page and says so; it is not a claim about the floor.
 */
export function rosterAttentionRows(
  rows: readonly AgencyRosterAgentRowWithName[],
  benchmark: AgencyRosterBenchmark,
  comparable: boolean,
): AgencyRosterAgentRowWithName[] {
  return rows.filter((row) => rosterFlag(row, benchmark, comparable) !== null);
}

/** Every row's flag on one page, derived once — see {@link rosterPageFlags}. */
export interface RosterPageFlags {
  /** {@link cohortComparable} and {@link benchmarkUsable}: may a row be compared against the band at all. */
  comparable: boolean;
  /** Each row's flag (or `null`), by `agent_user_id`. */
  byAgent: ReadonlyMap<string, RosterFlag | null>;
  /** How many rows carry one — the "needs attention" filter's count. */
  flagged: number;
}

/**
 * {@link rosterFlag} for every row of a page, once.
 *
 * The section's filter label counted the flagged rows, the table filtered them
 * again for "needs attention", and then each row derived its own chip — up to
 * three evaluations per row per render, and `comparable` worked out twice. The
 * page's owner memoises this on the page and hands it to the table, so the count,
 * the filter and the chips are read off one answer.
 */
export function rosterPageFlags(page: AgencyRosterPage): RosterPageFlags {
  const comparable = cohortComparable(page) && benchmarkUsable(page.benchmark);
  const byAgent = new Map<string, RosterFlag | null>();
  let flagged = 0;
  for (const row of page.rows) {
    const flag = rosterFlag(row, page.benchmark, comparable);
    if (flag !== null) flagged += 1;
    byAgent.set(row.agent_user_id, flag);
  }
  return { comparable, byAgent, flagged };
}

// ─── The agent cell ──────────────────────────────────────────────────────────

/**
 * Up to two initials for the avatar.
 *
 * Derived from whatever `agentDisplayName` produced, so an unresolvable agent
 * gets `AG` from its `Agent 4f21ab90` fallback rather than a blank circle — the
 * avatar must never be the thing that makes a row look broken. It is decoration:
 * the name is beside it and the avatar is `aria-hidden`, which is why two letters
 * of a uuid-derived fallback is acceptable here and would not be as a label.
 */
export function agentInitials(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

/**
 * The small line under a name: how many campaigns, and when they last dialled.
 *
 * ── Why "last dialled" and not "joined" ───────────────────────────────────
 * The payload carries `last_dialed_at` and carries nothing about membership
 * dates, so a "joined" subline would be a fact this client invented. It is also
 * the less useful of the two here: a roster is a window, and "last dialled 19
 * Aug" on a window ending the 26th is the explanation for a thin row sitting
 * right beneath the thin row.
 *
 * ── The "no dials" branch was removed, not forgotten ──────────────────────
 * It read *"No dials in this window"* for `last_dialed_at === null`, and that row
 * cannot arrive: `last_dialed_at` is `MAX(a.dialed_at)` over a group that only
 * exists because a dial fell in it, and `campaigns` is a `COUNT(DISTINCT
 * a.campaign_id)` over the same group — so both are `>= 1` on every served row.
 * `include_inactive` changes which rows the server RETURNS, never how the dialer runtime built
 * them. See {@link connectRateCell} for the same deletion and the same reasoning.
 *
 * What is left is an inert fallback for a shape this payload cannot produce: the
 * campaign count on its own, with no sentence claiming a state nobody can
 * explain.
 */
export function rosterSubline(row: AgencyRosterAgentRowWithName): string {
  const campaigns =
    plural(row.campaigns, 'campaign');
  if (row.last_dialed_at === null) return campaigns;
  return `${campaigns} · last dialled ${formatDateShort(row.last_dialed_at)}`;
}

// ─── The pinned team row and the page's honesty affordances ──────────────────

/**
 * A campaign to open the roster on — the most recently ACTIVE one.
 *
 * ── What "most recently active" can mean from what is in hand ──────────────
 * The page already holds the campaign list, so this is a client-side choice and
 * costs no request. What that list carries is the constraint: `AgencyCampaign` has
 * `id`, `name` and `status` and **no timestamps at all** — no `created_at`, no
 * `started_at`, nothing this client could order by recency. Two facts are
 * available and both are used:
 *
 *  1. **`status`**, which is a statement about dialing right now. `running` and
 *     `stopping` are dialing; `paused` was dialing and is held; `completed` and
 *     `stopped` dialled in the past; `draft` has never dialled and therefore has
 *     no roster to show. That ordering is a recency ordering — it is the only one
 *     the payload supports directly.
 *  2. **The list's own order**, used only to break ties inside a status class.
 *     The dialer runtime serves `GET /campaigns` as `ORDER BY created_at DESC` and the server
 *     forwards the body unchanged, so position 0 is the newest campaign. Relying on
 *     it for the tie-break and nothing more is the point: if that order ever
 *     changes, the default moves between two campaigns of the same status rather
 *     than becoming wrong.
 *
 * A status this client does not know is treated as "dialled at some point" rather
 * than as a draft — the same instinct `AgencyCampaignStatusBadge` records about an
 * unrecognised status, and the safer of the two errors, since a draft is the one
 * class guaranteed to have an empty roster.
 *
 * `null` for an empty list: there is nothing to scope to, the roster is empty
 * either way, and the all-campaigns view then reports itself honestly.
 */
const CAMPAIGN_RECENCY: Record<string, number> = {
  running: 0,
  stopping: 0,
  paused: 1,
  completed: 2,
  stopped: 2,
  draft: 4,
};

export function defaultRosterCampaign(
  campaigns: readonly { id: string; status?: string | null }[],
): string | null {
  let best: { id: string; rank: number } | null = null;
  campaigns.forEach((campaign) => {
    if (!campaign.id) return;
    // 3 — below every status that has dialled, above `draft`. See the header.
    const rank = CAMPAIGN_RECENCY[campaign.status ?? ''] ?? 3;
    // Strictly greater, so the FIRST campaign of a rank wins and the list's
    // newest-first order decides the tie.
    if (best === null || rank < best.rank) best = { id: campaign.id, rank };
  });
  return best === null ? null : (best as { id: string; rank: number }).id;
}

// ─── Sort vocabulary ─────────────────────────────────────────────────────────
