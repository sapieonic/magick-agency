import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BEST_HOURS_CELLS,
  BEST_HOURS_DAYS,
  BEST_HOURS_GROUP_BY,
  BEST_HOURS_HOURS,
  BEST_HOURS_STEPS,
  BEST_HOURS_VIEWS,
  BEST_HOURS_VIEW_LABELS,
  bestHoursCellLabel,
  bestHoursCountReadout,
  bestHoursCoverageNote,
  bestHoursHourAxisLabel,
  bestHoursHourLabel,
  bestHoursMatrix,
  bestHoursScaleReadout,
  bestHoursStep,
  bestHoursWithheldReadout,
  bestHoursZone,
  weekdayCoverage,
  type BestHoursCell,
  type BestHoursCoverage,
} from '../../utils/agencyBestHours';
import {
  FIXTURE_ZONE,
  SHORT_DAY,
  SHORT_FROM,
  SHORT_LAST_HOUR,
  SHORT_TO,
  WEEK_FROM,
  WEEK_TO,
  bestHoursPage,
  hollowHourCell,
  hourCell,
  thinHourCell,
  unconnectedHourCell,
  withoutSuccessFlag,
} from '../helpers/bestHours';

/**
 * The best-hours map's derivations.
 *
 * ── The four rulings every case below is about ────────────────────────────
 *  - **E3** — the hour axis names the zone the buckets were CUT in, or nothing. Never
 *    the reader's, and never a guess.
 *  - **E4** — an out-of-window weekday is not a zero, and the distinction is derived
 *    in the resolved zone rather than the reader's.
 *  - **E5** — a thin cell is never on the rate ramp and never in the scale's domain,
 *    it still shows its dial count, and the count of withheld cells is stated.
 *  - **E6** — three views over ONE payload, so switching is a re-render.
 *
 * Every fixture cell's rates and flags are derived from its own counts (see
 * `helpers/bestHours.ts`), so no case here can assert a state the server cannot
 * emit — which is the MAG-106 failure the phase-01 contract names.
 */

/** A convenience: pull one cell out of a matrix without indexing through two arrays. */
function cellAt(
  matrix: ReturnType<typeof bestHoursMatrix>,
  day: number,
  hour: number,
): BestHoursCell {
  const row = matrix.rows.find((each) => each.day === day);
  if (row === undefined) throw new Error(`no row for weekday ${day}`);
  const cell = row.cells.find((each) => each.hour === hour);
  if (cell === undefined) throw new Error(`no cell for ${day}:${hour}`);
  return cell;
}

/** The full-week coverage every "colour" case runs against, so nothing is out of window. */
function weekCoverage(): BestHoursCoverage {
  return weekdayCoverage(WEEK_FROM, WEEK_TO, FIXTURE_ZONE);
}

describe('agencyBestHours — what the surface asks for', () => {
  it('cuts by weekday AND hour, which is exactly 168 cells', () => {
    /**
     * The two-dimension cap spent on the two time dimensions, which is what makes
     * `campaign` unavailable in the group and therefore makes a single `campaign_id`
     * filter the only way for the zone to be unambiguous. 168 fits under the route's
     * default `limit` of 200, so the whole map is ONE request at the default limit.
     */
    expect(BEST_HOURS_GROUP_BY).toEqual(['day_of_week', 'hour_of_day']);
    expect(BEST_HOURS_DAYS * BEST_HOURS_HOURS).toBe(168);
    expect(BEST_HOURS_CELLS).toBe(168);
  });

  it('offers three views and no sort', () => {
    // Connect rate first: it is the "best hours to call" question. Volume is here
    // because it is the one view that is always reportable.
    expect(BEST_HOURS_VIEWS).toEqual(['connect_rate', 'volume', 'conversion_rate']);
    // The roster's words for the same three quantities, so a supervisor one click
    // away does not meet a second dialect.
    expect(BEST_HOURS_VIEW_LABELS.connect_rate).toBe('Connect rate');
    expect(BEST_HOURS_VIEW_LABELS.volume).toBe('Dials');
    expect(BEST_HOURS_VIEW_LABELS.conversion_rate).toBe('Conversion rate');
  });

  it('labels an hour with two digits, so a column of them is one width', () => {
    expect(bestHoursHourLabel(0)).toBe('00');
    expect(bestHoursHourLabel(9)).toBe('09');
    expect(bestHoursHourLabel(23)).toBe('23');
  });
});

describe('agencyBestHours — E3, the zone the buckets were cut in', () => {
  it('reads `resolved_timezone` off the page', () => {
    expect(bestHoursZone(bestHoursPage())).toBe('Asia/Kolkata');
  });

  it('says NOTHING when the field did not arrive, rather than guessing', () => {
    /**
     * A core that predates the field. The honest answer is silence: "the 18:00
     * column" is not a fact until a zone is named, and a wrong name is a rostering
     * decision. `undefined` is what makes the `typeof` guard load-bearing.
     */
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: undefined }))).toBeNull();
    expect(bestHoursHourAxisLabel(null)).toBeNull();
  });

  it('treats `null` and a blank string as no zone either', () => {
    // `null` is a read with no zoned dimension; a blank string is a shape nothing
    // should emit. Neither may become a label.
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: null }))).toBeNull();
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: '   ' }))).toBeNull();
  });

  it('refuses a zone name `Intl` cannot resolve, so the axis cannot outrun the map', () => {
    /**
     * ⚠️ It accepted any non-blank string, and the surface then contradicted itself
     * on exactly the campaign whose zone is broken.
     *
     * Core resolves the zone through `LEFT JOIN pg_timezone_names` and COALESCEs to
     * `'UTC'`, so a garbage `default_timezone` does not raise — which is deliberate,
     * and which means a name that resolves to nothing can reach this client through
     * two services and a hand-mirrored type. `weekdayCoverage` already refused such a
     * name (its `Intl.DateTimeFormat` throws a `RangeError`) and answered `known:
     * false`; the axis printed it anyway. So the column head asserted
     * "Hour of day · Asia/Calcutta_typo" above a matrix that had just given up on
     * telling an out-of-window cell from a zero — the axis claiming precisely what the
     * third state denies.
     *
     * One predicate, through the same construction, so the three surfaces cannot
     * disagree about one value.
     */
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: 'Asia/Calcutta_typo' }))).toBeNull();
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: 'Not/AZone' }))).toBeNull();
    // The same string the coverage walk refuses, refused here — asserted together so
    // the two cannot drift apart.
    expect(weekdayCoverage(WEEK_FROM, WEEK_TO, 'Not/AZone').known).toBe(false);
    // And a real zone still passes, so this is not refusing everything.
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: FIXTURE_ZONE }))).toBe(FIXTURE_ZONE);
    // Whitespace around a real name is trimmed rather than rejected.
    expect(bestHoursZone(bestHoursPage({ resolved_timezone: `  ${FIXTURE_ZONE}  ` }))).toBe(
      FIXTURE_ZONE,
    );
  });

  it('leaves the axis unlabelled for a junk zone, exactly as for an absent one', () => {
    // The two causes are different and the reader's position is identical, so the
    // surface degrades one way rather than two: no axis label, and the third state.
    const junk = bestHoursPage({ resolved_timezone: 'Asia/Calcutta_typo' });
    const zone = bestHoursZone(junk);
    expect(bestHoursHourAxisLabel(zone)).toBeNull();
    const matrix = bestHoursMatrix(junk, 'connect_rate', weekdayCoverage(junk.from, junk.to, zone));
    expect(matrix.coverageKnown).toBe(false);
    expect(matrix.outOfWindow).toBe(0);
    expect(matrix.uncoveredDays).toEqual([]);
    expect(bestHoursCoverageNote(matrix)).toContain('cannot tell');
  });

  it('names the CAMPAIGN’s zone on the axis, whatever zone the reader is in', () => {
    /**
     * ⚠️ The reader's zone is the WRONG zone here, and there is already a function
     * returning it: `windowRangeReadout` prints
     * `Intl.DateTimeFormat().resolvedOptions().timeZone`, correctly, for its own
     * caption. Two zones on one screen is the defect E3 exists to prevent.
     *
     * The label is therefore a pure function of its ARGUMENT — it takes no page and
     * reaches for no default — so the only zone it can print is the one it was
     * handed.
     */
    expect(bestHoursHourAxisLabel('Asia/Kolkata')).toContain('Asia/Kolkata');
    expect(bestHoursHourAxisLabel('America/New_York')).toContain('America/New_York');
    const reader = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(bestHoursHourAxisLabel('Pacific/Chatham')).not.toContain(reader);
  });

  it('never reads the browser’s own zone anywhere in the module', () => {
    /**
     * A source-level assertion, in the same category as `hiddenPanelCss.test.ts`:
     * the behavioural version of this test cannot exist, because a build that read
     * the browser's zone would be indistinguishable from a correct one whenever the
     * reader happens to sit in the campaign's zone — which is the common case, and
     * therefore the case a behavioural test would be written in.
     *
     * `resolvedOptions()` is the exact call that returns the reader's zone. This
     * module may pass a zone INTO `Intl` (that is how coverage is derived at all, and
     * the zone is an input there); it may never ask `Intl` what zone to use.
     */
    const source = readFileSync(
      resolve(__dirname, '../../utils/agencyBestHours.ts'),
      'utf8',
    );
    /*
      Comments stripped first, and that is not a convenience: the module's own header
      NAMES `resolvedOptions` while explaining why it must never call it, so a raw
      substring check would fail on the documentation that makes the rule findable —
      and the obvious fix (deleting the explanation) is the opposite of what this test
      is for.
    */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(code).not.toContain('resolvedOptions');
    // And the zone really is an INPUT: the one `Intl` construction takes the argument.
    expect(code).toContain('timeZone: zone');
  });

  it('puts the zone on a cell’s own sentence only when it is known', () => {
    const known = bestHoursCellLabel(
      { day: 2, hour: 18, state: 'no_dials', text: '0', value: null, attempts: 0, note: 'x' },
      'Asia/Kolkata',
    );
    expect(known).toContain('Tuesday 18:00');
    expect(known).toContain('Asia/Kolkata');
    const unknown = bestHoursCellLabel(
      { day: 2, hour: 18, state: 'no_dials', text: '0', value: null, attempts: 0, note: 'x' },
      null,
    );
    expect(unknown).toContain('Tuesday 18:00');
    expect(unknown).not.toContain('/');
  });
});

describe('agencyBestHours — E4, coverage in the resolved zone', () => {
  it('covers all seven weekdays over a full week', () => {
    const coverage = weekCoverage();
    expect(coverage.known).toBe(true);
    for (let day = 0; day < BEST_HOURS_DAYS; day += 1) {
      expect(coverage.covered.get(day)?.size).toBe(24);
    }
  });

  it('covers ONE weekday and part of its hours over a part-day window', () => {
    /**
     * The Monday-morning shape: "today" at 09:00 is nine hours of one weekday, and
     * the other six weekdays were never asked about. Rendering them like "we dialled
     * Tuesday and connected nobody" makes the map lie about six of its seven rows.
     */
    const coverage = weekdayCoverage(SHORT_FROM, SHORT_TO, FIXTURE_ZONE);
    expect(coverage.known).toBe(true);
    expect([...coverage.covered.keys()]).toEqual([SHORT_DAY]);
    const hours = coverage.covered.get(SHORT_DAY);
    expect(hours?.size).toBe(SHORT_LAST_HOUR + 1);
    expect(hours?.has(0)).toBe(true);
    expect(hours?.has(SHORT_LAST_HOUR)).toBe(true);
    // 09:00 is EXCLUSIVE. An hour the window ends exactly on was not asked about.
    expect(hours?.has(SHORT_LAST_HOUR + 1)).toBe(false);
    expect(hours?.has(23)).toBe(false);
  });

  it('is derived in the CAMPAIGN’s zone, not in UTC and not in the reader’s', () => {
    /**
     * The mutation this case exists for. `SHORT_FROM`/`SHORT_TO` are one IST day —
     * Wednesday 00:00 to 09:00 — and in UTC the same interval straddles Tuesday
     * evening and Wednesday morning. So a build that walked the window in UTC (or in
     * a reader's zone west of IST) marks weekday 2 as covered, and Tuesday's row then
     * renders 24 real zeroes for a day nobody was asked about.
     *
     * A window boundary near midnight is exactly where this bites, which is why the
     * fixture window starts on one.
     */
    const coverage = weekdayCoverage(SHORT_FROM, SHORT_TO, FIXTURE_ZONE);
    expect(coverage.covered.has(2)).toBe(false);
    expect(coverage.covered.has(SHORT_DAY)).toBe(true);

    // And the same instants read in UTC really do span the earlier weekday — so the
    // assertion above is discriminating rather than accidentally true.
    expect(new Date(SHORT_FROM).getUTCDay()).toBe(2);
    expect(new Date(SHORT_TO).getUTCDay()).toBe(3);
  });

  it('refuses to answer at all with no zone — it does not fall back', () => {
    /**
     * The interaction between E3 and E4 that neither ruling states: E4 says derive
     * coverage in the resolved zone and never the reader's, so with no resolved zone
     * there is no honest derivation available. `known: false` is what the surface then
     * says out loud, instead of marking the wrong rows as never-asked.
     */
    const coverage = weekdayCoverage(WEEK_FROM, WEEK_TO, null);
    expect(coverage.known).toBe(false);
    expect(coverage.covered.size).toBe(0);
  });

  it('refuses on an unusable zone name, an unparseable bound or an empty window', () => {
    // `Intl.DateTimeFormat` throws a RangeError on an unknown `timeZone`, and this is
    // the one input that can be one — core's `COALESCE(z.name, 'UTC')` crossed two
    // services and a hand-mirrored type to get here.
    expect(weekdayCoverage(WEEK_FROM, WEEK_TO, 'Not/AZone').known).toBe(false);
    expect(weekdayCoverage('not a date', WEEK_TO, FIXTURE_ZONE).known).toBe(false);
    expect(weekdayCoverage(WEEK_FROM, 'not a date', FIXTURE_ZONE).known).toBe(false);
    // Half-open and empty: `to === from` covers nothing, so there is nothing to say.
    expect(weekdayCoverage(WEEK_FROM, WEEK_FROM, FIXTURE_ZONE).known).toBe(false);
    expect(weekdayCoverage(WEEK_TO, WEEK_FROM, FIXTURE_ZONE).known).toBe(false);
  });

  it('does not mark an hour BEFORE the window across a 30-minute DST step', () => {
    /**
     * ⚠️ `Australia/Lord_Howe`, whose spring-forward is **thirty minutes** rather
     * than an hour: on 2026-10-04 the clocks go 02:00 → 02:30, so the zone moves
     * from +10:30 to +11:00.
     *
     * The window below is 02:45 → 04:00 in that zone. The old implementation rewound
     * to "the top of the hour containing `from`" by subtracting the zoned wall-clock
     * minutes as UTC milliseconds — `15:45Z - 45min = 15:00Z` — and 15:00Z in Lord
     * Howe is **01:30**, on the offset that applied BEFORE the step. Hour 1 was
     * therefore marked covered, and hour 1 was never in the window.
     *
     * The visible consequence is the one E4 exists to prevent: a cell nobody was
     * asked about renders `no_dials`, a printed ZERO, in the row a supervisor reads
     * as "stop staffing this slot". So the assertion is the matrix cell as well as
     * the set.
     *
     * The existing DST cases in this file all use one-hour steps, where the
     * subtraction happens to land in the right hour — which is why this shipped.
     */
    const zone = 'Australia/Lord_Howe';
    const from = '2026-10-03T15:45:00.000Z'; // 02:45, after the step (+11:00)
    const to = '2026-10-03T17:00:00.000Z'; // 04:00 the same day

    // The fixture is only discriminating if the zone really does step by 30 minutes
    // here — pinned so a tzdata change cannot make this pass over a boring window.
    const at = (iso: string) =>
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso));
    expect(at('2026-10-03T15:29:00.000Z')).toBe('01:59');
    expect(at('2026-10-03T15:30:00.000Z')).toBe('02:30');

    const coverage = weekdayCoverage(from, to, zone);
    expect(coverage.known).toBe(true);
    // Sunday 2026-10-04. Hours 2 and 3, and NOT hour 1.
    expect([...(coverage.covered.get(0) ?? [])].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(coverage.covered.get(0)?.has(1)).toBe(false);

    // What the reader would have seen: hour 1 as a zero rather than as blank.
    const matrix = bestHoursMatrix(
      bestHoursPage({ from, to, resolved_timezone: zone, rows: [] }),
      'connect_rate',
      coverage,
    );
    expect(cellAt(matrix, 0, 1).state).toBe('out_of_window');
    expect(cellAt(matrix, 0, 1).text).toBe('');
    // And the hours that WERE asked about are still real zeroes, so the assertion
    // above is not passing because everything went blank.
    expect(cellAt(matrix, 0, 2).state).toBe('no_dials');
    expect(cellAt(matrix, 0, 3).state).toBe('no_dials');
  });

  it('covers the LAST partial hour of a window that ends mid-hour', () => {
    /**
     * The property the removed alignment was quietly providing. Walking forward from
     * an unaligned `from` puts the steps on a phase of their own, so a final partial
     * hour can fall between two of them: 00:10 → 02:05 steps 00:10, 00:40, 01:10,
     * 01:40 and then past the end, never landing in hour 2 — which the window does
     * contain, for five minutes, and in which a dial could have landed.
     *
     * Marked explicitly from `to - 1ms` instead, which needs no arithmetic a DST
     * transition can invalidate. The half-open end is unaffected: the case above
     * still pins that an hour the window ends exactly ON is not covered.
     */
    const coverage = weekdayCoverage(
      '2026-08-25T18:40:00.000Z', // 2026-08-26 00:10 IST
      '2026-08-25T20:35:00.000Z', // 2026-08-26 02:05 IST
      FIXTURE_ZONE,
    );
    expect([...(coverage.covered.get(SHORT_DAY) ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2]);
  });

  it('covers the whole hour a window starts part-way through', () => {
    /**
     * A dial could have landed in the first ten minutes of an hour the window enters
     * at 09:50, so that hour WAS asked about. The alternative marks a reader's own
     * first hour as never-asked, which is the same lie in the other direction.
     */
    const coverage = weekdayCoverage(
      '2026-08-25T19:50:00.000Z', // 2026-08-26 01:20 IST
      '2026-08-25T21:00:00.000Z', // 2026-08-26 02:30 IST
      FIXTURE_ZONE,
    );
    expect([...(coverage.covered.get(SHORT_DAY) ?? [])].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('agencyBestHours — E4 in the matrix: absent is two different facts', () => {
  it('marks an out-of-window weekday as never asked, not as a zero', () => {
    const page = bestHoursPage({
      from: SHORT_FROM,
      to: SHORT_TO,
      rows: [hourCell({ day: SHORT_DAY, hour: 2, attempts: 300 })],
    });
    const matrix = bestHoursMatrix(
      page,
      'connect_rate',
      weekdayCoverage(page.from, page.to, FIXTURE_ZONE),
    );

    // Tuesday was not in the window at all.
    expect(cellAt(matrix, 2, 10).state).toBe('out_of_window');
    // And it prints NOTHING — no zero, no rate, nothing that sits on a scale.
    expect(cellAt(matrix, 2, 10).text).toBe('');
    expect(cellAt(matrix, 2, 10).value).toBeNull();
    expect(matrix.rows.find((row) => row.day === 2)?.coveredHours).toBe(0);
    expect(matrix.uncoveredDays).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('marks a covered hour with no dial as a REAL zero, because it is one', () => {
    const page = bestHoursPage({
      from: SHORT_FROM,
      to: SHORT_TO,
      rows: [hourCell({ day: SHORT_DAY, hour: 2, attempts: 300 })],
    });
    const matrix = bestHoursMatrix(
      page,
      'connect_rate',
      weekdayCoverage(page.from, page.to, FIXTURE_ZONE),
    );
    // Hour 5 of Wednesday IS in the window and had no dial. A real finding.
    const zero = cellAt(matrix, SHORT_DAY, 5);
    expect(zero.state).toBe('no_dials');
    expect(zero.text).toBe('0');
    // Hour 20 of the same weekday is beyond the window's end.
    expect(cellAt(matrix, SHORT_DAY, 20).state).toBe('out_of_window');
  });

  it('claims NEITHER fact when the zone is missing', () => {
    const page = bestHoursPage({ resolved_timezone: undefined });
    const matrix = bestHoursMatrix(
      page,
      'connect_rate',
      weekdayCoverage(page.from, page.to, bestHoursZone(page)),
    );
    expect(cellAt(matrix, 5, 5).state).toBe('unknown_coverage');
    // Nothing is asserted to be out of window, because nothing is known to be.
    expect(matrix.outOfWindow).toBe(0);
    expect(matrix.uncoveredDays).toEqual([]);
    expect(matrix.coverageKnown).toBe(false);
    expect(bestHoursCoverageNote(matrix)).toContain('cannot tell a weekday');
  });

  it('names the weekdays that were never in the window', () => {
    const page = bestHoursPage({
      from: SHORT_FROM,
      to: SHORT_TO,
      rows: [hourCell({ day: SHORT_DAY, hour: 2, attempts: 300 })],
    });
    const note = bestHoursCoverageNote(
      bestHoursMatrix(page, 'connect_rate', weekdayCoverage(page.from, page.to, FIXTURE_ZONE)),
    );
    /*
      Named weekday by weekday, because that is the shape of the misreading: a blank
      Tuesday row reads as "stop staffing Tuesdays", and only a sentence naming
      Tuesday stops it reading that way.
    */
    expect(note).toContain('Tuesday');
    expect(note).toContain('Sunday');
    expect(note).toContain('not in this window');
  });

  it('says nothing about coverage when the window covered every cell', () => {
    const matrix = bestHoursMatrix(bestHoursPage(), 'connect_rate', weekCoverage());
    expect(matrix.outOfWindow).toBe(0);
    expect(bestHoursCoverageNote(matrix)).toBeNull();
  });
});

describe('agencyBestHours — E5, a thin cell is never on the ramp', () => {
  it('withholds the colour and keeps the DIAL COUNT', () => {
    /**
     * 2 dials, 1 connect. The served connect rate is `50%`, which on a ramp topping
     * out near a 30% floor median would be the brightest square on the map — and a
     * supervisor moves staffing to Sunday night on the strength of one answered call.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({ rows: [thinHourCell()] }),
      'connect_rate',
      weekCoverage(),
    );
    const cell = cellAt(matrix, 0, 20);
    expect(cell.state).toBe('withheld');
    // No value means no position on the scale is even derivable for it.
    expect(cell.value).toBeNull();
    // It still shows its dial count: "we barely called then" is itself the answer.
    expect(cell.text).toBe('2');
    // The roster's own words, from the roster's own helper.
    expect(cell.note).toContain('2 dials');
    expect(cell.note).toContain('too few to rate');
  });

  it('leaves the thin cell OUT of the scale’s domain', () => {
    /**
     * The mutation this case exists for. Left in, the 50%-on-two-dials cell becomes
     * the domain's maximum and compresses the honest 33% cell into the bottom fifth
     * of the ramp — the map's useful contrast destroyed by the least trustworthy
     * number on it.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
      'connect_rate',
      weekCoverage(),
    );
    expect(matrix.domain).not.toBeNull();
    expect(matrix.domain?.max).toBeCloseTo(100 / 3, 5);
    // 50 is the thin cell's served rate, and it must not be an end of the scale.
    expect(matrix.domain?.max).not.toBeCloseTo(50, 5);
    expect(bestHoursScaleReadout(matrix)).not.toContain('50%');
  });

  it('gives the thin cell no ramp step at all, not the palest one', () => {
    /**
     * A pale ramp step is still a position on the scale and reads as a low value.
     * The step is derived from `cell.value`, which a withheld cell does not have —
     * so there is no code path by which it can acquire one.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
      'connect_rate',
      weekCoverage(),
    );
    const thin = cellAt(matrix, 0, 20);
    expect(thin.value).toBeNull();
    const measured = cellAt(matrix, 1, 10);
    expect(measured.value).not.toBeNull();
    expect(bestHoursStep(measured.value ?? 0, matrix.domain)).toBe(BEST_HOURS_STEPS - 1);
  });

  it('states how many cells were withheld', () => {
    /**
     * A map that is mostly withheld is a map whose window is too short, and the reader
     * must be able to SEE that rather than infer it from a lot of grey.
     */
    const one = bestHoursMatrix(
      bestHoursPage({ rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()] }),
      'connect_rate',
      weekCoverage(),
    );
    expect(one.withheld).toBe(1);
    expect(one.dialled).toBe(2);
    const readout = bestHoursWithheldReadout(one);
    expect(readout).toContain('1 cell has');
    expect(readout).toContain('dial count');
    // Half is not "most of", so no remedy is advised on an even split.
    expect(readout).not.toContain('longer window');
  });

  it('advises a longer window only when MOST of the dialled cells are thin', () => {
    const matrix = bestHoursMatrix(
      bestHoursPage({
        rows: [
          hourCell({ day: 1, hour: 10, attempts: 300 }),
          thinHourCell(),
          thinHourCell({ day: 0, hour: 21 }),
        ],
      }),
      'connect_rate',
      weekCoverage(),
    );
    expect(matrix.withheld).toBe(2);
    expect(bestHoursWithheldReadout(matrix)).toContain('try a longer window');
  });

  it('says nothing when no cell was withheld', () => {
    const matrix = bestHoursMatrix(bestHoursPage(), 'connect_rate', weekCoverage());
    expect(matrix.withheld).toBe(0);
    expect(bestHoursWithheldReadout(matrix)).toBeNull();
  });

  it('names the withheld treatment in the scale readout, so grey is not read as low', () => {
    const matrix = bestHoursMatrix(bestHoursPage(), 'connect_rate', weekCoverage());
    const readout = bestHoursScaleReadout(matrix);
    expect(readout).toContain('not on this scale');
    expect(readout).toContain('dial count');
  });
});

describe('agencyBestHours — E6, three views over one payload', () => {
  it('colours a THIN cell on the volume view, because a count needs no threshold', () => {
    /**
     * Volume is the one always-reportable view, and it is here because it answers the
     * other half of a rostering decision: a 40% cell over 21 dials and a 30% cell over
     * 900 are not the same instruction. A count IS its own volume, so there is nothing
     * to withhold.
     */
    const page = bestHoursPage({
      rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()],
    });
    const matrix = bestHoursMatrix(page, 'volume', weekCoverage());
    const thin = cellAt(matrix, 0, 20);
    expect(thin.state).toBe('measured');
    expect(thin.value).toBe(2);
    expect(thin.text).toBe('2');
    expect(matrix.withheld).toBe(0);
    // And the scale is in dials, with nothing sitting outside it to warn about.
    expect(bestHoursScaleReadout(matrix)).toContain('300');
    expect(bestHoursScaleReadout(matrix)).not.toContain('not on this scale');
  });

  it('gates the conversion view on the CONNECTS flag, not the dials one', () => {
    /**
     * 41 dials and 11 connects: `rates_reportable` is true, so the connect rate is
     * quotable; `success_rate_reportable` is false, because the conversion rate
     * divides by 11. One cell, two answers — which is the whole reason the second flag
     * exists. Gating both views on `rates_reportable` would paint an 18.2% built from
     * eleven connects.
     */
    const page = bestHoursPage({ rows: [hollowHourCell()] });
    expect(cellAt(bestHoursMatrix(page, 'connect_rate', weekCoverage()), 2, 11).state).toBe(
      'measured',
    );
    const conversion = cellAt(bestHoursMatrix(page, 'conversion_rate', weekCoverage()), 2, 11);
    expect(conversion.state).toBe('withheld');
    // CONNECTS, not dials — this rate's own denominator.
    expect(conversion.note).toContain('11 connects');
  });

  it('WITHHOLDS the conversion rate when `success_rate_reportable` never arrived', () => {
    /**
     * ⚠️ The heatmap fails CLOSED here, and it is the only place in the phase that
     * does. The roster and the contribution table fall back to `rates_reportable`
     * when the field is absent, on the grounds that it is what they gated on before
     * the field existed; this grid must not, and the fixture is the proof.
     *
     * 20 dials, 1 connect, 1 conversion. `rates_reportable` is `attempts >= 20`, so
     * the fallback CLEARS it — and `success_rate_pct` is a served `100`. On a ramp
     * whose honest cells top out near a 30% floor median that is the darkest square
     * on the map AND the domain's upper end, compressing every trustworthy cell into
     * the bottom third. That is E5's exact failure at 168× scale, produced by a
     * degrade path rather than by a missing check.
     *
     * The connect rate on the SAME cell stays measured, which is what makes this a
     * per-metric decision rather than a blanket refusal: `rates_reportable` arrived
     * and it is the right flag for a rate over dials.
     */
    const cell = withoutSuccessFlag(
      hourCell({ day: 0, hour: 20, attempts: 20, connected: 1, successes: 1 }),
    );
    expect('success_rate_reportable' in cell).toBe(false);
    expect(cell.rates_reportable).toBe(true);
    expect(cell.success_rate_pct).toBe(100);

    const page = bestHoursPage({ rows: [cell] });
    const conversion = bestHoursMatrix(page, 'conversion_rate', weekCoverage());
    const painted = cellAt(conversion, 0, 20);
    expect(painted.state).toBe('withheld');
    expect(painted.value).toBeNull();
    // Not coloured, and not the ramp's endpoint either — nothing is on the scale.
    expect(conversion.domain).toBeNull();
    expect(conversion.withheld).toBe(1);
    // The served 100% appears nowhere: not as the cell's text, not in its sentence.
    expect(painted.text).toBe('20');
    expect(painted.note).not.toContain('100');

    // And the other two views are untouched. The connect rate has the flag it needs.
    expect(cellAt(bestHoursMatrix(page, 'connect_rate', weekCoverage()), 0, 20).state).toBe(
      'measured',
    );
    expect(cellAt(bestHoursMatrix(page, 'volume', weekCoverage()), 0, 20).state).toBe('measured');
  });

  it('still honours a server `true` on the conversion view — it is the flag, not a floor', () => {
    /**
     * The other half of failing closed, and the half that stops it becoming a
     * client-side threshold. A cell the SERVER cleared is quotable even on counts
     * this console would not have cleared itself: the threshold is core's to tune,
     * and `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` is mirrored so the console can say
     * the number rather than apply it.
     */
    const cell = hourCell({
      day: 0,
      hour: 20,
      attempts: 20,
      connected: 1,
      successes: 1,
      success_rate_reportable: true,
    });
    const conversion = bestHoursMatrix(bestHoursPage({ rows: [cell] }), 'conversion_rate', weekCoverage());
    expect(cellAt(conversion, 0, 20).state).toBe('measured');
    expect(conversion.withheld).toBe(0);
  });

  it('says "no connect to convert" rather than 0% for a cell that reached nobody', () => {
    /**
     * Reachable and ordinary: an hour that dialled thirty times and reached nobody.
     * `0%` there reads as an hour with thirty conversations and no bookings, which is
     * a different and much worse finding.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({ rows: [unconnectedHourCell()] }),
      'conversion_rate',
      weekCoverage(),
    );
    const cell = cellAt(matrix, 4, 3);
    expect(cell.state).toBe('unmeasured');
    expect(cell.value).toBeNull();
    expect(cell.text).toBe('30');
    expect(cell.note).toContain('no connect to convert');
    // An unmeasured cell is off the ramp too, so it cannot set the domain either.
    expect(matrix.domain).toBeNull();
  });

  it('is a pure re-derivation: the same page yields all three views', () => {
    /**
     * The util-level half of "a view switch re-renders, never re-reads". Every metric
     * is already on every cell, so three matrices come out of one page — and the
     * component test pins that no request is fired when the control moves.
     */
    const page = bestHoursPage({
      rows: [hourCell({ day: 1, hour: 10, attempts: 300, connected: 100, successes: 25 })],
    });
    const coverage = weekCoverage();
    expect(cellAt(bestHoursMatrix(page, 'connect_rate', coverage), 1, 10).text).toBe('33.3%');
    expect(cellAt(bestHoursMatrix(page, 'volume', coverage), 1, 10).text).toBe('300');
    expect(cellAt(bestHoursMatrix(page, 'conversion_rate', coverage), 1, 10).text).toBe('25%');
  });
});

describe('agencyBestHours — the ramp’s geometry', () => {
  it('puts the domain’s ends at the ends of the ramp', () => {
    const domain = { min: 10, max: 50 };
    expect(bestHoursStep(10, domain)).toBe(0);
    expect(bestHoursStep(50, domain)).toBe(BEST_HOURS_STEPS - 1);
    expect(bestHoursStep(30, domain)).toBe(2);
  });

  it('clamps a value outside the domain rather than running off the ramp', () => {
    const domain = { min: 10, max: 50 };
    expect(bestHoursStep(-5, domain)).toBe(0);
    expect(bestHoursStep(500, domain)).toBe(BEST_HOURS_STEPS - 1);
  });

  it('paints a single-valued domain at the top step, and says the one value', () => {
    /**
     * Spreading one value across five steps is a gradient with no information in it.
     * The readout then states the value rather than a range, so the legend cannot say
     * "lightest 30% → darkest 30%".
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({
        rows: [
          hourCell({ day: 1, hour: 10, attempts: 300, connected: 100 }),
          hourCell({ day: 2, hour: 10, attempts: 600, connected: 200 }),
        ],
      }),
      'connect_rate',
      weekCoverage(),
    );
    expect(matrix.domain?.min).toBeCloseTo(matrix.domain?.max ?? -1, 5);
    expect(bestHoursStep(matrix.domain?.min ?? 0, matrix.domain)).toBe(BEST_HOURS_STEPS - 1);
    expect(bestHoursScaleReadout(matrix)).toContain('Every coloured cell is');
  });

  it('says nothing is coloured when no cell cleared its threshold', () => {
    const matrix = bestHoursMatrix(
      bestHoursPage({ rows: [thinHourCell()] }),
      'connect_rate',
      weekCoverage(),
    );
    expect(matrix.domain).toBeNull();
    expect(bestHoursStep(50, null)).toBe(0);
    expect(bestHoursScaleReadout(matrix)).toContain('Nothing is coloured');
  });
});

describe('agencyBestHours — the population readout', () => {
  it('counts the cells that had a dial, against all 168', () => {
    /**
     * `rows.length` would be the same number here, and the sentence is deliberately
     * about the CELLS: a reader who can see that the map is 168 cells can also see
     * that a map with four coloured squares is a window problem rather than a campaign
     * finding.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({
        rows: [hourCell({ day: 1, hour: 10, attempts: 300 }), thinHourCell()],
      }),
      'connect_rate',
      weekCoverage(),
    );
    expect(bestHoursCountReadout(matrix)).toBe('2 weekday-hour cells had a dial, of 168');
  });

  it('is singular for one cell', () => {
    const matrix = bestHoursMatrix(bestHoursPage(), 'connect_rate', weekCoverage());
    expect(bestHoursCountReadout(matrix)).toBe('1 weekday-hour cell had a dial, of 168');
  });
});

describe('agencyBestHours — shapes the wire should not send', () => {
  it('drops a row whose key is outside the matrix rather than inventing a column', () => {
    /**
     * A 25th hour or an eighth weekday is a contract violation rather than a cell, and
     * dropping it is the only option that neither throws during a render nor invents a
     * column the axis has no head for.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({
        rows: [
          hourCell({ day: 1, hour: 10, attempts: 300 }),
          hourCell({ day: 7, hour: 10, attempts: 300 }),
          hourCell({ day: 1, hour: 24, attempts: 300 }),
        ],
      }),
      'connect_rate',
      weekCoverage(),
    );
    expect(matrix.rows).toHaveLength(BEST_HOURS_DAYS);
    for (const row of matrix.rows) expect(row.cells).toHaveLength(BEST_HOURS_HOURS);
    expect(matrix.dialled).toBe(1);
  });

  it('keeps the FIRST of two rows for one cell rather than summing them', () => {
    /**
     * The read is grouped, so two rows for one cell cannot happen — and summing them
     * would invent a total the server never served, on a payload that says it is
     * already aggregated.
     */
    const matrix = bestHoursMatrix(
      bestHoursPage({
        rows: [
          hourCell({ day: 1, hour: 10, attempts: 300 }),
          hourCell({ day: 1, hour: 10, attempts: 900 }),
        ],
      }),
      'volume',
      weekCoverage(),
    );
    expect(cellAt(matrix, 1, 10).value).toBe(300);
    expect(matrix.dialled).toBe(1);
  });
});
