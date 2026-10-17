import { agentDurationLong, agentPct, ratePct } from '../../agencyAgentPerformance';
import type {
  AgencyRosterAgentRowWithName,
  AgencyRosterBenchmark,
  AgencyRosterPage,
  AgencyRosterPercentiles,
} from '../../../types/agency-stats';
import { formatCount } from '../../format/number';
import { cellMeasured, connectRateCell } from './cells';

/*
  The cohort the rows are read against: the connect-rate axis and bullets, the
  band readouts, the pooled team utilisation and when a comparison is honest at
  all (`benchmarkUsable`, `cohortComparable`). Out of `agencyAgentRoster.ts`,
  which re-exports everything here.
*/

/**
 * One row's connect rate drawn against the cohort's middle-half band.
 *
 * ── Why a bullet and not a bar ─────────────────────────────────────────────
 * A bar answers "how big"; nobody scanning a roster needs that — 34% next to 31%
 * is not a size question. The question is "is this person unusual", and that is
 * unanswerable without the band, which is exactly what the server puts on the
 * payload beside the row.
 *
 * ── Percentages, and still not a 0–100 axis ────────────────────────────────
 * A connect rate lives in a narrow part of its own range (a real floor sits
 * somewhere in the teens to the forties), so drawing it against 0–100 puts every
 * mark in the left third and the band becomes a few pixels wide — the one thing
 * the bullet exists to show. So the axis is computed ONCE for the whole column
 * (see {@link rosterConnectAxis}) and shared by every row: a per-row axis would
 * make two rows with different rates draw identical bars, which is worse than no
 * chart.
 */
export interface RosterBullet {
  /** Where the agent's own rate sits, 0–100 as a share of the axis. */
  value: number;
  /** The cohort's inter-quartile band, or `null` when too few agents were rated. */
  band: { start: number; end: number } | null;
  /** The cohort median's tick, or `null`. */
  median: number | null;
}

/**
 * The shared axis maximum for the connect-rate column, as a percentage.
 *
 * Taken over every row's rate AND the band's own p75, because the band can sit
 * above every returned row when `limit` truncated the roster on a different sort
 * — and a band drawn off the end of its own axis is a chart lying about the
 * comparison it exists to make.
 *
 * Padded by a quarter so the largest mark is not flush against the edge, floored
 * at 10 so a floor with one 2% row does not get an axis that magnifies noise, and
 * capped at 100 because it is a percentage.
 */
export function rosterConnectAxis(
  rows: readonly AgencyRosterAgentRowWithName[],
  benchmark: AgencyRosterBenchmark,
): number {
  const marks: number[] = [];
  for (const row of rows) {
    // Only reportable rates. A withheld rate is not drawn (see `connectBullet`),
    // so letting one stretch the axis would rescale the column for a number the
    // reader is never shown.
    if (row.rates_reportable && row.connect_rate_pct !== null) marks.push(row.connect_rate_pct);
  }
  for (const mark of [benchmark.connect_rate.p75, benchmark.connect_rate.median]) {
    if (mark !== null) marks.push(mark);
  }
  const peak = marks.length > 0 ? Math.max(...marks) : 0;
  return Math.min(100, Math.max(10, Math.ceil((peak * 1.25) / 5) * 5));
}

/** A share of the axis, clamped — a mark outside it is drawn at the edge, never off it. */
function share(value: number, axis: number): number {
  if (axis <= 0) return 0;
  return Math.max(0, Math.min(100, (value / axis) * 100));
}

/**
 * The bullet for one row, or `null` when there is nothing honest to draw.
 *
 * `null` for an unmeasured or a WITHHELD rate, both of them: drawing a bar for a
 * rate the table refuses to print in words would put the number back on screen
 * as a length, which is the same claim in a form nobody can quote but everybody
 * can compare.
 */
export function connectBullet(
  row: AgencyRosterAgentRowWithName,
  benchmark: AgencyRosterBenchmark,
  axis: number,
): RosterBullet | null {
  const cell = connectRateCell(row);
  if (!cellMeasured(cell)) return null;

  const { p25, p75, median } = benchmark.connect_rate;
  return {
    value: share(cell.value, axis),
    band:
      p25 !== null && p75 !== null
        ? { start: share(Math.min(p25, p75), axis), end: share(Math.max(p25, p75), axis) }
        : null,
    median: median !== null ? share(median, axis) : null,
  };
}

// ─── The flag chip ───────────────────────────────────────────────────────────

/**
 * The team row's band readout for ONE metric.
 *
 * Says "median" and "middle half" in those words rather than drawing them, because the
 * pinned row is where a supervisor goes to find out what the bullets above it were
 * measured against — and a legend that is itself a chart answers the question with
 * the thing that raised it.
 *
 * ── It takes the percentiles and NOTHING else, deliberately ────────────────
 * An earlier revision passed `agents_rated` in and, on an all-null block, said
 * *"no agent cleared 20 calls"*. That sentence is only reliably true of the
 * CONNECT-rate pool, and the server resolved the three pools differently:
 *
 *  - `rates_reportable` is `attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR` — the
 *    row's HEADLINE denominator. A row without it enters no pool at all.
 *  - `connect_rate`'s pool is `rates_reportable` plus non-null. Its denominator IS
 *    attempts, so the headline threshold is exactly its own.
 *  - `success_rate`'s pool **additionally** requires `connected >= 20`. So a row
 *    with 400 dials and 3 connects is `rates_reportable: true`, is in the
 *    connect-rate pool, and is absent from the success-rate one. That row's own
 *    flag for this is `success_rate_reportable` — see {@link successRateReportable}.
 *  - `aht`'s pool — the fourth block, added after this list was written — is
 *    the SAME predicate as `success_rate`'s: `rates_reportable` AND
 *    `connected >= 20` AND non-null. `aht_seconds` divides by `connected`, which
 *    is precisely the denominator that second floor protects. It is emphatically
 *    NOT `rates_reportable` alone: gating an AHT comparison on that would draw a
 *    400-dial/3-connect row against a band it was excluded from, which is the
 *    identical defect phase 01 fixed for the conversion rate a hundred lines above.
 *  - `occupancy_pct`'s pool is gated on `rates_reportable` plus non-null and
 *    nothing else. `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` counts CALLS and cannot
 *    gate a rate whose denominator is seconds — there is no minimum-shift floor in
 *    phase 01 and the copy must not imply one.
 *
 * So four blocks describe up to THREE populations, `agents_rated` is not the
 * denominator of any but the first, each block can independently be all-null while
 * the others carry values, and this function therefore renders each block's
 * absence on its own terms without naming a threshold it cannot vouch for. The
 * basis count lives in {@link ratedBasisNote}, once, where it can say what it
 * actually counts.
 *
 * ── `format` is how a DURATION band reads in the same sentence ─────────────
 * Every band on this row was a percentage until the benchmark gained `aht`
 * percentiles, and handling time is seconds. Passing the formatter in — rather
 * than adding a second, nearly identical readout — is what keeps one sentence
 * shape across the row; passing `agentPct` for a duration is the single mistake
 * available here, and it would print `median 74%` for a 74-second call, so the
 * AHT caller goes through {@link ahtBandReadout} rather than calling this
 * directly with a formatter of its choosing.
 */
export function bandReadout(
  percentiles: AgencyRosterPercentiles,
  format: (value: number) => string = agentPct,
): string {
  if (percentiles.median === null) return 'No median yet — too few rated agents';
  const median = `median ${format(percentiles.median)}`;
  if (percentiles.p25 === null || percentiles.p75 === null) return median;
  /*
    "Middle half", not "p25–p75". This module's sibling states the house rule in
    one line — *"'MTD' and 'WTD' are finance words, not agency ones"* — and then
    this readout, the most prominent legend on the surface, printed the quartile
    notation itself. The reader is a floor supervisor at a telecaller agency; the
    band is the middle half of their team and that is what it is called. The
    section's own description above the table already used those words, so the
    legend was the one place disagreeing with the product's voice.
  */
  return `${median} · middle half ${format(percentiles.p25)}–${format(percentiles.p75)}`;
}

/**
 * A percentile block the wire may not have sent at all.
 *
 * `benchmark.aht` is declared optional precisely so this guard cannot be
 * "simplified" away, and the type is in any case a hand-mirrored claim about a
 * payload rather than proof of one — the same reason {@link truncationNote} tests
 * `inactive_omitted` with `typeof`. A block whose
 * members are not numbers-or-null is not a thin cohort, it is a shape this build
 * does not understand, and the difference matters: "no median yet — too few rated
 * agents" is a claim about the FLOOR, and printing it for a field the API has not
 * shipped yet would be a false one.
 *
 * So `null` here means "say nothing", and a present block with a null median says
 * the honest thing on its own.
 */
function readPercentiles(block: unknown): AgencyRosterPercentiles | null {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) return null;
  const record = block as Record<string, unknown>;
  const read = (value: unknown): number | null | undefined => {
    if (value === null) return null;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const p25 = read(record.p25);
  const median = read(record.median);
  const p75 = read(record.p75);
  if (p25 === undefined || median === undefined || p75 === undefined) return null;
  return { p25, median, p75 };
}

/**
 * The handling-time band for the team row, or `null` when there is none to state.
 *
 * Reads exactly as the connect-rate and conversion-rate bands do — the same
 * "median … · middle half …" sentence — with one difference the reader never has
 * to think about: the figures are DURATIONS, so they go through
 * `agentDurationLong` and say their units out loud.
 *
 * The stopwatch format the CELLS use is wrong in this sentence, and the AHT band
 * is where it is worst: `median 22:00` is distinguishable from twenty-two hours
 * only by counting colons. In a right-aligned column of identically shaped values
 * the colons are the format's whole virtue; in prose they are its failure.
 *
 * `null` when the payload did not carry the block, which is an ordinary arrival
 * rather than a violation: `benchmark.aht` is additive (additive) and merge
 * order puts this console last, so an API mid-deploy simply has no band to show
 * here. The pooled `aht_seconds` beside it is unaffected and stays on screen —
 * every absence on this surface degrades to the next-best true statement.
 */
export function ahtBandReadout(benchmark: AgencyRosterBenchmark): string | null {
  const block = readPercentiles(benchmark.aht);
  if (block === null) return null;
  return bandReadout(block, agentDurationLong);
}

/**
 * The team row's utilisation — a REAL pooled rate now that the benchmark carries a
 * pooled denominator, with the median stand-in kept for an API that does not.
 *
 * ── What this replaced ────────────────────────────────────────────────────
 * Every other pinned cell shows the floor's own rate with the distribution
 * beneath it. Utilisation could not: the benchmark carried the cohort's
 * `talk_seconds` and `wrapup_seconds` and no pooled shift, so the floor's actual
 * utilisation was not derivable and the cell showed the cohort MEDIAN with a note
 * saying so — a typical agent standing in for the floor, in a column of pooled
 * rates.
 *
 * ── Pooled from the BENCHMARK, never from the rows ────────────────────────
 * `(talk + wrapup) / shift_seconds`, all four figures off the benchmark, which is
 * the same agent set and the same break-inclusive denominator the row-level
 * `occupancy_pct` uses — so the team figure and the column above it cannot
 * disagree about what the word means. Summing the visible ROWS instead would make
 * this cell move when the reader revealed former members, which the benchmark's
 * contract forbids and a test pins by comparing the whole team row's
 * `textContent` across that toggle.
 *
 * ── Three outcomes, and the middle one is the mid-deploy ──────────────────
 *  - **`pooled`** — the floor's own rate. `basis` is the arithmetic behind it, in
 *    the same words the row-level basis uses, because this is the figure most
 *    likely to reach a pay review and a rate whose denominator nobody can see is
 *    a rate nobody can challenge. The note names it as the FLOOR's, so the median
 *    sitting beside it is legible as the different number it is.
 *  - **`median`** — `shift_seconds` absent from the payload. Falls back to exactly
 *    what this cell showed before the field existed, labelled exactly as it was.
 *    A missing additive field costs the cell its pooled figure, never the render.
 *  - **`unmeasured`** — the field arrived and the floor has no measured shift at
 *    all (the server's agent-state event log shipped after the dialer, so a session
 *    that predates it has no events rather than zeroed ones). An em dash and a
 *    phrase, never `0%`: nobody's shift being recorded is not a floor that sat
 *    idle.
 */
export interface TeamUtilisation {
  kind: 'pooled' | 'median' | 'unmeasured';
  /** The figure, or an em dash. */
  text: string;
  /** The pooled arithmetic, in words — only when there is a pooled figure. */
  basis: string | null;
  /** What the figure IS, and the distribution around it. */
  note: string;
}

export function teamUtilisation(benchmark: AgencyRosterBenchmark): TeamUtilisation {
  const percentiles = readPercentiles(benchmark.occupancy_pct) ?? {
    p25: null,
    median: null,
    p75: null,
  };
  const shift = benchmark.shift_seconds;

  /*
    The additive field, read with `typeof` rather than trusted from the type — see
    `readPercentiles` above for why, and `AgencyRosterBenchmark.shift_seconds` for
    the deployment order that makes it reachable.
  */
  if (typeof shift !== 'number' || !Number.isFinite(shift)) {
    return {
      kind: 'median',
      text: pooledRate(percentiles.median),
      basis: null,
      note: utilisationTeamNote(percentiles),
    };
  }

  const handled = benchmark.talk_seconds + benchmark.wrapup_seconds;
  const rate = ratePct(handled, shift);
  if (rate === null) {
    return {
      kind: 'unmeasured',
      text: '—',
      basis: null,
      // Not "0% utilised". The floor having no recorded shift and the floor
      // having sat idle are different facts, and only one of them is measurable
      // from this payload.
      note: 'No shift recorded for the floor',
    };
  }

  const brk = benchmark.break_seconds;
  // Named rather than subtracted, exactly as on a row: `shift_seconds` INCLUDES
  // break, and naming it separately keeps the stricter reading derivable without
  // this module picking a second definition of one word. Only when there was one —
  // "0:00 break" invites the reader to wonder whether nobody took a break or
  // nobody recorded one, which this payload cannot tell.
  const breakNote =
    typeof brk === 'number' && Number.isFinite(brk) && brk > 0
      ? ` · ${agentDurationLong(brk)} break`
      : '';
  const band = bandReadout(percentiles);
  return {
    kind: 'pooled',
    text: agentPct(rate),
    basis: `${agentDurationLong(handled)} handled of ${agentDurationLong(shift)} on shift${breakNote}`,
    // "The whole floor", against the stand-in's "typical agent" — the two labels
    // are a minimal pair on purpose, because they are the two readings of this
    // column and the cell has shown both.
    note: percentiles.median === null ? 'the whole floor' : `the whole floor · ${band}`,
  };
}

/**
 * The team row's utilisation readout **for a payload with no pooled shift** — the
 * pre-`shift_seconds` fallback, not the rule.
 *
 * ── What this was, and what it now is ─────────────────────────────────────
 * It used to be the only reading available: the benchmark carried the cohort's
 * `talk_seconds` and `wrapup_seconds` and no pooled denominator, so the floor's
 * actual utilisation was not derivable and the cell showed the cohort MEDIAN with
 * this note saying so. The server added `benchmark.shift_seconds`, so the floor's own
 * rate IS derivable and {@link teamUtilisation} is what the cell renders.
 *
 * This function is now reached on exactly one path: the additive field has not
 * arrived (an API mid-deploy), and the cell degrades to precisely the figure and
 * precisely the label it carried before the field existed. It is kept rather than
 * inlined so that fallback is one named, tested thing.
 *
 * Deriving the pooled figure from the ROWS remains rejected in both worlds: the
 * rows are what `include_inactive` moves and the benchmark deliberately is not, so
 * a row-derived team figure would be a different number under the same name.
 *
 * "median" is not repeated in the band that follows, because the value beside it
 * already is one.
 */
export function utilisationTeamNote(percentiles: AgencyRosterPercentiles): string {
  if (percentiles.median === null) return 'No median yet — too few rated agents';
  if (percentiles.p25 === null || percentiles.p75 === null) return 'typical agent';
  return `typical agent · middle half ${agentPct(percentiles.p25)}–${agentPct(percentiles.p75)}`;
}

/**
 * What `agents_rated` actually counts, said once for the whole row.
 *
 * The HEADLINE threshold — enough dials to be rated at all — and not a claim about
 * any one percentile block. It is not attached to a specific median precisely
 * because it is only the exact basis of the connect-rate one; wording it as the
 * population that cleared the dial threshold is true of all three without
 * over-claiming for any.
 */
export function ratedBasisNote(benchmark: AgencyRosterBenchmark): string {
  return `${formatCount(benchmark.agents_rated)} of ${formatCount(benchmark.agents)} with enough calls to rate`;
}

/**
 * The pooled team rate for one metric — the FLOOR's rate, not the median.
 *
 * A separate function from {@link bandReadout} because they are different
 * questions and the pinned row shows both: "what did the floor actually do" and
 * "what does a typical agent do". They diverge most when one agent dialled most
 * of the calls, which is precisely when a supervisor would otherwise quote the
 * wrong one.
 */
export function pooledRate(rate: number | null): string {
  return rate === null ? '—' : agentPct(rate);
}

/**
 * Whether the CONNECT-RATE band is worth drawing a bullet against.
 *
 * Scoped to that one metric on purpose. `agents_rated` is exactly the connect-rate
 * pool's size — a row enters it on `rates_reportable` alone — so it is the one
 * percentile block this count genuinely describes, and the bullet is the only
 * thing drawn against a band. Gating the whole team row on it would hide a
 * perfectly good success-rate or utilisation median because a different pool was
 * thin.
 *
 * One rated agent IS the median, so a bullet drawn against it tells the reader
 * that somebody is exactly average with themselves. The table still renders every
 * figure; it just stops claiming a cohort.
 */
export function benchmarkUsable(benchmark: AgencyRosterBenchmark): boolean {
  return benchmark.agents_rated >= 2 && benchmark.connect_rate.median !== null;
}

// ─── Campaign scope: the comparison this table is only honest inside ─────────

/**
 * Whether the page's cohort supports a comparison between two named people.
 *
 * `false` for the all-campaigns read, and this is the single most consequential
 * decision on the surface.
 *
 * ── What went wrong, concretely ────────────────────────────────────────────
 * The roster defaulted to `campaign_id: null`. The server applies no campaign predicate
 * when the parameter is omitted and the API forwards without defaulting, so the
 * DEFAULT screen pooled every campaign in the account into one cohort — and the
 * median, the middle-half band and the per-row chips were all computed against
 * that pool. A telecaller agency works several car dealerships at once, each with
 * its own lead list; intrinsic connectability and intrinsic bookability differ by
 * a large factor between them. So "their conversion rate is below the bottom
 * quarter of the team" was rendered beside a person's NAME on the strength of a
 * comparison between different dealers' lists. The only thing on screen
 * acknowledging it was a muted twelve-pixel line in the footer reading "Every
 * campaign in scope".
 *
 * The default is now the most recently active campaign
 * ({@link defaultRosterCampaign}). The all-campaigns view stays reachable —
 * "how much did the floor dial this week" is a real question and the counts,
 * durations and per-row rates are all true in it — so what is suppressed is
 * exactly the part that is not: the per-row band comparison. See
 * {@link rosterFlag}'s `comparable` parameter and {@link mixedCohortNote}.
 */
export function cohortComparable(page: AgencyRosterPage): boolean {
  return page.campaign_id !== null;
}

/**
 * The sentence above the table when the cohort is pooled across campaigns, or
 * `null`.
 *
 * Above rather than below, and in the reader's normal text size. The other three
 * notes on this surface are about what is NOT on screen, which is a question the
 * reader has after scanning; this one is about how to read what IS on screen, and
 * a caveat encountered after the number it qualifies has already been read is not
 * a caveat.
 *
 * ── It says what is actually switched off, which is not the bands ─────────
 * It used to say "the band comparison is switched off", while the pinned team row
 * went on rendering four bands — connect rate, conversion rate, utilisation and,
 * since `shift_seconds`, handling time. Those are facts about the cohort and they are true of
 * a pooled cohort too; a sentence claiming they are absent is contradicted by the
 * row directly beneath it. What `comparable === false` actually suppresses is the
 * per-PERSON comparison against them — {@link rosterFlag}'s two band chips and
 * {@link connectBullet}'s bar — so that is what the sentence names.
 */
export function mixedCohortNote(page: AgencyRosterPage): string | null {
  if (cohortComparable(page)) return null;
  return (
    'Every campaign in the account is pooled here, so the team median mixes lead ' +
    'lists — it is not a like-for-like comparison. Counts and rates below are each ' +
    'person’s own, and the pinned row still shows the floor’s own figures and bands; ' +
    'what is switched off until you pick one campaign is comparing any ONE person ' +
    'against them — no chips, and no bullets.'
  );
}
