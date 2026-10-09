import {
  agentCount,
  agentPct,
  agentSeconds,
  campaignLabel,
  ratePct,
} from './agencyAgentPerformance';
import { agentDisplayName } from './agencyAgentFloor';
import { unmeasuredCell, withheldRateCell, type RosterCell } from './agencyAgentRoster';
import type {
  AgencyGroupDimension,
  AgencyGroupPage,
  AgencyGroupRow,
  AgencyGroupRowWithName,
  AgencyGroupSort,
} from '../types/agency-stats';

/**
 * "This campaign went like this, and here is who drove it" — the contribution
 * view's derivations, as pure functions.
 *
 * ── The question this answers, and why the roster cannot ──────────────────
 * The roster ranks the floor and measures each person against a cohort. It cannot
 * say what share of ONE campaign's bookings came from each of the people on it,
 * because a roster row is that person's whole window and a campaign's own total is
 * not on that payload at all. So this view reads the grouped route twice — once
 * grouped by `agent,campaign` for the rows, once by `campaign` for the campaign's
 * own line — and puts the two on one screen.
 *
 * ── It is the SAME dialect as the roster, deliberately ────────────────────
 * The cells are {@link RosterCell}s from `agencyAgentRoster.ts`, the counts and
 * formats come from `agencyAgentPerformance.ts`, and the words are the roster's
 * words: **connects** for an answered call, **conversions** for a booked outcome,
 * "middle half" rather than `p25–p75`. A second vocabulary for the same two
 * quantities is the 5x misreading `conversionCell` exists to document, and a
 * supervisor moving between these two screens must not have to learn it twice.
 *
 * ── What this payload does NOT carry, and what it now does ────────────────
 * No benchmark and no occupancy: a cohort of hours or of dispositions is not a peer
 * group, so the contract keeps comparison on the roster, and there is no band, no
 * median, no chip and no bullet anywhere on this screen.
 *
 * It DOES now carry `rates_reportable` — added to the read after this screen found
 * the gap. This module does not compute that flag and never did:
 * `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` is documented as a number to EXPLAIN the
 * server's answer with and never to derive it, and a client-side threshold would
 * have been a second answer that disagreed with the roster's the moment core tuned
 * it. Now that the server states it, the rule is the roster's rule: a thin row's
 * connect and conversion rates render WORDS. See {@link contributionRatesReportable}
 * for what an ABSENT flag means, which is not the same as a `false` one.
 *
 * So all three of the roster's states are reachable here, and they are the roster's:
 * a real `0` renders `0%`, a `null` renders an em dash and a phrase naming what has
 * not happened, and a withheld rate renders the roster's own words beside the
 * roster's own denominator — from {@link withheldRateCell}, so the two screens
 * cannot drift.
 */

// ─── What this view asks for ─────────────────────────────────────────────────

/**
 * The cut: one row per agent within one campaign.
 *
 * `campaign` is in the group even though exactly one campaign is filtered, and
 * that is not redundant. It is what puts `campaign_id` on every row's key — so a
 * row can be read on its own terms — and it is what makes the read's timezone
 * unambiguous by construction rather than by the filter happening to be set (the
 * route refuses a time dimension otherwise, and this list is the shape a
 * `day_of_week` cut would extend).
 */
export const CONTRIBUTION_GROUP_BY: readonly [AgencyGroupDimension, AgencyGroupDimension] = [
  'agent',
  'campaign',
];

/**
 * The campaign's OWN line — one dimension, so exactly one row comes back.
 *
 * A separate read rather than a sum of the rows above, and that is the whole point
 * of the screen: with `agent` grouped, master drops the rows of people who have
 * left the team, so the rows sum to less than the campaign did. Summing them would
 * silently redefine "the campaign's total" as "the total of the people still
 * here", which is the one number a supervisor would never think to doubt.
 *
 * `include_inactive` is deliberately NOT sent on this read: nothing is dropped
 * from a row that belongs to no person, so the parameter is meaningless here — and
 * because it is not sent, this line cannot move when the reader toggles it. That
 * is the same property the roster's benchmark has, for the same reason.
 */
export const CONTRIBUTION_TOTAL_GROUP_BY: readonly [AgencyGroupDimension] = ['campaign'];

/** The ranking: who drove it. `key` order is for a series; this screen is a contribution. */
export const CONTRIBUTION_SORT: AgencyGroupSort = 'successes';

/**
 * The `limit` this view asks for.
 *
 * Well under the route's 1000 ceiling, because the row count here is bounded by the
 * number of people who dialled ONE campaign rather than by a whole account's
 * floor. {@link contributionTruncationNote} says so when even this is cut, and says
 * it as one of three independent facts rather than as a fraction.
 */
export const CONTRIBUTION_LIMIT = 200;

/**
 * What each order is called, in the product's voice — keyed by the WIRE value so
 * the echo and the sentence cannot drift.
 *
 * The same two words as the roster's `SORT_LABELS` for the same two quantities.
 * `key` is "group order", which is what the server's default actually is: this
 * view never asks for it, but {@link contributionTruncationNote} renders whatever
 * `sort` the server echoes and must not print a wire value at a reader.
 */
export const CONTRIBUTION_SORT_LABELS: Record<AgencyGroupSort, string> = {
  key: 'group order',
  attempts: 'dials',
  connected: 'connects',
  successes: 'conversions',
  connect_rate_pct: 'connect rate',
  success_rate_pct: 'conversion rate',
  aht_seconds: 'handle time',
};

// ─── The columns ─────────────────────────────────────────────────────────────

export interface ContributionColumn {
  label: string;
  /** Right-aligned and tabular. The name column is not. */
  numeric: boolean;
  /**
   * The definition, under the header rather than in a `title`.
   *
   * On every rate, because on this table every rate has a different denominator
   * and a denominator a reader has to hover for is one most of them never see.
   */
  hint?: string;
  /**
   * The WIRE sort this column shows, when there is one.
   *
   * `aria-sort` is derived by comparing this against the server's echoed `sort`,
   * not from a hardcoded flag. The flag was `ranked: true` on Conversions — the
   * order this view always asks for — while the caption beside it read the echo,
   * so a server that defaulted or clamped the sort would have announced one
   * column and captioned another. This file's own rule is "read the echo", and
   * one source is how it stays true.
   *
   * Absent on Agent and Share: no wire sort produces either of them (Share is
   * derived client-side, from a row and the campaign's own line), so no
   * `aria-sort` is announced for them at all.
   */
  sort?: AgencyGroupSort;
}

/**
 * The table's columns, in reading order.
 *
 * ── None of them is pressable, and that is a decision ─────────────────────
 * The roster's headers issue a refetch because the roster is a ranking a
 * supervisor re-asks in several orders. This screen asks ONE question — who drove
 * this campaign — and the answer is one order. Offering eight would turn a
 * contribution view into a second, worse roster, and the `aria-sort` on the one
 * ranked column is what tells a reader the order is fixed rather than absent
 * (every header reporting `aria-sort="none"` was a real defect on the roster).
 *
 * A count sits immediately left of the rate built from it, both times: dials
 * before connect rate, conversions before conversion rate. `rates_reportable` now
 * withholds a rate that is too thin to quote, and this pairing is what makes the
 * ones that ARE quoted readable against the denominator they came from.
 */
export const CONTRIBUTION_COLUMNS: readonly ContributionColumn[] = [
  { label: 'Agent', numeric: false },
  { label: 'Dials', numeric: true, sort: 'attempts' },
  { label: 'Connects', numeric: true, hint: 'answered', sort: 'connected' },
  { label: 'Conversions', numeric: true, hint: 'booked', sort: 'successes' },
  { label: 'Share', numeric: true, hint: 'of the campaign’s conversions' },
  { label: 'Connect rate', numeric: true, hint: 'of dials', sort: 'connect_rate_pct' },
  { label: 'Conversion rate', numeric: true, hint: 'of connects', sort: 'success_rate_pct' },
  { label: 'AHT', numeric: true, hint: 'talk + wrap-up per connect', sort: 'aht_seconds' },
];

/**
 * `aria-sort` for one column, read off the server's ECHO.
 *
 * Only the column the echo NAMES carries a value, and every column that has a
 * wire sort declares it — so a server that defaulted or clamped the order
 * announces it on the column that shows it, rather than announcing nothing while
 * the caption says otherwise. These headers are not pressable, though: this screen
 * asks one question, so `aria-sort="none"` on the other seven would announce seven
 * orders nobody can choose. Silence on a column the echo does not name is the
 * correct announcement, and it is the inverse of the roster's old defect where
 * every header reported `none`.
 */
export function contributionAriaSort(
  column: ContributionColumn,
  page: AgencyGroupPage,
): 'ascending' | 'descending' | undefined {
  if (column.sort === undefined || column.sort !== page.sort) return undefined;
  return page.order === 'asc' ? 'ascending' : 'descending';
}

// ─── The campaign selector ───────────────────────────────────────────────────

/**
 * What the contribution view's campaign selector may offer, as `[id, label]`.
 *
 * ── Why this view gets a selector at all, and why it has no "all" option ───
 * The screen's premise is ONE campaign — a share of every campaign in the account
 * is not a contribution, and the Share column's denominator is one campaign's own
 * line. But "one campaign" was being read as "the one campaign you entered with",
 * so a supervisor reviewing four dealerships left and re-entered four times, and
 * re-chose the window each time. The premise needs one campaign at a time, not one
 * campaign per visit.
 *
 * ── The campaign in scope is ALWAYS in the list ────────────────────────────
 * Named or not. A `<select>` whose `value` matches no `<option>` renders blank —
 * so a campaign the caller could not name would silently look like no campaign at
 * all, on the control that says which campaign every figure on the page is about.
 * It is labelled through {@link campaignLabel}, the same shortened-id stand-in the
 * heading uses, so the two agree.
 *
 * The rest are the campaigns this caller can NAME, sorted by that name — the
 * roster's own rule for its filter, so the two controls offer the same set in the
 * same order. An id with no name is not offered: it would be a menu entry a reader
 * cannot choose between two of.
 */
export function contributionCampaignOptions(
  campaignId: string,
  campaignNames: ReadonlyMap<string, string | null>,
): [string, string][] {
  const named = [...campaignNames.entries()]
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (named.some(([id]) => id === campaignId)) return named;
  // Unnamed, or absent from the map: first, and marked as an id rather than blank.
  return [[campaignId, campaignLabel(campaignId, campaignNames)], ...named];
}

// ─── The agent cell ──────────────────────────────────────────────────────────

/**
 * What this row is called.
 *
 * `agent_name` is master's, resolved on the proxy hop in one query for the page,
 * and `null` means UNRESOLVABLE (a deleted user, an id from outside the tenant)
 * rather than "no name" — so it goes through the same `agentDisplayName` fallback
 * the live floor and the roster use, and renders as a marked-as-an-id stand-in
 * instead of a blank cell.
 *
 * The id itself comes off `key`, which is typed as optional for every dimension
 * (a member is present iff its dimension was grouped). An `agent`-grouped row with
 * no `agent_user_id` would be a contract violation, so it gets a word rather than
 * an invented name or a crash: "Unattributed" claims nothing about a person.
 */
export function contributionAgentName(row: AgencyGroupRowWithName): string {
  const name = row.agent_name?.trim();
  if (name) return name;
  const id = row.key.agent_user_id;
  if (!id) return 'Unattributed';
  return agentDisplayName({ agent_user_id: id, agent_name: null });
}

/** True when master resolved a real name — the roster's `hasResolvedName`, over a group key. */
export function contributionNameResolved(row: AgencyGroupRowWithName): boolean {
  return Boolean(row.agent_name?.trim());
}

/**
 * A stable React key for one row.
 *
 * The agent id when there is one, and the row's position otherwise: two
 * `Unattributed` rows must not collide into one.
 */
export function contributionRowKey(row: AgencyGroupRowWithName, index: number): string {
  return row.key.agent_user_id ?? `row-${index}`;
}

// ─── The metric cells ────────────────────────────────────────────────────────

/**
 * May this row's rates be QUOTED — the server's answer, with a `typeof` guard.
 *
 * ── An absent flag means "do not withhold", and that direction matters ─────
 * The house pattern, for the same reason {@link contributionAsymmetryNote} carries
 * one: merge order is core → master → cusui, so this console can meet a core that
 * predates the field, and master's documented degrade path serves core's body
 * unrecognised. A comparison against `undefined` should never be reachable from a
 * typed field the wire can omit.
 *
 * The fallback is deliberately the PERMISSIVE one. Reading a missing flag as
 * `false` would withhold every rate on the screen the moment this console ran
 * ahead of core — a table of "Not enough calls" beside fat rows with hundreds of
 * dials, which is a worse and more confusing screen than the one this field was
 * added to fix. So an absent flag leaves today's behaviour exactly as it was, and
 * only an explicit `false` withholds.
 *
 * Never compared against `AGENCY_ROSTER_MIN_RATE_DENOMINATOR`. The threshold is
 * the server's to tune; the constant is mirrored only so the console can say it
 * out loud.
 */
export function contributionRatesReportable(row: AgencyGroupRow): boolean {
  return typeof row.rates_reportable === 'boolean' ? row.rates_reportable : true;
}

/**
 * May this row's CONVERSION rate be quoted — a different flag, because it is a
 * different denominator.
 *
 * ── The bug this exists to close ──────────────────────────────────────────
 * {@link contributionRatesReportable} gates on `attempts >= 20`. The conversion
 * rate divides by CONNECTS. So the flag added to stop a flattering rate reaching
 * a named person did not stop it: 20 dials, 1 connect, 1 conversion clears
 * `rates_reportable` and rendered **100%** on a screen headed "who drove this
 * campaign"; 100 dials and 3 connects rendered `33.3%`; 41 dials and 11 connects
 * rendered `18.2%` — and that last row is the one the scoping document's own mock
 * captions as `not enough calls`. The house rule says "below a **per-metric**
 * minimum volume", and one flag cannot carry two denominators.
 *
 * `success_rate_reportable` is `rates_reportable` AND `connected >= 20`. It is
 * therefore strictly stronger (`connected <= attempts`, always), which is why the
 * conversion rate gates on this ALONE rather than on both.
 *
 * ── Its fallback is the OTHER flag, not `true` ────────────────────────────
 * The sibling above falls back to `true` because an absent `rates_reportable`
 * must not withhold every rate on the screen. Here the honest fallback is one step
 * weaker: `rates_reportable`, which is exactly what this cell gated on before the
 * field existed. Falling back to `true` would REVEAL, on a mid-deploy, a set of
 * rates the console withholds today; re-deriving `connected >= 20` from the
 * mirrored constant would make this client compute a threshold that constant's own
 * doc comment forbids it to compute.
 */
export function contributionSuccessRateReportable(row: AgencyGroupRow): boolean {
  return typeof row.success_rate_reportable === 'boolean'
    ? row.success_rate_reportable
    : contributionRatesReportable(row);
}

/**
 * The connect rate for one row — withheld in words when the row is too thin.
 *
 * The order of the two arms is the roster's and is not arbitrary: `null` is
 * checked FIRST, so a row with no denominator says what has not happened rather
 * than "not enough calls", which would imply a number is being held back when
 * there is none.
 *
 * `null` is unreachable on an attempts-driven read — `COUNT(*)` over an
 * inner-joined `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot emit a zero,
 * so `attempts >= 1` on every served row — so the null arm is the module-level
 * inert fallback rather than a sentence about a state nobody can explain. Same
 * derivation and same deletion as the roster's `connectRateCell`.
 */
export function contributionConnectRateCell(row: AgencyGroupRow): RosterCell {
  if (row.connect_rate_pct === null) return unmeasuredCell();
  // A connect rate's denominator is DIALS. The roster's words and the roster's
  // helper, so the two tables cannot come to say this differently.
  if (!contributionRatesReportable(row)) return withheldRateCell(row.attempts, 'dials');
  return { kind: 'measured', text: agentPct(row.connect_rate_pct), value: row.connect_rate_pct };
}

/**
 * The conversion rate — conversions over **connects**, not dials.
 *
 * `null` here is REACHABLE and ordinary: an agent who dialled this campaign and
 * reached nobody. The phrase says that, in the roster's words, rather than
 * printing `0%` — which would read as somebody who had forty conversations and
 * booked none, a different and much worse finding.
 *
 * This is the cell the flag was added for. A 100% conversion over a single connect,
 * printed beside a named person on a screen headed "who drove this campaign", is a
 * finding a supervisor would act on and it is noise. The withheld note names
 * CONNECTS, not dials, because that is this rate's denominator.
 *
 * ── And so does its GATE — see {@link contributionSuccessRateReportable} ───
 * It gated on `rates_reportable` first, which counts dials, so the 100%-on-one-
 * connect row it was added to withhold came through untouched. A flag over the
 * wrong denominator is not a weaker version of the right one; it is a different
 * claim about a different quantity.
 */
export function contributionConversionCell(row: AgencyGroupRow): RosterCell {
  if (row.success_rate_pct === null) {
    return { kind: 'unmeasured', text: '—', note: 'No connect to convert yet' };
  }
  if (!contributionSuccessRateReportable(row)) return withheldRateCell(row.connected, 'connects');
  return { kind: 'measured', text: agentPct(row.success_rate_pct), value: row.success_rate_pct };
}

/**
 * Average handle time. `null` when no call has finished — never `0:00`.
 *
 * **Not gated on `rates_reportable`**, following the roster's `handleTimeCell`
 * verbatim and for its reason: the flag is about RATES, whose numerator is a count
 * of a rare event and is therefore flattering or damning by luck at low volume. A
 * mean duration over eleven finished calls is noisy but it is not misleading — it
 * is genuinely how long those eleven took — and withholding it would leave the
 * thinnest row with no readable figure at all.
 */
export function contributionHandleTimeCell(row: AgencyGroupRow): RosterCell {
  if (row.aht_seconds === null) {
    return { kind: 'unmeasured', text: '—', note: 'No call has finished' };
  }
  return { kind: 'measured', text: agentSeconds(row.aht_seconds), value: row.aht_seconds };
}

/**
 * This row's share of the campaign's conversions — the contribution figure, and
 * the only one on this screen that is DERIVED rather than served.
 *
 * ── Its denominator is the campaign's own total, and that is the point ─────
 * The share is `row.successes / total.successes`, where `total` is the
 * campaign-grouped row — the campaign as it actually was, departed agents
 * included. So the shares of the listed rows add to 100% only when every row of
 * the campaign is on screen, and fall short when master dropped one or `limit`
 * cut one; {@link contributionAsymmetryNote} names what is missing, and
 * deliberately does NOT claim the shortfall equals it (a departed member who
 * booked nothing moves no share at all). Normalising it away (dividing by the sum
 * of the visible rows) would make the column always add to 100% and quietly
 * redefine "the campaign" as "the people still here".
 *
 * Through the one `ratePct` helper, so a zero denominator is `null` rather than
 * `NaN` — a campaign with dials and no bookings yet is the ordinary case, and
 * `0 / 0` renders as a broken cell where `null` renders as a sentence.
 *
 * `total === null` is a different absence again: the campaign's own line could not
 * be read. The cell is then a BARE em dash, deliberately: the page already states
 * that fact twice — once in a paragraph with a retry, once in the footer cell that
 * spans the metrics — and repeating it in every row's Share cell made a failed
 * total read say one thing forty-two times on a forty-agent campaign. A column of
 * identical sentences is a column nobody reads, and it buries the two places that
 * can actually do something about it.
 *
 * ── **Not gated on `rates_reportable`**, and here the reason is arithmetic ──
 * The roster's precedent already says a non-rate figure is not withheld, and Share
 * has a second, sharper reason of its own: its denominator is not this row's thin
 * volume, it is the CAMPAIGN's conversions. A row with three dials and one booking
 * on a campaign that booked eighty really did contribute 1.3% of it — an exact
 * fact about a large denominator, not a rate estimated from a small one, so the
 * noise argument the flag exists for does not apply.
 *
 * And withholding it would break the one property this column is read for. The
 * shares are meant to add up, and to fall short only for reasons the page NAMES —
 * which is what {@link contributionAsymmetryNote} and
 * {@link contributionTruncationNote} between them do. Blanking the thin rows'
 * shares would make the column fall short for a further, unstated reason, and turn
 * those sentences into an incomplete explanation of the gap.
 * Withholding the CONTRIBUTION figure on the contribution screen would also hide
 * the answer to the only question the screen asks, in the rows where a supervisor
 * most needs it: the thin rows are the ones they are checking are thin.
 */
export function contributionShareCell(
  row: AgencyGroupRow,
  total: AgencyGroupRow | null,
): RosterCell {
  if (total === null) {
    // Bare: no note. See the header — the paragraph and the footer each say it
    // once, and a row is not the place to say it again.
    return { kind: 'unmeasured', text: '—', note: '' };
  }
  const share = ratePct(row.successes, total.successes);
  if (share === null) {
    return { kind: 'unmeasured', text: '—', note: 'No conversions on this campaign yet' };
  }
  return { kind: 'measured', text: agentPct(share), value: share };
}

// ─── The honesty affordances ─────────────────────────────────────────────────

/**
 * `6 agents dialled this campaign` — the POPULATION, not the row count.
 *
 * `total_groups` is core's pre-`limit`, pre-filter count of groups, and with one
 * campaign filtered and `agent` grouped a group IS an agent. It is the right
 * number for this sentence for the same reason `total_agents` is on the roster:
 * `rows.length` would move when a former member was dropped or when `limit` cut
 * the page, which reads as the campaign having had fewer people on it.
 *
 * The wording is taken from the ECHO rather than from the request: a page that
 * came back without one campaign in scope is not describing agents on a campaign,
 * and this sentence must not claim it is.
 *
 * ── That case now says NOTHING, rather than saying it in wire words ────────
 * It used to render `6 groups`. "Group" is the route's vocabulary for a row of an
 * aggregate and belongs nowhere a supervisor can read it, and the branch is
 * unreachable anyway — the view requires one campaign, the hook refuses a blank
 * id and the caller only offers the way in with one in scope. Rather than keep an
 * unreachable branch printing a word this product does not use, it is `null`: with
 * no campaign in the echo there is no population sentence to write, because a
 * group in a `campaign`-less read is an agent-and-campaign PAIR rather than a
 * person, and no true short sentence says that.
 */
export function contributionCountReadout(page: AgencyGroupPage): string | null {
  if (page.campaign_id === null) return null;
  return page.total_groups === 1
    ? '1 agent dialled this campaign'
    : `${agentCount(page.total_groups)} agents dialled this campaign`;
}

/**
 * ⚠️ The reconciliation note — the sentence this screen exists to not need
 * explaining afterwards.
 *
 * ── The asymmetry, concretely ─────────────────────────────────────────────
 * The campaign's own total is an aggregate over everyone who dialled it, and
 * master has nothing to drop from it: no row belongs to a person, so nobody can be
 * filtered out of it. The agent rows beside it are per-person, and master DOES
 * drop some of them. So the two do not reconcile.
 *
 * Neither number is wrong. Showing them adjacent with nothing said is, and it is
 * the specific failure the contract calls out for this screen: a supervisor adding
 * the column up, finding it short of the total, and concluding that one of the two
 * figures is broken — or worse, not noticing.
 *
 * ── What this note may NOT claim, and why the "exactly" clause is gone ─────
 * It used to end *"their shares add to less than 100%, and the difference is
 * exactly those members' work"*. Three independent states falsify that, and all
 * three are reachable:
 *
 *  1. **Shares are conversions over conversions.** A departed member with 40 dials
 *     and NO bookings changes no share at all: two visible agents on 50 and 30 of
 *     a campaign's 80 still render `62.5% + 37.5% = 100.0%` while the sentence
 *     says they add to less. Their *work* is missing; their *share* is zero.
 *  2. **`unattributed_omitted`.** Rows master could not attribute to a person are
 *     dropped and counted separately from `inactive_omitted` (they never were
 *     members, so calling them former ones would be false), so they shrink the
 *     rows for a second reason that "exactly those members' work" denies.
 *  3. **Truncation.** `limit` is applied in SQL, so core cuts before master
 *     filters. A page with `total_groups: 260`, `limit: 200` renders this note and
 *     {@link contributionTruncationNote} simultaneously, and the old wording made
 *     them contradict each other on screen.
 *
 * So the note keeps the clause that is true in every one of those states — the
 * rows do not add up to the total — names what is missing from them, and makes no
 * quantitative claim about the size of the gap. That is also the precedent set by
 * the roster's own `inactiveNote`, which deliberately quantifies nothing. One
 * honest sentence, rather than the true clause plus a hedge plus a hedge.
 *
 * `null` when nothing was dropped, which is the common case and needs no sentence.
 * Truncation alone does not raise it either: the truncation note already says the
 * page was cut, and by which order. And `null` when there are no ROWS: every
 * sentence here is about "the rows below", so a page whose every dialer has departed
 * gets the caller's own screen for that instead of a note about rows that are not
 * there.
 */
export function contributionAsymmetryNote(
  page: AgencyGroupPage,
  total: AgencyGroupRow | null,
): string | null {
  /*
    Both counts through `typeof`, for the same reason the roster's notes carry one:
    master invented both fields and has a documented degrade path that serves core's
    body unrecognised, and a comparison against `undefined` should never be
    reachable from a typed field the wire can omit.
  */
  const hidden = typeof page.inactive_omitted === 'number' ? page.inactive_omitted : 0;
  const unattributed =
    typeof page.unattributed_omitted === 'number' ? page.unattributed_omitted : 0;
  if (hidden <= 0 && unattributed <= 0) return null;

  /*
    Every sentence below is about "the rows below", so with no rows there is no
    sentence — every agent who dialled this campaign has since left, and that is a
    whole screen of its own (the caller's `contribution-all-departed`, which names
    the same remedy). Rendering both put "the rows below do not add up to it"
    directly above the paragraph explaining that there are none.
  */
  if (page.rows.length === 0) return null;

  const clauses: string[] = [];
  if (hidden > 0) {
    const people =
      hidden === 1 ? '1 former team member is' : `${agentCount(hidden)} former team members are`;
    clauses.push(`${people} hidden here`);
  }
  if (unattributed > 0) {
    // Named as what it is. These rows were never members, so "former" would be a
    // false description of them, and the count is master's own for that reason.
    clauses.push(
      unattributed === 1
        ? '1 row could not be attributed to a person'
        : `${agentCount(unattributed)} rows could not be attributed to a person`,
    );
  }
  const missing = clauses.join(' and ');

  /*
    The remedy is named only when the toggle can actually put something back — it
    reveals former members and does nothing for an unattributable row. The control
    itself sits directly beneath this sentence, so naming it is a label rather than
    a direction to go hunting.
  */
  const remedy = hidden > 0 ? ' Tick “Show former team members” to put them back.' : '';

  /*
    With no campaign line on screen there is nothing to fail to add up TO, so the
    note says the part that is still true — work is missing from the rows — rather
    than describing a comparison the reader cannot make.
  */
  if (total === null) {
    return `${missing.charAt(0).toUpperCase()}${missing.slice(1)}, so work is missing from the rows below.${remedy}`;
  }

  return (
    `The campaign’s own total counts everyone who dialled it, and ${missing}, so the ` +
    `rows below do not add up to it.${remedy}`
  );
}

/**
 * "Showing the top 200 by conversions", or `null` when nothing was cut.
 *
 * The roster's rule, unchanged and for the same reason: **no "showing X of Y"
 * fraction is derivable here.** Core scopes, groups, ranks and cuts to `limit`;
 * master then filters the page it was handed. So `total_groups`, `rows.length` and
 * `inactive_omitted` are three independent true facts, and this is one of them —
 * the page was cut, and by which order, because "the rest" only means something
 * relative to the ranking that selected these rows.
 *
 * The order comes from the server's ECHO rather than from what this client asked
 * for: a `sort` the server defaulted or clamped would otherwise be described to
 * the reader incorrectly by the very screen that was truncated.
 */
export function contributionTruncationNote(page: AgencyGroupPage): string | null {
  if (typeof page.inactive_omitted !== 'number') return null;
  /*
    BOTH of master's drop counts are added back before the comparison, not just the
    departed members. A row master could not attribute to a person is counted in
    `total_groups` (core counted it) and is in neither `rows` nor
    `inactive_omitted` — so without this the comparison was false with nothing
    truncated, and the note claimed the rest of the campaign was further down an
    order on a page showing all of it. Inherited from the roster, and fixed on both.

    Absent means 0, which is the behaviour that shipped before the field.
  */
  const unattributed =
    typeof page.unattributed_omitted === 'number' ? page.unattributed_omitted : 0;
  if (page.total_groups <= page.rows.length + page.inactive_omitted + unattributed) return null;
  const order = CONTRIBUTION_SORT_LABELS[page.sort] ?? page.sort;
  return `Showing the top ${agentCount(page.limit)} by ${order} — the rest are further down that order.`;
}

/**
 * What the campaign's own line is called, and what it is over.
 *
 * Named in the row itself rather than only in a header, because this line is the
 * denominator of the Share column and of the note above the table: a footer
 * labelled "Total" would leave a reader to guess whether it totals the rows above
 * it (it does not) or the campaign (it does).
 */
export const CONTRIBUTION_TOTAL_LABEL = 'This campaign';
export const CONTRIBUTION_TOTAL_SUBLINE = 'everyone who dialled it';
