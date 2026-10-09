import { describe, it, expect } from 'vitest';
import {
  COMPARE_MAX_AGENTS,
  COMPARE_METRICS,
  COMPARE_MIN_AGENTS,
  compareAvailable,
  compareBandBasisNote,
  compareCaption,
  compareFloorUtilisationBasis,
  compareMissing,
  compareReady,
  compareRows,
  compareSelectable,
  compareSelectionHint,
  compareSuppression,
  compareToggle,
} from '../../utils/agencyCompareTray';
import {
  connectRateCell,
  conversionCell,
  handleTimeCell,
  utilisationCell,
} from '../../utils/agencyAgentRoster';
import { hollowRow, rosterBenchmark, rosterPage, rosterRow, thinRow } from '../helpers/roster';

/**
 * The compare tray's derivations.
 *
 * ── The three properties every case here is about ─────────────────────────
 *  1. **It fetches nothing.** Everything comes off the roster page in hand, which is
 *     why this file needs no mocks at all — there is no seam to stub because there is
 *     no request to make.
 *  2. **It is suppressed entirely on a pooled cohort.** `cohortComparable` is false
 *     for the all-campaigns read, and a tray is the most emphatic per-person
 *     comparison against a band the surface has.
 *  3. **A metric withheld on the roster stays withheld here** — because the tray's
 *     cells ARE the roster's cell functions, not copies of them.
 */

describe('agencyCompareTray — the bounds', () => {
  it('compares between two and four people', () => {
    /**
     * Two, because one person against a band is the roster row they came from — the
     * table already draws that, with a bullet and a chip. Four, because beyond that a
     * tray is a second roster and the roster already exists.
     */
    expect(COMPARE_MIN_AGENTS).toBe(2);
    expect(COMPARE_MAX_AGENTS).toBe(4);
  });

  it('is not ready below the minimum or above the maximum', () => {
    expect(compareReady([])).toBe(false);
    expect(compareReady(['a'])).toBe(false);
    expect(compareReady(['a', 'b'])).toBe(true);
    expect(compareReady(['a', 'b', 'c', 'd'])).toBe(true);
    expect(compareReady(['a', 'b', 'c', 'd', 'e'])).toBe(false);
  });

  it('refuses a fifth tick rather than silently dropping the first', () => {
    /**
     * Dropping the oldest to make room removes a person the reader deliberately
     * chose, which is worse than a checkbox that does not move — and it is invisible,
     * because the column that vanishes is at the far end of the tray.
     */
    const four = ['a', 'b', 'c', 'd'];
    expect(compareToggle(four, 'e')).toEqual(four);
    expect(compareSelectable(four, 'e')).toBe(false);
    // An untick still works at the cap, and a re-tick of an already-chosen id is a
    // removal rather than a no-op.
    expect(compareToggle(four, 'b')).toEqual(['a', 'c', 'd']);
    expect(compareSelectable(four, 'b')).toBe(true);
  });

  it('never mutates the selection it was handed', () => {
    const selected = ['a', 'b'];
    expect(compareToggle(selected, 'c')).not.toBe(selected);
    expect(selected).toEqual(['a', 'b']);
  });

  it('says how many are picked, and names the cap only once it is reached', () => {
    expect(compareSelectionHint([])).toContain('Pick 2 to 4');
    expect(compareSelectionHint(['a'])).toContain('at least 2');
    expect(compareSelectionHint(['a', 'b'])).toBe('2 picked.');
    expect(compareSelectionHint(['a', 'b', 'c', 'd'])).toContain('most this compares');
  });
});

describe('agencyCompareTray — suppressed where a band is not a peer group', () => {
  it('is suppressed entirely on the pooled all-campaigns read', () => {
    /**
     * The mutation this case exists for. `campaign_id: null` is the pooled read: every
     * campaign in the account in one cohort, which is what `mixedCohortNote` already
     * tells the reader switches the per-person comparison off. A tray offered there
     * would contradict that sentence in the loudest way the surface allows — a
     * side-by-side of two named people against a median that mixes different dealers'
     * lead lists.
     */
    const pooled = rosterPage({ campaign_id: null, rows: [rosterRow(), thinRow()] });
    expect(compareSuppression(pooled)).toBe('pooled_cohort');
    expect(compareAvailable(pooled)).toBe(false);
  });

  it('reports the POOLED reason even on a page that is also too short', () => {
    /**
     * Order matters: reporting `too_few_agents` on a pooled page would imply the tray
     * appears once more people dial, which is false — it never appears there.
     */
    const pooled = rosterPage({ campaign_id: null, rows: [rosterRow()] });
    expect(compareSuppression(pooled)).toBe('pooled_cohort');
  });

  it('is suppressed with fewer than two people to compare', () => {
    expect(compareSuppression(rosterPage({ rows: [rosterRow()] }))).toBe('too_few_agents');
    expect(compareSuppression(rosterPage({ rows: [] }))).toBe('too_few_agents');
  });

  it('is available on one campaign with two or more people', () => {
    const page = rosterPage({ rows: [rosterRow(), thinRow()] });
    expect(compareSuppression(page)).toBeNull();
    expect(compareAvailable(page)).toBe(true);
  });

  it('stays available on a THIN cohort — the bands say so themselves', () => {
    /**
     * `benchmarkUsable` is false when fewer than two agents were rated, and that gates
     * the roster's BULLET rather than the tray: `bandReadout` already renders "no
     * median yet — too few rated agents" on its own terms, which is a true sentence
     * and a useful one. Suppressing the whole tray for it would hide the counts and
     * the withheld notes as well, which are exactly what explain why the cohort is
     * thin.
     */
    const page = rosterPage({
      rows: [rosterRow(), thinRow()],
      benchmark: rosterBenchmark({
        agents_rated: 1,
        connect_rate: { p25: null, median: null, p75: null },
      }),
    });
    expect(compareAvailable(page)).toBe(true);
    expect(COMPARE_METRICS[3]?.band(page.benchmark)).toContain('too few rated agents');
  });
});

describe('agencyCompareTray — the selection against the page', () => {
  it('returns the picked rows in the PAGE’s order, not the tick order', () => {
    /**
     * The page's order is the server's ranking, and the roster's caption already tells
     * the reader what it is. A tray in click order would put two people in an order
     * that means nothing beside a table whose order means something.
     */
    const page = rosterPage({ rows: [rosterRow(), hollowRow(), thinRow()] });
    const rows = compareRows(page, ['user-thin', 'user-1']);
    expect(rows.map((row) => row.agent_user_id)).toEqual(['user-1', 'user-thin']);
  });

  it('drops an id the page no longer carries, and names it', () => {
    /**
     * A selection outlives a refetch — a narrower window, a campaign change, the
     * inactive toggle. An id with no row is not a person to render a column for, and
     * leaving it in the count would print "3 picked" over two columns.
     */
    const page = rosterPage({ rows: [rosterRow(), thinRow()] });
    expect(compareRows(page, ['user-1', 'user-gone'])).toHaveLength(1);
    expect(compareMissing(page, ['user-1', 'user-gone'])).toEqual(['user-gone']);
    expect(compareMissing(page, ['user-1', 'user-thin'])).toEqual([]);
  });

  it('captions the tray with the names, and says the bands are the FLOOR’s', () => {
    const page = rosterPage({ rows: [rosterRow(), thinRow()] });
    const caption = compareCaption(compareRows(page, ['user-1', 'user-thin']));
    expect(caption).toContain('Ravi Kumar');
    expect(caption).toContain('Priya Nair');
    expect(caption).toContain('the floor');
    /*
      The one sentence the tray adds. It exists because the tray LOOKS like a
      comparison of the people in it: a reader who takes "middle half 28.4%–41.2%" for
      the middle half of the two columns above it has read a much narrower claim.
    */
    expect(compareBandBasisNote(page)).toContain('whole floor’s');
    expect(compareBandBasisNote(page)).toContain('this campaign only');
  });
});

describe('agencyCompareTray — a withheld metric stays withheld', () => {
  it('uses the roster’s own cell functions, identically', () => {
    /**
     * Not "produces the same output as" — IS. `COMPARE_METRICS` holds the roster's
     * functions as references, which is what makes "the tray may not be a way to read
     * a number the table declined to print" true by construction rather than by
     * remembering to keep two implementations in step.
     *
     * The mutation this case exists for is a plausible one: someone writing
     * `cell: (row) => ({ kind: 'measured', text: agentPct(row.success_rate_pct ?? 0) })`
     * here to "keep the tray dense" would reveal every rate the roster withholds, and
     * a test comparing rendered strings on a fat fixture row would not notice.
     */
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('connect_rate')?.cell).toBe(connectRateCell);
    expect(byKey.get('success_rate')?.cell).toBe(conversionCell);
    expect(byKey.get('aht')?.cell).toBe(handleTimeCell);
    expect(byKey.get('occupancy')?.cell).toBe(utilisationCell);
  });

  it('withholds a thin row’s rates in words, with the roster’s denominators', () => {
    const row = thinRow();
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    const connect = byKey.get('connect_rate')?.cell(row);
    expect(connect?.kind).toBe('withheld');
    expect(connect?.text).toBe('Not enough calls');
    // DIALS on the connect rate, CONNECTS on the conversion rate: rates and their
    // denominators travel together.
    expect(connect?.kind === 'withheld' ? connect.note : '').toContain('11 dials');
    const conversion = byKey.get('success_rate')?.cell(row);
    expect(conversion?.kind).toBe('withheld');
    expect(conversion?.kind === 'withheld' ? conversion.note : '').toContain('11 connects');
  });

  it('withholds the CONVERSION rate alone on a row with dials and no connects', () => {
    /**
     * 400 dials, 3 connects: `rates_reportable` is true so the connect rate is
     * quotable, and `success_rate_reportable` is false so the conversion rate is not.
     * The same row, two answers, exactly as on the roster.
     */
    const row = hollowRow();
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('connect_rate')?.cell(row).kind).toBe('measured');
    expect(byKey.get('success_rate')?.cell(row).kind).toBe('withheld');
    // Not gated at all: a mean over three finished calls is noisy but not misleading,
    // and withholding it would leave the thinnest row with no readable figure.
    expect(byKey.get('aht')?.cell(row).kind).toBe('measured');
  });

  it('keeps the three COUNTS on screen, because they explain the withheld rates', () => {
    /**
     * A tray of four people whose conversion rates all read "Not enough calls" is
     * unreadable without the denominators that made them thin.
     */
    const row = thinRow();
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('dials')?.cell(row).text).toBe('11');
    expect(byKey.get('connects')?.cell(row).text).toBe('11');
    expect(byKey.get('conversions')?.cell(row).text).toBe('3');
  });
});

describe('agencyCompareTray — the floor row', () => {
  it('takes every figure off the BENCHMARK, never from the rows', () => {
    /**
     * The benchmark is deliberately unaffected by `include_inactive`, so a
     * row-derived floor figure would move when the reader revealed former members —
     * a different number under the same name, which the benchmark's own contract
     * forbids.
     *
     * Pinned here by giving the page rows whose sums are nowhere near the benchmark's:
     * the floor's figures must be the benchmark's regardless.
     */
    const page = rosterPage({ rows: [rosterRow(), thinRow()] });
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('dials')?.pooled(page.benchmark)).toBe('2,495');
    expect(byKey.get('connects')?.pooled(page.benchmark)).toBe('811');
    expect(byKey.get('conversions')?.pooled(page.benchmark)).toBe('149');
    // And not the sum of the two rows, which is 331 dials.
    expect(byKey.get('dials')?.pooled(page.benchmark)).not.toBe('331');
  });

  it('reads a duration band in words and the cell figure as a stopwatch', () => {
    /**
     * `median 22:00` is distinguishable from twenty-two HOURS only by counting colons,
     * which is why the band names its units and the cell does not. Both formats come
     * from one module, so neither can drift.
     */
    const benchmark = rosterBenchmark();
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('aht')?.pooled(benchmark)).toBe('1:14');
    expect(byKey.get('aht')?.band(benchmark)).toContain('median 1m 14s');
  });

  it('renders NO band for a percentile block the payload did not carry', () => {
    /**
     * `benchmark.aht` is additive and merge order puts this console last, so a
     * the API mid-deploy simply has no band to show. `null` renders nothing rather than
     * "no median yet" — that sentence is a claim about the FLOOR, and making it about
     * an unshipped field would be a false one.
     */
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('aht')?.band(rosterBenchmark({ aht: undefined }))).toBeNull();
    // The pooled scalar beside it is unaffected and stays on screen.
    expect(byKey.get('aht')?.pooled(rosterBenchmark({ aht: undefined }))).toBe('1:14');
  });

  it('shows the floor’s pooled utilisation with the arithmetic behind it', () => {
    const benchmark = rosterBenchmark();
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    // 54,000 + 6,400 over 151,000 on shift is exactly 40% — deliberately not the
    // 38.5% median, so the pooled figure cannot be confused for the stand-in.
    expect(byKey.get('occupancy')?.pooled(benchmark)).toBe('40%');
    expect(compareFloorUtilisationBasis(benchmark)).toContain('on shift');
  });

  it('falls back to the median stand-in when the pooled shift has not arrived', () => {
    /**
     * A missing additive field costs the cell its pooled figure, never the render —
     * and the fallback is labelled exactly as it was before the field existed.
     */
    const benchmark = rosterBenchmark({ shift_seconds: undefined });
    const byKey = new Map(COMPARE_METRICS.map((metric) => [metric.key, metric]));
    expect(byKey.get('occupancy')?.pooled(benchmark)).toBe('38.5%');
    expect(compareFloorUtilisationBasis(benchmark)).toBeNull();
  });

  it('names the pooled scope in the band-basis sentence', () => {
    // The pooled page never reaches the tray (it is suppressed), but the sentence is a
    // pure function and must not claim "this campaign only" if it ever did.
    expect(compareBandBasisNote(rosterPage({ campaign_id: null }))).toContain(
      'every campaign in scope',
    );
  });
});
