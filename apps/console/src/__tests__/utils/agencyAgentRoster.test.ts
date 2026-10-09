import { describe, it, expect } from 'vitest';
import {
  ROSTER_COLUMNS,
  ROSTER_LIMIT,
  SORT_LABELS,
  agentInitials,
  ahtBandReadout,
  ariaSort,
  bandReadout,
  benchmarkUsable,
  cohortComparable,
  connectBullet,
  connectRateCell,
  conversionCell,
  defaultRosterCampaign,
  handleTimeCell,
  inactiveNote,
  initialOrder,
  mixedCohortNote,
  ratedBasisNote,
  rosterAttentionRows,
  rosterConnectAxis,
  rosterCountReadout,
  rosterFlag,
  rosterSubline,
  successRateReportable,
  teamUtilisation,
  truncationNote,
  utilisationBasis,
  utilisationCell,
  utilisationTeamNote,
  withheldRateCell,
  withheldRateTitle,
} from '../../utils/agencyAgentRoster';
import { hollowRow, rosterBenchmark, rosterPage, rosterRow, thinRow } from '../helpers/roster';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyRosterAgentRowWithName,
  type AgencyRosterBenchmark,
} from '../../types/agency-stats';

/**
 * The roster's derivations, as fixtures rather than as pixels.
 *
 * Same reasoning as `agencyAgentPerformance.test.ts`: every sentence these produce
 * is a claim about a named person's week, and a derivation is a place to be
 * confidently wrong. The cases that matter most are the ones where a wrong answer
 * would still LOOK like a number.
 */

describe('the three absences', () => {
  it('withholds a served rate the server flagged as unreportable', () => {
    // The rate IS on the payload. The flag is the server saying "do not present
    // this as a rate", and honouring it in words is the whole point.
    expect(connectRateCell(thinRow())).toEqual({
      kind: 'withheld',
      text: 'Not enough calls',
      note: '11 dials — too few to rate',
      // The denominator that fell short, as a field as well as in the note, so the
      // three tables' tooltips can name it instead of all three saying "calls".
      unit: 'dials',
    });
  });

  it('says nothing bespoke about a null connect rate, because that row cannot exist', () => {
    /**
     * `connect_rate_pct` is never null on a served row: core groups over attempts
     * already filtered on `dialed_at IS NOT NULL`, so `attempts >= 1` and the
     * divisor is never zero. This used to render "No dials in this window" and a
     * test used to construct `attempts: 0` to prove it — a passing assertion over a
     * payload the server cannot send, which is the MAG-106 pattern the phase-01
     * contract names.
     *
     * What is left is inert: it renders rather than throwing if the shape ever
     * changes, and it makes no claim about a state nobody can explain. The three
     * REACHABLE nulls keep their sentences — see the cases below.
     */
    const cell = connectRateCell(rosterRow({ connect_rate_pct: null }));
    expect(cell.kind).toBe('unmeasured');
    expect(cell.text).toBe('—');
    expect(cell).toMatchObject({ note: 'Not measured' });
    expect(cell.kind === 'unmeasured' && cell.note).not.toContain('dial');
  });

  it('keeps a phrase for each null that IS reachable', () => {
    /**
     * `success_rate_pct` is `ratePct(successes, connected)` and `aht_seconds` is
     * `ratio(handled, connected)`, so both are null on a row that dialled and
     * reached nobody. `occupancy_pct` is null on a zero shift, on a degraded
     * occupancy read, and when the numerator exceeds the denominator (best-effort
     * transition writes). All three are ordinary answers a supervisor needs read
     * back to them, so all three keep their sentence.
     */
    const noConnects = rosterRow({ connected: 0, success_rate_pct: null, aht_seconds: null });
    expect(conversionCell(noConnects)).toMatchObject({ note: 'No connect to convert yet' });
    expect(handleTimeCell(noConnects)).toMatchObject({ note: 'No call has finished' });
    expect(utilisationCell(rosterRow({ occupancy_pct: null }))).toMatchObject({
      note: 'No shift recorded',
    });
  });

  it('never produces the string 0% for an absent figure', () => {
    /**
     * The single rule this module exists to enforce. Asserted over every cell
     * builder at once, because the failure mode is one of them regressing quietly
     * while the others stay right.
     */
    const empty = rosterRow({
      // A row that dialled and reached nobody — `attempts` stays >= 1 because core
      // cannot produce a row without one.
      attempts: 40,
      connected: 0,
      successes: 0,
      connect_rate_pct: 0,
      success_rate_pct: null,
      aht_seconds: null,
      occupancy_pct: null,
      rates_reportable: true,
    });
    for (const cell of [conversionCell(empty), handleTimeCell(empty), utilisationCell(empty)]) {
      expect(cell.text).not.toContain('0');
      expect(cell.kind).not.toBe('measured');
    }
    // And the one real 0 in that row still reads as one: nobody answered forty
    // dials, which is a measurement rather than an absence.
    expect(connectRateCell(empty)).toEqual({ kind: 'measured', text: '0%', value: 0 });
  });

  it('renders a real 0 as a measurement', () => {
    expect(conversionCell(rosterRow({ successes: 0, success_rate_pct: 0 }))).toEqual({
      kind: 'measured',
      text: '0%',
      value: 0,
    });
  });

  it('names the right denominator for each withheld rate', () => {
    // Rates and their denominators travel together. Connect rate is over DIALS,
    // conversion is over CONVERSATIONS, and swapping them is how a supervisor
    // concludes the table disagrees with itself.
    const row = thinRow({ attempts: 11, connected: 9 });
    expect(connectRateCell(row)).toMatchObject({ note: '11 dials — too few to rate' });
    expect(conversionCell(row)).toMatchObject({ note: '9 connects — too few to rate' });
  });

  it('does NOT withhold handle time or utilisation on a thin row', () => {
    /**
     * The flag is about RATES. A mean duration over eleven finished calls is noisy
     * but genuinely how long those eleven took, and utilisation's denominator is
     * time on shift rather than dials — withholding it would hide the one number
     * that EXPLAINS a thin dial count.
     */
    const row = thinRow({ aht_seconds: 90, occupancy_pct: 12.5 });
    expect(handleTimeCell(row)).toMatchObject({ kind: 'measured', text: '1:30' });
    expect(utilisationCell(row)).toMatchObject({ kind: 'measured', text: '12.5%' });
  });
});

describe('a rate is gated on the denominator it divides by', () => {
  it('SHOWS the connect rate and WITHHOLDS the conversion rate on 400 dials, 3 connects', () => {
    /**
     * ⚠️ The defect this pass exists to fix. `rates_reportable` counts DIALS and the
     * conversion rate divides by CONNECTS, so the flag did not withhold the thing it
     * was added to withhold: this row clears the dial threshold four hundred times
     * over and its conversion rate is one booking out of three conversations.
     *
     * Both directions matter. Withholding the connect rate here would hide a
     * quotable figure — 0.8% of four hundred dials is exactly the finding a
     * supervisor needs — and quoting `33.3%` beside a named person is the
     * flattering-rate-on-no-volume reading the house rule exists to suppress.
     *
     * It is also precisely the row `benchmark.success_rate` and `benchmark.aht` pool
     * over excluding, which is why one predicate serves the cell, the chip and the
     * two bands: see the `rosterFlag` case that refuses to compare it.
     */
    const row = hollowRow();

    expect(connectRateCell(row)).toEqual({ kind: 'measured', text: '0.8%', value: 0.8 });

    const conversion = conversionCell(row);
    expect(conversion.kind).toBe('withheld');
    expect(conversion.text).toBe('Not enough calls');
    if (conversion.kind !== 'measured') {
      expect(conversion.note).toBe('3 connects — too few to rate');
    }
    // AHT stays: it is a duration, not a rate, and it is the figure that explains
    // the row.
    expect(handleTimeCell(row)).toMatchObject({ kind: 'measured', text: '1:36' });
  });

  it('honours the CONNECTS boundary in both directions, as the server drew it', () => {
    /**
     * Exactly on the threshold is quotable; one connect below is not. Both rows carry
     * the flags the server would compute, passed by hand rather than derived by the
     * fixture, so the assertion is about the console's use of the answer.
     */
    const onThreshold = rosterRow({
      connected: AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      rates_reportable: true,
      success_rate_reportable: true,
    });
    const below = rosterRow({
      connected: AGENCY_ROSTER_MIN_RATE_DENOMINATOR - 1,
      rates_reportable: true,
      success_rate_reportable: false,
    });

    expect(conversionCell(onThreshold).kind).toBe('measured');
    expect(conversionCell(below)).toMatchObject({
      kind: 'withheld',
      note: '19 connects — too few to rate',
    });
    // The connect rate's denominator did not move, so neither does its cell.
    expect(connectRateCell(below).kind).toBe('measured');
  });

  it('says "1 connect" rather than "1 connects"', () => {
    // Twenty dials and ONE connect is the row this flag exists for, so the singular
    // is load-bearing: "1 connects" reads as a rendering bug in the sentence
    // explaining a withheld number.
    expect(
      conversionCell(rosterRow({ connected: 1, successes: 1, success_rate_pct: 100 })),
    ).toMatchObject({ kind: 'withheld', note: '1 connect — too few to rate' });
  });

  it('falls back to rates_reportable when the new flag is absent — never wider', () => {
    /**
     * Merge order is core → master → cusui, so this console can meet a service that
     * predates the field, and the honest fallback is the behaviour that shipped
     * before it. `true` would REVEAL rates the console withholds today; re-deriving
     * `connected >= 20` here would make this client compute a threshold the mirrored
     * constant's own doc comment forbids it to compute.
     */
    const fat = rosterRow();
    delete (fat as Partial<AgencyRosterAgentRowWithName>).success_rate_reportable;
    expect(successRateReportable(fat)).toBe(true);
    expect(conversionCell(fat).kind).toBe('measured');

    const thin = thinRow();
    delete (thin as Partial<AgencyRosterAgentRowWithName>).success_rate_reportable;
    expect(successRateReportable(thin)).toBe(false);
    expect(conversionCell(thin).kind).toBe('withheld');

    // The hollow row loses the protection, which IS today's behaviour — and is the
    // reason the field had to be added rather than derived here.
    const hollow = hollowRow();
    delete (hollow as Partial<AgencyRosterAgentRowWithName>).success_rate_reportable;
    expect(successRateReportable(hollow)).toBe(true);
  });

  it('gates the CHIP on the same predicate as the cell', () => {
    /**
     * One predicate, three consumers — the cell, the chip, and the two bands the
     * chip compares against. A row the server says is too thin to quote a conversion
     * rate for is a row no conversion-rate comparison may be drawn for either, and
     * the chip that would otherwise appear is the identical defect one level up:
     * flagging somebody against a cohort they were excluded from.
     */
    const row = hollowRow({ success_rate_pct: 33.3 });
    expect(rosterFlag(row, rosterBenchmark(), true)).toBeNull();
    // And the server's `false` is honoured even where the mirrored constant would
    // have admitted the row: the threshold is core's to tune.
    const refused = rosterRow({ success_rate_pct: 4, success_rate_reportable: false });
    expect(refused.connected).toBeGreaterThanOrEqual(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);
    expect(rosterFlag(refused, rosterBenchmark(), true)).toBeNull();
  });

  it('honours a server `true` even under 20 connects — the house rule, in the chip', () => {
    /**
     * ⚠️ The case the chip did not have, and the one that proves the fix.
     *
     * `rosterFlag` gated on `successRateReportable(row)` and then ran its OWN
     * `row.connected < AGENCY_ROSTER_MIN_RATE_DENOMINATOR` unconditionally. So on a
     * server that sends the flag — every server that matters — a row core had
     * ADMITTED to the success-rate pool was silently dropped here by a second
     * threshold this client computed for itself.
     *
     * Three things were wrong with that, and only the first is cosmetic:
     *
     *  1. The constant's own doc comment forbids computing with it. It is mirrored so
     *     the console can SAY twenty, not so the console can apply twenty.
     *  2. It disagrees with the CELL in the same row, which gates on the flag alone.
     *     A row whose conversion rate is printed as a quotable figure and whose chip
     *     is suppressed as unquotable is one table saying both things at once.
     *  3. It disagrees with the SERVER the moment core tunes the threshold — and the
     *     percentiles the chip compares against would move with core while the chip's
     *     own admission test stayed at twenty, which is exactly the "flagged against a
     *     cohort they were excluded from" defect in reverse.
     *
     * 12 connects with `success_rate_reportable: true` is not a payload core emits
     * today; it is the payload core emits the day the floor is tuned, and the client's
     * job is to take the server's word for it. `success_rate_pct: 4` is below the
     * fixture band's `p25` of 14.2, so a chip is genuinely due.
     */
    const admitted = rosterRow({
      connected: 12,
      success_rate_pct: 4,
      rates_reportable: true,
      success_rate_reportable: true,
    });
    expect(admitted.connected).toBeLessThan(AGENCY_ROSTER_MIN_RATE_DENOMINATOR);

    expect(rosterFlag(admitted, rosterBenchmark(), true)).toMatchObject({
      kind: 'below_band',
      label: 'Conversion rate below the band',
    });
    // The cell agrees, which is the property that was broken: one predicate, one
    // answer, in the two places the same row is described.
    expect(conversionCell(admitted).kind).toBe('measured');
    // And it reaches the attention filter, so the filter and the chip agree too.
    expect(rosterAttentionRows([admitted], rosterBenchmark(), true)).toHaveLength(1);
  });

  it('still applies the connects floor when the server did NOT state it', () => {
    /**
     * The other side of the same edit: the comparison survives as the fallback for a
     * service that predates the field, and only there.
     *
     * `successRateReportable`'s own fallback is `rates_reportable`, which counts
     * DIALS — so on a legacy payload it would admit this row, and the band it would
     * be compared against has a second floor of its own. With no flag to read there
     * is nothing else to derive that floor from, so the mirrored constant is the
     * least-bad answer available rather than a duplicate of a server's.
     */
    const legacy = rosterRow({ connected: 12, success_rate_pct: 4, rates_reportable: true });
    delete (legacy as Partial<AgencyRosterAgentRowWithName>).success_rate_reportable;
    expect('success_rate_reportable' in legacy).toBe(false);

    expect(rosterFlag(legacy, rosterBenchmark(), true)).toBeNull();
    // Twenty connects on the same legacy shape IS compared: the fallback is a floor,
    // not a blanket refusal, so the assertion above is discriminating.
    const legacyFat = rosterRow({
      connected: AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      success_rate_pct: 4,
      rates_reportable: true,
    });
    delete (legacyFat as Partial<AgencyRosterAgentRowWithName>).success_rate_reportable;
    expect(rosterFlag(legacyFat, rosterBenchmark(), true)).toMatchObject({ kind: 'below_band' });
  });

  it('leaves `thin` outranking everything, whatever the second flag says', () => {
    // `rates_reportable: false` returns before either predicate is consulted, so a
    // row that is thin on DIALS is never described as a performance finding — the
    // ordering the chip's docstring calls out, re-pinned here because the edit above
    // touched the lines directly beneath it.
    const thin = thinRow({ success_rate_pct: 4, success_rate_reportable: true });
    expect(rosterFlag(thin, rosterBenchmark(), true)).toMatchObject({ kind: 'thin' });
  });
});

describe('the withheld cell’s tooltip', () => {
  it('names the rate’s OWN denominator, not "calls"', () => {
    /**
     * ⚠️ `RosterTable`, `ContributionTable` and `CompareTray` each hand-wrote
     * "Fewer than 20 calls, so this rate is not comparable." into the `title` of a
     * withheld cell. Three copies of one sentence, and the sentence was wrong in the
     * case this phase exists for: on 41 dials and 11 connects the CONVERSION rate is
     * withheld for want of connects, and "calls" points the reader at forty-one dials
     * — a number that is fine — and invites the conclusion that the console is wrong.
     *
     * The denominator now travels on the cell, so the components cannot get it wrong:
     * a renderer does not know which metric it is showing, and the cell does.
     */
    expect(withheldRateTitle(withheldRateCell(41, 'dials'))).toBe(
      `Fewer than ${AGENCY_ROSTER_MIN_RATE_DENOMINATOR} dials, so this rate is not comparable.`,
    );
    expect(withheldRateTitle(withheldRateCell(11, 'connects'))).toBe(
      `Fewer than ${AGENCY_ROSTER_MIN_RATE_DENOMINATOR} connects, so this rate is not comparable.`,
    );
  });

  it('is derived from the CELL, so the two rate cells cannot be described alike', () => {
    // The hollow row is the whole point: one row, two cells, two different reasons,
    // and the connect rate is not withheld at all.
    const row = hollowRow();
    const conversion = conversionCell(row);
    expect(connectRateCell(row).kind).toBe('measured');
    if (conversion.kind !== 'withheld') throw new Error('expected a withheld conversion rate');
    expect(withheldRateTitle(conversion)).toContain('connects');
    expect(withheldRateTitle(conversion)).not.toContain('calls');
    expect(withheldRateTitle(conversion)).not.toContain('dials');

    // And a genuinely dial-thin row says dials, so this is not just never saying
    // "dials" any more.
    const dialThin = connectRateCell(thinRow());
    if (dialThin.kind !== 'withheld') throw new Error('expected a withheld connect rate');
    expect(withheldRateTitle(dialThin)).toContain('dials');
  });

  it('does not repeat the count, which is already the cell’s own subline', () => {
    const cell = withheldRateCell(11, 'connects');
    expect(cell.note).toBe('11 connects — too few to rate');
    expect(withheldRateTitle(cell)).not.toContain('11');
  });
});

describe('the bullet', () => {
  it('shares one axis across the column', () => {
    /**
     * A per-row axis would draw two different rates as identical bars — worse than
     * no chart, and the mistake a naive `value / max(row)` makes silently. The axis
     * is taken over every reportable rate AND the band's p75, because the band can
     * sit above every returned row when `limit` truncated on a different sort.
     */
    const axis = rosterConnectAxis(
      [rosterRow({ connect_rate_pct: 20 }), rosterRow({ connect_rate_pct: 40 })],
      rosterBenchmark(),
    );
    const low = connectBullet(rosterRow({ connect_rate_pct: 20 }), rosterBenchmark(), axis)!;
    const high = connectBullet(rosterRow({ connect_rate_pct: 40 }), rosterBenchmark(), axis)!;
    expect(high.value).toBeGreaterThan(low.value);
    expect(high.value / low.value).toBeCloseTo(2, 5);
  });

  it('lets the band stretch the axis so it is never drawn off the end', () => {
    const axis = rosterConnectAxis([rosterRow({ connect_rate_pct: 5 })], rosterBenchmark());
    expect(axis).toBeGreaterThanOrEqual(41.2);
  });

  it('ignores a withheld rate when sizing the axis', () => {
    // A withheld rate is never drawn, so letting one stretch the axis would rescale
    // the column for a number the reader is never shown.
    const withThin = rosterConnectAxis(
      [rosterRow({ connect_rate_pct: 30 }), thinRow({ connect_rate_pct: 100 })],
      rosterBenchmark(),
    );
    const withoutThin = rosterConnectAxis([rosterRow({ connect_rate_pct: 30 })], rosterBenchmark());
    expect(withThin).toBe(withoutThin);
  });

  it('caps the axis at 100 and floors it at 10', () => {
    expect(
      rosterConnectAxis(
        [rosterRow({ connect_rate_pct: 99 })],
        rosterBenchmark({ connect_rate: { p25: 90, median: 95, p75: 99 } }),
      ),
    ).toBe(100);
    expect(
      rosterConnectAxis([], rosterBenchmark({ connect_rate: { p25: null, median: null, p75: null } })),
    ).toBe(10);
  });

  it('draws nothing for an unmeasured or a withheld rate', () => {
    expect(connectBullet(thinRow(), rosterBenchmark(), 100)).toBeNull();
    expect(
      connectBullet(rosterRow({ connect_rate_pct: null }), rosterBenchmark(), 100),
    ).toBeNull();
  });

  it('clamps a mark outside the axis to the edge rather than past it', () => {
    const bullet = connectBullet(rosterRow({ connect_rate_pct: 90 }), rosterBenchmark(), 40)!;
    expect(bullet.value).toBe(100);
  });

  it('omits the band when the cohort has no quartiles', () => {
    const bullet = connectBullet(
      rosterRow(),
      rosterBenchmark({ connect_rate: { p25: null, median: 30, p75: null } }),
      100,
    )!;
    expect(bullet.band).toBeNull();
    expect(bullet.median).toBe(30);
  });
});

describe('the flag chip', () => {
  it('ranks "too few to rate" above "below the band"', () => {
    /**
     * A rate below the bottom quarter built from eleven calls is not a performance
     * finding, and a chip saying so would start exactly the conversation
     * `rates_reportable` exists to prevent. A reviewer singled this precedence out;
     * it survives the change of metric unaltered.
     */
    expect(rosterFlag(thinRow({ success_rate_pct: 2 }), rosterBenchmark(), true)?.kind).toBe('thin');
  });

  it('keys on the CONVERSION rate, not the connect rate', () => {
    /**
     * Connect rate is the metric an agent controls least — it is mostly list
     * quality and dial timing — so a 38%-connect / 4%-conversion agent used to
     * collect a reassuring green chip while the number the business runs on went
     * unremarked. And connect rate is the very metric that is not comparable across
     * campaigns, which is what `mixedCohortNote` is about.
     */
    const bench = rosterBenchmark();
    // Top-quarter CONNECT rate, bottom-quarter conversion rate. Under the old rule
    // this was "Top quarter"; it is now the finding it should always have been.
    const row = rosterRow({ connect_rate_pct: 60, success_rate_pct: 4 });
    expect(rosterFlag(row, bench, true)?.kind).toBe('below_band');
    // And the mirror: a poor connect rate with a strong conversion rate is not a
    // problem the roster should be pointing at.
    expect(rosterFlag(rosterRow({ connect_rate_pct: 8, success_rate_pct: 30 }), bench, true)?.kind).toBe(
      'above_band',
    );
  });

  it('names the metric IN the label, not only in the hover text', () => {
    // The chip is read, quoted and sometimes screenshotted. "Below the band" says
    // nothing about which band, and the answer lived in a `title` attribute.
    const bench = rosterBenchmark();
    expect(rosterFlag(rosterRow({ success_rate_pct: 4 }), bench, true)?.label).toBe(
      'Conversion rate below the band',
    );
    expect(rosterFlag(rosterRow({ success_rate_pct: 30 }), bench, true)?.label).toBe(
      'Conversion rate in the top quarter',
    );
  });

  it('flags below p25 and above p75, and nothing in between', () => {
    const bench = rosterBenchmark();
    expect(rosterFlag(rosterRow({ success_rate_pct: 10 }), bench, true)?.kind).toBe('below_band');
    expect(rosterFlag(rosterRow({ success_rate_pct: 30 }), bench, true)?.kind).toBe('above_band');
    expect(rosterFlag(rosterRow({ success_rate_pct: 18 }), bench, true)).toBeNull();
  });

  it('treats the band edges as inside it', () => {
    // A row exactly at p25 is not below the bottom quarter; it IS the bottom of the
    // middle half. Strict comparisons are what make the edge cases decidable.
    const bench = rosterBenchmark();
    expect(rosterFlag(rosterRow({ success_rate_pct: 14.2 }), bench, true)).toBeNull();
    expect(rosterFlag(rosterRow({ success_rate_pct: 23.6 }), bench, true)).toBeNull();
  });

  it('refuses to compare a row the success-rate POOL excluded', () => {
    /**
     * `rates_reportable` is `attempts >= 20`. The success-rate percentiles have a
     * second floor: core only admits a row when `connected >= 20` too. So a row with
     * 400 dials and 3 connects is reportable, is absent from the pool the band came
     * from, and comparing its rate against that band flags somebody against a cohort
     * they were excluded from.
     */
    const row = rosterRow({ attempts: 400, connected: 3, successes: 1, success_rate_pct: 33.3 });
    expect(row.rates_reportable).toBe(true);
    expect(rosterFlag(row, rosterBenchmark(), true)).toBeNull();
  });

  it('says nothing when the conversion rate is unmeasured', () => {
    // A row that dialled and reached nobody has no conversion rate to compare, and
    // inventing a finding for it would be the "0% is a bad week" mistake as a chip.
    expect(
      rosterFlag(rosterRow({ connected: 0, success_rate_pct: null }), rosterBenchmark(), true),
    ).toBeNull();
  });

  it('has no "no dials" kind, because core cannot produce a zero-dial row', () => {
    /**
     * `rosterAttemptTotals` is a `COUNT(*) … GROUP BY s.agent_user_id` over rows
     * filtered on `dialed_at IS NOT NULL`, so a group exists only because a dial
     * fell in it. The chip, its copy and the test constructing `attempts: 0` to
     * assert it are all gone: an unreachable branch with a green test over it is
     * false confidence, not defensiveness.
     *
     * The row is still RENDERED — it just gets whatever the ordinary rules say,
     * which for an unreportable one is "too few to rate".
     */
    const impossible = rosterRow({ attempts: 0, connect_rate_pct: null, rates_reportable: false });
    expect(rosterFlag(impossible, rosterBenchmark(), true)?.kind).toBe('thin');
  });

  it('always carries a word, so the chip is never colour-only', () => {
    for (const rate of [2, 10, 30] as const) {
      const flag = rosterFlag(rosterRow({ success_rate_pct: rate }), rosterBenchmark(), true);
      if (flag) expect(flag.label.length).toBeGreaterThan(0);
    }
  });
});

describe('the pooled cohort, and the comparison it cannot support', () => {
  it('suppresses both band chips when campaigns are pooled, and KEEPS thin', () => {
    /**
     * The default read used to pool every campaign in the account, and the median,
     * the band and the chips were all computed against that pool — so "their
     * conversion rate is below the bottom quarter of the team" was printed beside a
     * named person on the strength of a comparison between different dealers' lead
     * lists.
     *
     * `thin` survives, because "fewer than twenty calls" is a statement about volume
     * and is true whatever the rows were pooled from.
     */
    const bench = rosterBenchmark();
    expect(rosterFlag(rosterRow({ success_rate_pct: 4 }), bench, false)).toBeNull();
    expect(rosterFlag(rosterRow({ success_rate_pct: 30 }), bench, false)).toBeNull();
    expect(rosterFlag(thinRow(), bench, false)?.kind).toBe('thin');
  });

  it('reads the cohort’s comparability off the ECHOED campaign_id', () => {
    // The server's echo, not the client's request state: what was actually applied
    // is what the rows were measured against.
    expect(cohortComparable(rosterPage({ campaign_id: null }))).toBe(false);
    expect(cohortComparable(rosterPage({ campaign_id: 'camp-1' }))).toBe(true);
  });

  it('says the median mixes lead lists, and only when it does', () => {
    const note = mixedCohortNote(rosterPage({ campaign_id: null }))!;
    expect(note).toContain('mixes lead lists');
    expect(note).toContain('not a like-for-like comparison');
    expect(mixedCohortNote(rosterPage({ campaign_id: 'camp-1' }))).toBeNull();
  });

  it('counts only the rows that carry a chip, under the same rule', () => {
    // The filter's own count. Pooled campaigns leave only the thin rows flaggable,
    // which is exactly what the filter should then offer.
    const rows = [rosterRow({ success_rate_pct: 4 }), thinRow(), rosterRow({ agent_user_id: 'ok', success_rate_pct: 18 })];
    expect(rosterAttentionRows(rows, rosterBenchmark(), true).length).toBe(2);
    expect(rosterAttentionRows(rows, rosterBenchmark(), false).length).toBe(1);
  });
});

describe('the roster’s default scope', () => {
  /**
   * `AgencyCampaign` carries `id`, `name` and `status` and **no timestamps**, so
   * "most recently active" is resolved from status class first and the list's own
   * order (core serves `ORDER BY created_at DESC`) only as a tie-break.
   */
  it('prefers a campaign that is dialing right now', () => {
    expect(
      defaultRosterCampaign([
        { id: 'draft', status: 'draft' },
        { id: 'done', status: 'completed' },
        { id: 'live', status: 'running' },
      ]),
    ).toBe('live');
  });

  it('falls back through paused, then finished, and puts draft LAST', () => {
    expect(
      defaultRosterCampaign([
        { id: 'draft', status: 'draft' },
        { id: 'done', status: 'stopped' },
        { id: 'held', status: 'paused' },
      ]),
    ).toBe('held');
    expect(
      defaultRosterCampaign([{ id: 'draft', status: 'draft' }, { id: 'done', status: 'completed' }]),
    ).toBe('done');
    // A draft has never dialled, so its roster is empty by construction — it is
    // chosen only when there is nothing else at all.
    expect(defaultRosterCampaign([{ id: 'draft', status: 'draft' }])).toBe('draft');
  });

  it('breaks a tie on the list’s own order, which is newest first', () => {
    expect(
      defaultRosterCampaign([
        { id: 'newer', status: 'running' },
        { id: 'older', status: 'running' },
      ]),
    ).toBe('newer');
  });

  it('treats an unrecognised status as having dialled, not as a draft', () => {
    // The instinct `AgencyCampaignStatusBadge` records: master forwards whatever
    // core says, so a status this mirror has not learned yet must not be demoted
    // below the one class guaranteed to have no roster.
    expect(
      defaultRosterCampaign([{ id: 'draft', status: 'draft' }, { id: 'new', status: 'winding_down' }]),
    ).toBe('new');
  });

  it('returns null for an empty list rather than inventing a scope', () => {
    expect(defaultRosterCampaign([])).toBeNull();
  });
});

describe('the cohort readouts', () => {
  it('says the median and the band, in plain English', () => {
    /**
     * "Middle half", not "p25–p75". The sibling module states the house rule in one
     * line — *"'MTD' and 'WTD' are finance words, not agency ones"* — and then the
     * most prominent legend on this surface printed quartile notation. The reader is
     * a floor supervisor; the band is the middle half of their team.
     */
    const readout = bandReadout(rosterBenchmark().connect_rate);
    expect(readout).toBe('median 34.1% · middle half 28.4%–41.2%');
    expect(readout).not.toContain('p25');
    expect(readout).not.toContain('p75');
  });

  it('labels the team’s UTILISATION as the typical agent, not as a pooled rate', () => {
    /**
     * The benchmark carries the cohort's talk and wrap-up but no cohort
     * `shift_seconds`, so the floor's own utilisation is not derivable — and
     * deriving it from the ROWS would make the team row move when the reader
     * revealed former members, which the benchmark's contract forbids. So the figure
     * beside this note is the median, and the note says which.
     */
    expect(utilisationTeamNote(rosterBenchmark().occupancy_pct)).toBe(
      'typical agent · middle half 31%–46.2%',
    );
    expect(utilisationTeamNote({ p25: null, median: 38.5, p75: null })).toBe('typical agent');
    expect(utilisationTeamNote({ p25: null, median: null, p75: null })).toBe(
      'No median yet — too few rated agents',
    );
  });

  it('reports one block’s absence WITHOUT naming a threshold it cannot vouch for', () => {
    /**
     * The three pools are gated differently. `rates_reportable` is
     * `attempts >= 20` and a row without it enters none of them; the SUCCESS-rate
     * pool additionally wants `connected >= 20`; the UTILISATION pool is gated on
     * `rates_reportable` plus non-null, with no minimum-shift floor at all — a
     * threshold counted in calls cannot gate a rate whose denominator is seconds.
     *
     * So "no agent cleared 20 calls" is only reliably true of the connect-rate
     * block, and this readout must not say it for the other two.
     */
    const readout = bandReadout({ p25: null, median: null, p75: null });
    expect(readout).toBe('No median yet — too few rated agents');
    expect(readout).not.toContain('20');
    expect(readout).not.toContain('shift');
  });

  it('takes NO basis count, so it cannot attach one to the wrong block', () => {
    // The signature is the guardrail: a second argument is how `agents_rated` ended
    // up describing all three medians when it exactly describes one.
    expect(bandReadout).toHaveLength(1);
  });

  it('renders each percentile block independently', () => {
    /**
     * A row can be `rates_reportable: true`, sit in the connect-rate pool and be
     * absent from the success-rate one (400 dials, 3 connects). So one block being
     * all-null says nothing about the others, and the team row must not be gated on
     * any single one of them.
     */
    const bench = rosterBenchmark({ success_rate: { p25: null, median: null, p75: null } });
    expect(bandReadout(bench.connect_rate)).toContain('median 34.1%');
    expect(bandReadout(bench.success_rate)).toBe('No median yet — too few rated agents');
    expect(utilisationTeamNote(bench.occupancy_pct)).toContain('middle half 31%');
  });

  it('keeps the median when only the quartiles are missing', () => {
    expect(bandReadout({ p25: null, median: 30, p75: null })).toBe('median 30%');
  });

  it('describes agents_rated as the HEADLINE threshold, not as any one basis', () => {
    // It is exactly the connect-rate pool's size and only approximately the others',
    // so the wording claims the dial threshold and nothing more.
    const note = ratedBasisNote(rosterBenchmark());
    expect(note).toBe('6 of 8 with enough calls to rate');
    expect(note).not.toContain('median');
  });

  it('scopes the bullet’s cohort check to the CONNECT-rate band alone', () => {
    /**
     * `agents_rated` is that pool's size, and the bullet is the only thing drawn
     * against a band — so gating on it here is right, and gating the whole team row
     * on it would hide a perfectly good utilisation median because a different pool
     * was thin.
     *
     * One rated agent IS the median, so a bullet against it says somebody is exactly
     * average with themselves.
     */
    expect(benchmarkUsable(rosterBenchmark({ agents_rated: 1 }))).toBe(false);
    expect(benchmarkUsable(rosterBenchmark({ agents_rated: 2 }))).toBe(true);
    expect(
      benchmarkUsable(rosterBenchmark({ agents_rated: 6, connect_rate: { p25: null, median: null, p75: null } })),
    ).toBe(false);
    // A thin SUCCESS-rate pool does not disqualify the connect-rate bullet.
    expect(
      benchmarkUsable(rosterBenchmark({ success_rate: { p25: null, median: null, p75: null } })),
    ).toBe(true);
  });
});

describe('the honesty affordances', () => {
  it('reads out the POPULATION that dialled, not the rows on screen', () => {
    // `rows.length` would shrink when a former member was dropped or `limit` cut the
    // page, which reads as the floor itself having changed size.
    expect(rosterCountReadout(rosterPage({ rows: [rosterRow()], total_agents: 8 }))).toBe(
      '8 agents dialled · 2,495 dials',
    );
  });

  it('singularises one agent and one dial', () => {
    expect(
      rosterCountReadout(
        rosterPage({ rows: [rosterRow()], total_agents: 1, benchmark: rosterBenchmark({ attempts: 1 }) }),
      ),
    ).toBe('1 agent dialled · 1 dial');
  });

  it('never renders a "showing N of M" fraction', () => {
    /**
     * The coordinator's ruling, and the reason is structural: core cuts to `limit`
     * and master then filters the page it was handed, so a page of 1 row can
     * legitimately carry `total_agents: 3` and `inactive_omitted: 1`. "1 of 3" is
     * wrong and "1 of 2" is not derivable, because master never saw the rows core
     * cut. Three separate true statements is the only honest form.
     */
    const note = truncationNote(
      rosterPage({ rows: [rosterRow()], total_agents: 3, inactive_omitted: 1, limit: 100 }),
    )!;
    expect(note).toContain('Showing the top 100');
    expect(note).not.toMatch(/of 3|of 2/);
  });

  it('names the order the truncation applies to', () => {
    expect(
      truncationNote(rosterPage({ rows: [rosterRow()], total_agents: 137, sort: 'aht_seconds' })),
    ).toContain('handle time');
  });

  it('claims no truncation when the missing rows were all departed members', () => {
    // The page fit under the limit; nothing was ranked away. Saying otherwise sends
    // a supervisor looking for rows that do not exist.
    expect(
      truncationNote(rosterPage({ rows: [rosterRow()], total_agents: 2, inactive_omitted: 1 })),
    ).toBeNull();
  });

  it('claims no truncation when the whole floor is on screen', () => {
    expect(truncationNote(rosterPage({ rows: [rosterRow()], total_agents: 1 }))).toBeNull();
  });

  it('says nothing at all when inactive_omitted is ABSENT from the body', () => {
    /**
     * Master has a documented degrade path that serves core's body unfiltered, with
     * no `inactive_omitted` on it. Read straight, `total_agents <= rows.length +
     * undefined` is `1 <= NaN`, which is `false` — so the note fired on every single
     * page and told a supervisor looking at their whole floor that the rest of it
     * was further down an order.
     *
     * The guard stays even though master is being fixed in parallel: a comparison
     * against `undefined` should not be reachable from a field the wire can omit,
     * and the two fixes are independent.
     */
    const degraded = rosterPage({ rows: [rosterRow()], total_agents: 1 });
    delete (degraded as { inactive_omitted?: number }).inactive_omitted;
    expect(truncationNote(degraded)).toBeNull();
    expect(inactiveNote(degraded)).toBeNull();
  });

  it('names the order in the same words as the column it ranks by', () => {
    // "the top 100 by conversions" beside a Conversions column. It used to say
    // conversions beside a column called "Conversion" that was a RATE.
    const note = truncationNote(
      rosterPage({ rows: [rosterRow()], total_agents: 400, sort: 'successes' }),
    )!;
    expect(note).toContain('by conversions');
    expect(SORT_LABELS.successes).toBe('conversions');
    expect(SORT_LABELS.connected).toBe('connects');
  });

  it('names dropped members as FORMER MEMBERS, singular and plural', () => {
    // The reader's question is "where is Priya", not "why are there fewer rows".
    expect(inactiveNote(rosterPage({ inactive_omitted: 1 }))).toContain('1 former member hidden');
    expect(inactiveNote(rosterPage({ inactive_omitted: 2 }))).toContain('2 former members hidden');
    expect(inactiveNote(rosterPage({ inactive_omitted: 0 }))).toBeNull();
  });
});

describe('the agent cell', () => {
  it('takes initials from first and last word', () => {
    expect(agentInitials('Ravi Kumar')).toBe('RK');
    expect(agentInitials('Anita Priya Sharma')).toBe('AS');
  });

  it('never returns a blank, even for the id fallback', () => {
    // The avatar must not be the thing that makes a row look broken. It is
    // decoration and `aria-hidden`, which is why two letters of an id are fine here
    // and would not be as a label.
    expect(agentInitials('Agent 4f21ab90')).toBe('A4');
    expect(agentInitials('Meera')).toBe('ME');
    expect(agentInitials('   ')).toBe('?');
  });

  it('says campaigns and the last dial, singular and plural', () => {
    expect(rosterSubline(rosterRow({ campaigns: 1, last_dialed_at: '2026-08-19T11:04:00.000Z' }))).toBe(
      '1 campaign · last dialled 19 Aug',
    );
    expect(rosterSubline(rosterRow({ campaigns: 3, last_dialed_at: '2026-08-19T11:04:00.000Z' }))).toBe(
      '3 campaigns · last dialled 19 Aug',
    );
  });

  it('drops the last dial rather than claiming a state that cannot happen', () => {
    /**
     * `last_dialed_at` is `MAX(a.dialed_at)` over a group that only exists because a
     * dial fell in it, so it is never null on a served row — and the "No dials in
     * this window" sentence this used to assert was unreachable copy with a passing
     * test over it. What is left says only what it can see.
     */
    expect(rosterSubline(rosterRow({ campaigns: 0, last_dialed_at: null }))).toBe('0 campaigns');
    expect(rosterSubline(rosterRow({ campaigns: 2, last_dialed_at: null }))).toBe('2 campaigns');
  });
});

describe('sort vocabulary', () => {
  it('starts a metric descending and the name ascending', () => {
    expect(initialOrder('attempts')).toBe('desc');
    expect(initialOrder('aht_seconds')).toBe('desc');
    expect(initialOrder('agent_user_id')).toBe('asc');
  });

  it('maps to aria-sort’s own vocabulary, and to none off-column', () => {
    expect(ariaSort('attempts', 'attempts', 'asc')).toBe('ascending');
    expect(ariaSort('attempts', 'attempts', 'desc')).toBe('descending');
    expect(ariaSort('attempts', 'successes', 'desc')).toBe('none');
  });
});

describe('the columns are the sortable set', () => {
  it('offers no order without a column to show it', () => {
    /**
     * The sort menu used to be built from `Object.keys(SORT_LABELS)` — the whole
     * wire enum — so it offered `successes` and `talk_seconds`, neither of which had
     * a column. `successes` was also the DEFAULT, so the table opened ranked by a
     * number that appeared nowhere on it and every header reported
     * `aria-sort="none"`.
     *
     * Both the headers and the menu are now built from this one list, which makes
     * the property structural rather than a matter of two lists agreeing.
     */
    const columns = ROSTER_COLUMNS.map((column) => column.sort);
    expect(columns).toContain('successes');
    expect(columns).toContain('agent_user_id');
    // Dropped from the console rather than left unshowable. The wire still accepts
    // it; nothing here asks for it.
    expect(columns).not.toContain('talk_seconds');
    // Every column has a name in the shared vocabulary, so a header, the truncation
    // sentence and the request parameter cannot drift.
    for (const column of ROSTER_COLUMNS) expect(SORT_LABELS[column.sort]).toBeTruthy();
  });

  it('separates connects from conversions in the column labels', () => {
    // `Conv.` meaning connects beside `Conversion` meaning a rate was roughly a 5x
    // error on the number a dealership pays for.
    const labels = ROSTER_COLUMNS.map((column) => column.label);
    expect(labels).toContain('Connects');
    expect(labels).toContain('Conversions');
    expect(labels).toContain('Conversion rate');
    expect(labels).not.toContain('Conv.');
  });

  it('asks for the contract’s maximum limit', () => {
    // Sending none applied core's default of 100, so a 180-agent agency lost its 80
    // lowest converters — the population being triaged.
    expect(ROSTER_LIMIT).toBe(200);
  });
});

describe('utilisation shows its denominator', () => {
  it('names the handled time and the shift it was divided by, with its units', () => {
    /**
     * `shift_seconds` and `break_seconds` were on every row for a stated reason —
     * "so the other occupancy reading stays derivable" — and rendered nowhere, which
     * left a bare percentage as the only thing on screen for the figure most likely
     * to reach a pay review.
     *
     * ── The units are said out loud, because this is a SENTENCE ──────────────
     * The stopwatch format the numeric cells use (`2:15:00`) is right in a
     * right-aligned tabular column, where every value has the same shape and the
     * reader is comparing lengths. In prose it fails, and it fails worst on exactly
     * this line: pooled over a 200-agent floor it read `4800:00:00 handled of
     * 8000:00:00 on shift`, a stopwatch expressing five-figure hours on the figure
     * most likely to be quoted in a pay review. Cells keep the stopwatch; sentences
     * name the unit.
     */
    expect(
      utilisationBasis(
        rosterRow({ talk_seconds: 7_200, wrapup_seconds: 900, shift_seconds: 21_600, break_seconds: 1_800 }),
      ),
    ).toBe('2h 15m handled of 6h on shift · 30m break');
  });

  it('omits a break nobody took, rather than printing a 0:00 nobody can read', () => {
    // "0:00 break" invites the reader to wonder whether nobody took one or nobody
    // recorded one, which this payload cannot tell.
    expect(utilisationBasis(rosterRow({ break_seconds: 0 }))).not.toContain('break');
  });

  it('has no basis to show when there was no measured shift', () => {
    // The cell then says "No shift recorded", which is everything a basis line could.
    expect(utilisationBasis(rosterRow({ occupancy_pct: null, shift_seconds: 0 }))).toBeNull();
    expect(utilisationBasis(rosterRow({ shift_seconds: 0 }))).toBeNull();
  });
});

describe('the team row’s utilisation is POOLED, and degrades to the median', () => {
  it('divides the cohort’s handled time by the cohort’s shift', () => {
    /**
     * D10's `shift_seconds` is what makes the floor's own utilisation derivable at
     * all. 54,000 + 6,400 handled over 151,000 on shift is 40% — and the fixture's
     * median is 38.5%, so this assertion cannot pass against the stand-in that
     * preceded the field.
     *
     * The basis is the arithmetic, in the same words a ROW's basis uses (one
     * vocabulary), with break NAMED rather than subtracted because the denominator
     * includes it. The note labels the figure as the floor's, so the median beside
     * it reads as the different number it is.
     */
    const readout = teamUtilisation(rosterBenchmark());

    expect(readout.kind).toBe('pooled');
    expect(readout.text).toBe('40%');
    // Units, not colons — the same rule a ROW's basis follows, from the same
    // formatter, so the pooled line and the per-person line cannot come to read
    // differently.
    expect(readout.basis).toBe('16h 46m handled of 41h 56m on shift · 2h break');
    expect(readout.note).toBe('the whole floor · median 38.5% · middle half 31%–46.2%');
  });

  it('is NOT derived from the rows, and cannot be', () => {
    /**
     * The signature is the guarantee: it takes a benchmark and nothing else. `rows`
     * is what `include_inactive` moves and the benchmark deliberately is not, so a
     * row-derived team figure would change when the reader revealed former members
     * — a different number under the same name, which the benchmark's own contract
     * forbids and a component test pins by comparing the whole team row's
     * `textContent` across that toggle.
     */
    expect(teamUtilisation.length).toBe(1);
    // Two pages with identical benchmarks and different rows agree, by construction.
    const benchmark = rosterBenchmark();
    expect(teamUtilisation(benchmark)).toEqual(teamUtilisation({ ...benchmark }));
  });

  it('falls back to the median stand-in when the field has not shipped', () => {
    // Merge order is core → master → cusui, so the field is normally there. A
    // `typeof` guard anyway: the type is a hand-mirrored claim about the wire, and
    // every absence on this surface degrades to the next-best true statement.
    const benchmark = rosterBenchmark();
    delete (benchmark as Partial<AgencyRosterBenchmark>).shift_seconds;

    const readout = teamUtilisation(benchmark);
    expect(readout.kind).toBe('median');
    expect(readout.text).toBe('38.5%');
    expect(readout.basis).toBeNull();
    // Exactly the copy this cell carried before the field existed.
    expect(readout.note).toBe(utilisationTeamNote(rosterBenchmark().occupancy_pct));
  });

  it('says the floor has no recorded shift rather than 0%', () => {
    // A zero denominator is `null`, never `0`: core's agent-state event log shipped
    // after the dialer, so a floor whose sessions predate it has no events rather
    // than zeroed ones — and "0% utilised" is a confident claim that it sat idle.
    const readout = teamUtilisation(
      rosterBenchmark({ shift_seconds: 0, occupancy_pct: { p25: null, median: null, p75: null } }),
    );
    expect(readout.kind).toBe('unmeasured');
    expect(readout.text).toBe('—');
    expect(readout.note).toBe('No shift recorded for the floor');
  });

  it('keeps the pooled figure when the cohort has no median to show', () => {
    // The two are independently reachable: the pooled rate is arithmetic over the
    // whole cohort, the percentiles only over the rows that cleared the threshold.
    const readout = teamUtilisation(
      rosterBenchmark({ occupancy_pct: { p25: null, median: null, p75: null } }),
    );
    expect(readout.text).toBe('40%');
    expect(readout.note).toBe('the whole floor');
  });
});

describe('handle time gets a band, in seconds', () => {
  it('reads like the rate bands but formats durations, with their units', () => {
    /**
     * `median 74%` for a 74-second call is the one mistake this field makes
     * available, so the formatter is the assertion — and the formatter is the PROSE
     * one. `median 22:00` is distinguishable from twenty-two hours only by counting
     * colons, and in a sentence the colons have none of the alignment that makes
     * them legible in a column.
     */
    expect(ahtBandReadout(rosterBenchmark())).toBe(
      'median 1m 14s · middle half 1m 2s–1m 31s',
    );
    // And the CELL keeps the stopwatch: one module, two formats, no drift. See
    // `RosterTable.test.tsx`, which finds `1:14` in the team row beside this band.
    expect(ahtBandReadout(rosterBenchmark())).not.toContain('1:14');
  });

  it('says nothing at all when the block has not shipped', () => {
    /**
     * Silence rather than "no median yet — too few rated agents": that sentence is a
     * claim about the FLOOR, and making it about a field master has not deployed
     * would be a false one.
     */
    const benchmark = rosterBenchmark();
    delete (benchmark as Partial<AgencyRosterBenchmark>).aht;
    expect(ahtBandReadout(benchmark)).toBeNull();
  });

  it('says the honest thing when the block is there and the cohort is thin', () => {
    expect(
      ahtBandReadout(rosterBenchmark({ aht: { p25: null, median: null, p75: null } })),
    ).toBe('No median yet — too few rated agents');
  });

  it('refuses a block whose members are not numbers', () => {
    // A shape this build does not understand is not a thin cohort. Rendering
    // `agentSeconds('74')` would print something; saying nothing is the honest form.
    expect(ahtBandReadout(rosterBenchmark({ aht: { p25: 62, median: '74', p75: 91 } as never })))
      .toBeNull();
  });
});
