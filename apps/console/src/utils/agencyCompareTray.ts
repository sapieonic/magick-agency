import { agentDisplayName } from './agencyAgentFloor';
import {
  ahtBandReadout,
  bandReadout,
  cohortComparable,
  connectRateCell,
  connectsText,
  conversionCell,
  conversionsText,
  dialsText,
  handleTimeCell,
  pooledRate,
  teamUtilisation,
  utilisationBasis,
  utilisationCell,
  type RosterCell,
} from './agencyAgentRoster';
import { agentSeconds } from './agencyAgentPerformance';
import type {
  AgencyRosterAgentRowWithName,
  AgencyRosterBenchmark,
  AgencyRosterPage,
} from '../types/agency-stats';

/**
 * The compare tray — two to four people from the roster, side by side against the
 * floor's own band.
 *
 * ── It issues ZERO requests, and that is the ruling rather than an optimisation ─
 * Everything it needs is already on the roster page the supervisor is looking at:
 * its rows and its `benchmark`. Nothing is fetched, so nothing in the tray can
 * disagree with the table directly above it — which is the failure a "vs team"
 * fetch would introduce the first time the two reads straddled a minute boundary.
 *
 * ── The one-line hazard the ruling avoids ─────────────────────────────────
 * The obvious server-side shape is a `compare_to` param on the per-agent stats
 * route. The API's `proxy-agency-performance.routes.ts` holds ONE
 * `AGENT_STATS_QUERY_PARAMS` whitelist shared by `/my-stats` and its supervisory
 * twin, so adding `compare_to` to it would expose that param on the agent's own
 * scorecard **in the same edit** — and the cohort band is supervisor-only by
 * design. It would arrive as a change that reads like it only touches the
 * supervisory surface. So: no `compare_to`, no new param, no server change. There
 * is nothing to gate, because nothing new is reachable.
 *
 * ── Suppressed entirely on a pooled cohort ────────────────────────────────
 * `cohortComparable(page)` is false for the all-campaigns read, and a pooled
 * multi-campaign cohort is not a peer group: a telecaller agency works several
 * dealerships at once and intrinsic connectability differs between their lead
 * lists by a large factor. `mixedCohortNote` already says the per-person comparison
 * is switched off there, and a tray is **the most emphatic possible per-person
 * comparison against a band** — offering it would contradict that sentence in the
 * loudest way available on the surface.
 *
 * ── A metric withheld on the roster stays withheld here ───────────────────
 * Every cell below is the roster's own cell function, called on the roster's own
 * row. Not a re-implementation and not a re-derivation: the tray may not become a
 * way to read a number the table two inches above it declined to print, and calling
 * the same function is the only version of that guarantee no future edit can
 * quietly break.
 */

// ─── The bounds ──────────────────────────────────────────────────────────────

/**
 * Two, because one person compared against a band is the roster row they came
 * from — the table already draws that, with a bullet and a chip.
 */
export const COMPARE_MIN_AGENTS = 2;

/**
 * Four, because beyond that a tray IS a second roster and the roster already
 * exists. The cap is not about layout: a wide comparison is a ranking, and a
 * ranking asked of four hand-picked rows is a ranking over a sample the reader
 * chose, which is the one thing the server's ordered page is not.
 */
export const COMPARE_MAX_AGENTS = 4;

// ─── Whether there is a tray at all ──────────────────────────────────────────

/**
 * Why the tray is not on screen, or `null` when it is.
 *
 * A reason rather than a boolean because the two are different situations and only
 * one of them is worth a sentence: `too_few_agents` is self-evident from a
 * one-row table, while `pooled_cohort` is a decision the reader might otherwise
 * look for the control of. Even so the tray renders NOTHING in both cases — the rule is
 * suppressed entirely, and `mixedCohortNote` above the table has already explained
 * the pooled case in the reader's own words. A second sentence naming a control
 * that is not there would be an invitation to go looking for it.
 */
export type CompareSuppression = 'pooled_cohort' | 'too_few_agents' | null;

export function compareSuppression(page: AgencyRosterPage): CompareSuppression {
  /*
    The pooled check FIRST, so the reason a pooled page with one row gives is the
    one that would still hold if it had forty. Reporting `too_few_agents` there
    would imply the tray appears once more people dial, which is false.
  */
  if (!cohortComparable(page)) return 'pooled_cohort';
  if (page.rows.length < COMPARE_MIN_AGENTS) return 'too_few_agents';
  return null;
}

/** True when the tray may be offered at all. */
export function compareAvailable(page: AgencyRosterPage): boolean {
  return compareSuppression(page) === null;
}

// ─── The selection ───────────────────────────────────────────────────────────

/**
 * Tick or untick one agent, respecting the cap.
 *
 * Returns the same array identity semantics a reducer wants: a NEW array always, so
 * a caller cannot mutate the selection it is holding. At the cap an untick still
 * works and a tick is a no-op — the alternative (dropping the oldest to make room)
 * silently removes a person the reader deliberately chose, which is worse than a
 * checkbox that does not move.
 */
export function compareToggle(selected: readonly string[], id: string): string[] {
  if (selected.includes(id)) return selected.filter((each) => each !== id);
  if (selected.length >= COMPARE_MAX_AGENTS) return [...selected];
  return [...selected, id];
}

/** Whether ticking this one would do anything — what disables the box at the cap. */
export function compareSelectable(selected: readonly string[], id: string): boolean {
  return selected.includes(id) || selected.length < COMPARE_MAX_AGENTS;
}

/** Enough chosen to compare. Below two there is nothing to compare against but the band. */
export function compareReady(selected: readonly string[]): boolean {
  return selected.length >= COMPARE_MIN_AGENTS && selected.length <= COMPARE_MAX_AGENTS;
}

/**
 * What the picker says about the state of the selection.
 *
 * Always a sentence, because the tray's whole affordance is "choose some people"
 * and an empty panel with checkboxes in it does not say how many. The cap is named
 * only once it is reached: "up to 4" printed at zero selections reads as a limit
 * being imposed before anything has been done.
 */
export function compareSelectionHint(selected: readonly string[]): string {
  const chosen = selected.length;
  if (chosen === 0) return `Pick ${COMPARE_MIN_AGENTS} to ${COMPARE_MAX_AGENTS} people to compare.`;
  if (chosen < COMPARE_MIN_AGENTS) return `${chosen} picked — choose at least ${COMPARE_MIN_AGENTS}.`;
  if (chosen >= COMPARE_MAX_AGENTS) {
    return `${chosen} picked — that is the most this compares at once. Untick one to swap.`;
  }
  return `${chosen} picked.`;
}

/**
 * The selected rows, **in the page's own order** rather than in the order they were
 * ticked.
 *
 * The page's order is the server's ranking, and the roster's copy already tells the
 * reader what it is ("sorted by conversions"). A tray in click order would put two
 * people in an order that means nothing beside a table whose order means something,
 * and a reader comparing the two would read the tray's order as a second ranking.
 *
 * Ids with no row are dropped: a selection can outlive a refetch that removed
 * somebody (a narrower window, a campaign change, the inactive toggle), and a
 * missing row is not a person to render an empty column for.
 */
export function compareRows(
  page: AgencyRosterPage,
  selected: readonly string[],
): AgencyRosterAgentRowWithName[] {
  const wanted = new Set(selected);
  return page.rows.filter((row) => wanted.has(row.agent_user_id));
}

/**
 * Ids in the selection that the page no longer carries.
 *
 * Named so the caller can prune them rather than leaving a count that disagrees with
 * the columns on screen — "3 picked" over two columns is the kind of small lie that
 * makes a reader distrust the numbers beside it.
 */
export function compareMissing(
  page: AgencyRosterPage,
  selected: readonly string[],
): string[] {
  const present = new Set(page.rows.map((row) => row.agent_user_id));
  return selected.filter((id) => !present.has(id));
}

/** The name to show for one row — the roster's own fallback, so an id stays marked as one. */
export function compareAgentName(row: AgencyRosterAgentRowWithName): string {
  return agentDisplayName(row);
}

// ─── The metrics ─────────────────────────────────────────────────────────────

/**
 * One column of the tray.
 *
 * ── `cell` is the ROSTER's function, passed through rather than re-derived ──
 * That is the whole mechanism behind "a metric withheld on the roster stays
 * withheld in the tray". A second implementation of `conversionCell` here would be
 * a second answer to "may this rate be quoted", and it would drift the first time
 * one of them was edited — which is exactly how the 100%-on-one-connect row reached
 * a named person on the contribution screen.
 *
 * ── `band` and `pooled` are the floor's, off the BENCHMARK ─────────────────
 * Never summed from the rows: the benchmark is deliberately unaffected by
 * `include_inactive`, and a row-derived floor figure would move when the reader
 * revealed former members — a different number under the same name.
 *
 * `band` is `null` where the payload carries no percentile block for the metric
 * (`aht` is additive), which renders NO line rather than "no median yet": that
 * sentence is a claim about the floor, and making it about a field the API has not
 * shipped would be a false one.
 */
export interface CompareMetric {
  key: 'dials' | 'connects' | 'conversions' | 'connect_rate' | 'success_rate' | 'aht' | 'occupancy';
  label: string;
  /** The denominator, or what the count counts — the roster's header hints, unchanged. */
  hint: string;
  /** One agent's figure. A count is plain text; a rate is a {@link RosterCell}. */
  cell: (row: AgencyRosterAgentRowWithName) => RosterCell;
  /** The floor's own figure for the pinned row. */
  pooled: (benchmark: AgencyRosterBenchmark) => string;
  /** The floor's distribution, or `null` when the payload carries none. */
  band: (benchmark: AgencyRosterBenchmark) => string | null;
  /** The arithmetic behind one agent's figure, where the roster shows one. */
  basis?: (row: AgencyRosterAgentRowWithName) => string | null;
}

/** A plain count, as the union's `measured` arm — so the renderer has one shape to draw. */
function countCell(text: string, value: number): RosterCell {
  return { kind: 'measured', text, value };
}

/**
 * The columns, in the roster's reading order: the three counts, then the three
 * rates, then utilisation.
 *
 * ── The counts are here because the rates may be withheld ─────────────────
 * A tray of four people whose conversion rates all read "Not enough calls" is
 * unreadable without the denominators that made them thin, and the roster's own
 * rule is that a count sits immediately left of the rate built from it. Dropping
 * them would make the tray the one screen where a withheld rate has nothing beside
 * it explaining itself.
 */
export const COMPARE_METRICS: readonly CompareMetric[] = [
  {
    key: 'dials',
    label: 'Dials',
    hint: 'attempts placed',
    cell: (row) => countCell(dialsText(row), row.attempts),
    pooled: (benchmark) => benchmark.attempts.toLocaleString(),
    band: () => null,
  },
  {
    key: 'connects',
    label: 'Connects',
    hint: 'answered',
    cell: (row) => countCell(connectsText(row), row.connected),
    pooled: (benchmark) => benchmark.connected.toLocaleString(),
    band: () => null,
  },
  {
    key: 'conversions',
    label: 'Conversions',
    hint: 'booked',
    cell: (row) => countCell(conversionsText(row), row.successes),
    pooled: (benchmark) => benchmark.successes.toLocaleString(),
    band: () => null,
  },
  {
    key: 'connect_rate',
    label: 'Connect rate',
    hint: 'of dials',
    cell: connectRateCell,
    pooled: (benchmark) => pooledRate(benchmark.connect_rate_pct),
    band: (benchmark) => bandReadout(benchmark.connect_rate),
  },
  {
    key: 'success_rate',
    label: 'Conversion rate',
    hint: 'of connects',
    cell: conversionCell,
    pooled: (benchmark) => pooledRate(benchmark.success_rate_pct),
    band: (benchmark) => bandReadout(benchmark.success_rate),
  },
  {
    key: 'aht',
    label: 'AHT',
    hint: 'talk + wrap-up per connect',
    cell: handleTimeCell,
    // The STOPWATCH in a numeric cell, and the unit-naming format in the band's
    // sentence beneath it. `median 22:00` is distinguishable from twenty-two hours
    // only by counting colons, which is the one mistake this pairing avoids.
    pooled: (benchmark) =>
      benchmark.aht_seconds === null ? '—' : agentSeconds(benchmark.aht_seconds),
    band: ahtBandReadout,
  },
  {
    key: 'occupancy',
    label: 'Utilisation',
    hint: 'handled ÷ shift',
    cell: utilisationCell,
    // The team row's three-way helper: the floor's own pooled rate, the median
    // stand-in when `shift_seconds` has not arrived, and an em dash when the floor
    // has no measured shift at all.
    pooled: (benchmark) => teamUtilisation(benchmark).text,
    band: (benchmark) => teamUtilisation(benchmark).note,
    basis: utilisationBasis,
  },
];

/**
 * The floor's pooled utilisation arithmetic, for the line under the pinned figure.
 *
 * Exposed separately rather than folded into {@link CompareMetric} because it exists
 * on exactly one metric and only on the floor's row — `teamUtilisation` returns it
 * as `null` on the two paths where there is no pooled figure to explain.
 */
export function compareFloorUtilisationBasis(benchmark: AgencyRosterBenchmark): string | null {
  return teamUtilisation(benchmark).basis;
}

/**
 * What the tray is called, and what the floor row in it is.
 *
 * Named as the floor rather than as a "Total" for the roster's reason: this row is
 * what the columns above it are being read against, and a label saying "Total" would
 * leave a reader to guess whether it totals the two to four people in the tray (it
 * does not) or the floor (it does).
 */
export const COMPARE_FLOOR_LABEL = 'This floor · this window';
export const COMPARE_FLOOR_SUBLINE = 'everyone who dialled, not just the people above';

/**
 * `Comparing Ravi Kumar and Priya Nair against the floor` — the caption.
 *
 * The names rather than a count, because the caption is what a screen reader reads
 * before the table and "comparing 2 agents" is a fact the reader already has from
 * having chosen them.
 */
export function compareCaption(rows: readonly AgencyRosterAgentRowWithName[]): string {
  const names = rows.map((row) => compareAgentName(row));
  return names.length === 0
    ? 'Nobody picked to compare'
    : `Comparing ${joinNames(names)} against the floor’s own figures and bands`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const head = names.slice(0, -1).join(', ');
  return `${head} and ${names[names.length - 1] ?? ''}`;
}

/**
 * The one sentence the tray adds that the roster does not already say.
 *
 * It exists because the tray looks like a comparison of the people IN it, and it is
 * not: every band on it is the whole floor's, including the people who were not
 * picked. A reader who reads "middle half 28.4%–41.2%" as the middle half of the two
 * columns above it has read a different and much narrower claim.
 *
 * The window is named for the same reason the roster names it: a band quoted in a
 * pay conversation needs the range it was measured over, and "this week" on a Monday
 * morning means something different every hour.
 */
export function compareBandBasisNote(page: AgencyRosterPage): string {
  const scope =
    page.campaign_id === null
      ? 'every campaign in scope'
      : 'this campaign only';
  return (
    `Every band below is the whole floor’s over ${scope} — not the middle half of the ` +
    `people picked here. The people picked are only the columns.`
  );
}
