import { describe, expect, it } from 'vitest';
import {
  RATE_MIN_ATTEMPTS,
  connectRateReadout,
  connectsBreakdown,
  conversionRateReadout,
  handleTimeReadout,
  handledCallCost,
  ratesWithheld,
  wrapupReadout,
} from '../../utils/agencyCampaignPerformance';
import type { AgencyCampaignStats } from '../../types/agency-campaign';

/**
 * §C.3's derived figures (MAG-151).
 *
 * Most of what follows is one proposition in three forms: **`undefined`,
 * `null` and `0` are three different sentences**, and the whole value of these
 * readouts is that a supervisor can tell which one they are reading. The tests
 * are written as those three cases per figure rather than as happy paths,
 * because the happy path was never the thing at risk.
 */

function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    stall: null,
    other_stalls: [],
    concurrency_limit: 10,
    concurrency_in_use: 2,
    abandonment_ceiling_pct: 5,
    ...over,
  };
}

describe('connectRateReadout', () => {
  it('reads an absent field as a failed load, never as 0%', () => {
    const readout = connectRateReadout(stats());
    expect(readout.value).toBe('—');
    expect(readout.known).toBe(false);
  });

  it('reads core’s null as "no calls placed", not as a 0% rate', () => {
    const readout = connectRateReadout(stats({ connect_rate_pct: null }));
    expect(readout.value).toBe('No data');
    expect(readout.known).toBe(false);
    expect(readout.detail).toMatch(/no calls have been placed/i);
  });

  it('renders a real 0 as 0% — the campaign reached nobody', () => {
    const readout = connectRateReadout(stats({ connect_rate_pct: 0, unclassified_connects: 0 }));
    expect(readout.value).toBe('0%');
    expect(readout.known).toBe(true);
    expect(readout.caveat).toBeNull();
  });

  it('trims false precision off the percentage', () => {
    expect(connectRateReadout(stats({ connect_rate_pct: 66 })).value).toBe('66%');
    expect(connectRateReadout(stats({ connect_rate_pct: 66.04 })).value).toBe('66%');
    expect(connectRateReadout(stats({ connect_rate_pct: 66.449 })).value).toBe('66.4%');
  });

  it('names the calls nobody wrote up, because they are outside the numerator', () => {
    const readout = connectRateReadout(stats({ connect_rate_pct: 40, unclassified_connects: 12 }));
    expect(readout.caveat).toContain('12 connected calls were');
    expect(readout.caveat).toMatch(/don’t count towards this rate/);
  });

  it('uses the singular for exactly one unwritten-up call', () => {
    const readout = connectRateReadout(stats({ connect_rate_pct: 40, unclassified_connects: 1 }));
    expect(readout.caveat).toContain('1 connected call was');
  });

  it('says nothing when every connected call was written up', () => {
    expect(
      connectRateReadout(stats({ connect_rate_pct: 40, unclassified_connects: 0 })).caveat,
    ).toBeNull();
  });

  it('lets the structural caveat outrank the incidental one', () => {
    // Both apply. Blaming agents for "12 calls not written up" when the campaign
    // offers no voicemail code points at the wrong party for the wrong reason.
    const readout = connectRateReadout(
      stats({
        connect_rate_pct: 40,
        unclassified_connects: 12,
        machine_connects_available: false,
      }),
    );
    expect(readout.caveat).toMatch(/no voicemail code/);
    expect(readout.caveat).not.toContain('12');
  });

  it('says the code was WITHDRAWN when there is history behind it', () => {
    // "has no voicemail code" is true of the catalog and misleading about the
    // campaign: it did have one, and the calls marked under it are real.
    const readout = connectRateReadout(
      stats({
        connect_rate_pct: 40,
        unclassified_connects: 12,
        machine_connects: 7,
        machine_connects_available: false,
      }),
    );
    expect(readout.caveat).toMatch(/has been removed/);
    expect(readout.caveat).not.toMatch(/has no voicemail code/);
  });

  it('states the denominator in counts, and only when both counts are there', () => {
    /*
      `human_connects` and `attempts_connected` are DELIBERATELY different here.
      The previous fixture set only `attempts_connected: 2104` against
      `connect_rate_pct: 31.2` — and 2104/6742 is exactly 31.2%, so the fixture
      encoded the wrong numerator and then asserted against its own assumption.
      It could not have failed if the card read the wrong field, which is
      precisely what the card was doing.

      `connect_rate_pct` is `human_connects / attempts_total`: 1509/6742 = 22.4%.
      A card that reads `attempts_connected` here renders "2,104" beside "22.4%"
      — a fraction that does not equal its own percentage — and this now fails.
    */
    const readout = connectRateReadout(
      stats({
        connect_rate_pct: 22.4,
        human_connects: 1509,
        attempts_connected: 2104,
        attempts_total: 6742,
      }),
    );
    expect(readout.denominator).toEqual({
      lead: '1,509',
      rest: 'people answered, of 6,742 dials placed',
    });
    // The wider population must not appear on this card at all.
    expect(readout.denominator?.lead).not.toBe('2,104');
    // Half a denominator is not a denominator: "of 6,742" with no numerator, or
    // a numerator with nothing to be out of, both invite the reader to supply
    // the missing half from the card next door.
    expect(
      connectRateReadout(stats({ connect_rate_pct: 31.2, attempts_total: 6742 })).denominator,
    ).toBeNull();
  });

  it('treats an absent availability flag as measurable, not as a warning', () => {
    // An older core that never sent the flag has not told us voicemail is
    // unrecordable, and inventing the more alarming reading is not caution.
    const readout = connectRateReadout(stats({ connect_rate_pct: 40, unclassified_connects: 0 }));
    expect(readout.caveat).toBeNull();
  });
});

describe('conversionRateReadout', () => {
  /**
   * The first consumer `is_success` has ever had. Every case below is one of the
   * three absences, plus the one thing only this readout can get wrong: naming
   * the denominator.
   */
  it('reads an absent field as a failed load, never as 0%', () => {
    const readout = conversionRateReadout(stats());
    expect(readout.value).toBe('—');
    expect(readout.known).toBe(false);
    expect(readout.value).not.toBe('0%');
  });

  it('reads core’s null as "nothing has connected", not as a 0% conversion', () => {
    /**
     * The defect this pins. A campaign that has dialled a cold list all morning
     * and reached nobody has NOT failed to convert anybody — there was nothing to
     * convert. `0.0%` there is a verdict reported as a measurement, aimed at the
     * agents, and it is the same mistake `abandonment_rate_24h_pct` documents.
     */
    const readout = conversionRateReadout(stats({ success_rate_pct: null }));
    expect(readout.value).toBe('No data');
    expect(readout.known).toBe(false);
    expect(readout.detail).toContain('nothing to convert');
  });

  it('renders a real 0 as 0%, because that one IS a claim about the campaign', () => {
    const readout = conversionRateReadout(
      stats({ success_rate_pct: 0, attempts_success: 0, attempts_connected: 40 }),
    );
    expect(readout.value).toBe('0%');
    expect(readout.known).toBe(true);
  });

  it('names the denominator, because a rate over dials means something else', () => {
    // A supervisor reading two bare percentages side by side will assume they
    // share a denominator. They do not: connect rate is over dials, this is over
    // conversations, and the gap between the two readings is large enough to
    // change what somebody does about it.
    const readout = conversionRateReadout(stats({ success_rate_pct: 22.5 }));
    expect(readout.value).toBe('22.5%');
    expect(readout.detail).toContain('reached a person');
    expect(readout.detail).toContain('not out of every dial');
  });

  it('states the denominator in COUNTS, not only in prose', () => {
    // "9 of 41 connected calls" cannot be misread the way a bare 22% beside
    // another bare percentage can. The numerator leads because it is this rate's
    // own figure; the denominator follows because it is what it was taken over.
    const readout = conversionRateReadout(
      stats({ success_rate_pct: 22.5, attempts_success: 9, attempts_connected: 41 }),
    );
    expect(readout.denominator).toEqual({ lead: '9', rest: 'of 41 connected calls' });
  });

  it('carries the success COUNT even when the connected total is absent', () => {
    // The count is this rate's numerator and is worth stating on its own; what
    // it must never do is appear beside a percentage with no denominator named.
    const readout = conversionRateReadout(
      stats({ success_rate_pct: 22.5, attempts_success: 9 }),
    );
    expect(readout.denominator).toEqual({ lead: '9', rest: 'counted as a success' });
  });

  it('keeps the count on screen even when the rate could not be read', () => {
    // The count and the rate are produced independently; losing the rate is no
    // reason to withhold the number of wins the campaign actually recorded.
    const readout = conversionRateReadout(stats({ attempts_success: 9, attempts_connected: 41 }));
    expect(readout.known).toBe(false);
    expect(readout.denominator).toEqual({ lead: '9', rest: 'of 41 connected calls' });
  });

  it('draws the rate as a share of its own track, in the conversion tone', () => {
    // Two rates, two colours, so a reader glancing across the row cannot mistake
    // one bar's length for the other's.
    expect(conversionRateReadout(stats({ success_rate_pct: 22.5 })).scale)
      .toEqual({ kind: 'fill', percent: 22.5, tone: 'teal' });
    expect(connectRateReadout(stats({ connect_rate_pct: 31.2 })).scale)
      .toEqual({ kind: 'fill', percent: 31.2, tone: 'accent' });
  });

  it('warns that voicemails inflate the denominator when the code is missing', () => {
    /**
     * With no `voicemail` code in the catalog, answering machines are written up
     * as ordinary connected calls — so they sit in this rate's DENOMINATOR and
     * push the number down. Unsaid, a supervisor reads a low conversion rate as an
     * agent problem when it is a configuration one.
     */
    const readout = conversionRateReadout(
      stats({ success_rate_pct: 12, machine_connects: 0, machine_connects_available: false }),
    );
    expect(readout.caveat).toContain('no voicemail code');
    expect(readout.caveat).toContain('lower than it is');
  });

  it('says "removed since" rather than "never measured" for a withdrawn code', () => {
    // The catalog is patchable on a live campaign, so a campaign can have real
    // voicemail history AND a catalog that no longer offers the code. Calling that
    // "never measured" would discard true history.
    const readout = conversionRateReadout(
      stats({ success_rate_pct: 12, machine_connects: 6, machine_connects_available: false }),
    );
    expect(readout.caveat).toContain('has been removed');
  });
});

describe('handleTimeReadout', () => {
  it('separates a failed load from a campaign with nothing to average', () => {
    expect(handleTimeReadout(stats()).value).toBe('—');
    expect(handleTimeReadout(stats({ aht_seconds: null })).value).toBe('No data');
  });

  it('renders §C.1’s 2:14 from core’s seconds', () => {
    const readout = handleTimeReadout(stats({ aht_seconds: 134 }));
    expect(readout.value).toBe('2:14');
    expect(readout.known).toBe(true);
  });

  it('rolls past an hour into h:mm:ss rather than 87 of something', () => {
    expect(handleTimeReadout(stats({ aht_seconds: 5230 })).value).toBe('1:27:10');
  });

  it('renders a real zero as 0:00, not as a dash', () => {
    expect(handleTimeReadout(stats({ aht_seconds: 0 })).value).toBe('0:00');
    expect(handleTimeReadout(stats({ aht_seconds: 0 })).known).toBe(true);
  });

  it('shows the with-voicemail figure beside it, which is the point of the split', () => {
    const readout = handleTimeReadout(
      stats({ aht_seconds: 134, aht_seconds_including_machine: 151 }),
    );
    expect(readout.scale).toEqual({
      kind: 'compare',
      bars: [
        { label: '2:14 excl. vm', percent: (134 / 151) * 100, muted: false },
        { label: '2:31 incl. vm', percent: 100, muted: true },
      ],
    });
  });

  it('never gives handle time a percentage meter', () => {
    /**
     * There is nothing for a duration to be a percentage OF. A bar filled to
     * some share of a five-minute maximum nobody configured is a scale that does
     * not exist, drawn with the same confidence as the two rates beside it — so
     * the only scale this figure gets is the pair against each other.
     */
    const readout = handleTimeReadout(
      stats({ aht_seconds: 134, aht_seconds_including_machine: 151 }),
    );
    expect(readout.scale?.kind).toBe('compare');
    expect(readout.scale?.kind).not.toBe('fill');
    expect(readout.scale?.kind).not.toBe('ceiling');
  });

  it('drops the comparison to a single bar when the two averages are the same number', () => {
    const readout = handleTimeReadout(
      stats({ aht_seconds: 134, aht_seconds_including_machine: 134 }),
    );
    // One bar, and its label loses the "excl. vm" qualifier: with nothing to
    // compare against, the suffix would imply a comparison had been made.
    expect(readout.scale).toEqual({
      kind: 'compare',
      bars: [{ label: '2:14', percent: 100, muted: false }],
    });
  });

  it('does not divide by a zero average when drawing the bars', () => {
    const readout = handleTimeReadout(stats({ aht_seconds: 0 }));
    expect(readout.scale).toEqual({
      kind: 'compare',
      bars: [{ label: '0:00', percent: 0, muted: false }],
    });
  });

  it('keeps the comparison when the code was removed after voicemails were recorded', () => {
    // The delta is real — those 7 calls ARE excluded from `aht_seconds`, on the
    // historical `disposition_code`. Gating the secondary on the availability
    // flag would withhold the one number that says what removing the code cost.
    const readout = handleTimeReadout(
      stats({
        aht_seconds: 134,
        aht_seconds_including_machine: 151,
        machine_connects: 7,
        machine_connects_available: false,
      }),
    );
    expect(readout.scale).toMatchObject({
      kind: 'compare',
      bars: [{ label: '2:14 excl. vm' }, { label: '2:31 incl. vm' }],
    });
    expect(readout.caveat).toMatch(/Calls marked before that are still excluded/);
    // The blanket claim would be false here: the labelled ones are outside it.
    expect(readout.caveat).not.toMatch(/answering machines are inside this average\./);
  });

  it('suppresses the comparison and explains itself when voicemail was never a disposition', () => {
    /*
     * The two averages are EQUAL here, and that is not an arbitrary fixture —
     * it is the only shape this campaign can have. Core excludes calls
     * *labelled* voicemail; with no code in the catalog nothing is so labelled,
     * so both `AVG`s run identical predicates over identical rows.
     *
     * (The earlier version of this test set 134 vs 151 with the flag false and
     * still expected no secondary. That payload cannot occur, and asserting on
     * it hid the case that can: see the withdrawn-code test above.)
     */
    const readout = handleTimeReadout(
      stats({
        aht_seconds: 134,
        aht_seconds_including_machine: 134,
        machine_connects: 0,
        machine_connects_available: false,
      }),
    );
    expect(readout.scale).toEqual({
      kind: 'compare',
      bars: [{ label: '2:14', percent: 100, muted: false }],
    });
    expect(readout.caveat).toMatch(/answering machines are inside this average/);
  });

  it('withholds the "voicemail excluded" line when voicemail is not excluded', () => {
    /*
     * The caveat directly beneath says answering machines are INSIDE this
     * average. A denominator line above it claiming they are excluded would put
     * a flat contradiction on one card, and the caveat is the one that survives.
     */
    const measured = handleTimeReadout(stats({ aht_seconds: 134 }));
    expect(measured.denominator).toEqual({ lead: null, rest: 'Voicemail excluded — core’s own figure' });

    const unmeasured = handleTimeReadout(
      stats({ aht_seconds: 134, machine_connects: 0, machine_connects_available: false }),
    );
    expect(unmeasured.denominator).toBeNull();
  });
});

describe('wrapupReadout', () => {
  it('separates a failed load from no finished wrap-up', () => {
    expect(wrapupReadout(stats(), 30).value).toBe('—');
    expect(wrapupReadout(stats({ avg_wrapup_seconds: null }), 30).value).toBe('No data');
  });

  it('names the allowed window even when there is nothing to measure yet', () => {
    // The tuning input is useful before the first measurement: it is the number
    // the operator is about to change.
    expect(wrapupReadout(stats({ avg_wrapup_seconds: null }), 45).detail).toContain('0:45');
  });

  it('reads the measured average against the configured window', () => {
    const readout = wrapupReadout(stats({ avg_wrapup_seconds: 18 }), 45);
    expect(readout.value).toBe('0:18');
    expect(readout.denominator).toEqual({ lead: '0:45', rest: 'allowed on this campaign' });
    expect(readout.caveat).toBeNull();
  });

  it('draws the average as a share of the window, with the window marked', () => {
    // The configured window is the ONE real ceiling on this surface, which is
    // why this is the only figure whose meter carries a marked limit.
    expect(wrapupReadout(stats({ avg_wrapup_seconds: 18 }), 45).scale)
      .toEqual({ kind: 'ceiling', percent: 40 });
  });

  it('pins the meter at the ceiling rather than drawing outside the track', () => {
    expect(wrapupReadout(stats({ avg_wrapup_seconds: 90 }), 45).scale)
      .toEqual({ kind: 'ceiling', percent: 100 });
  });

  it('draws no meter at all without a window to be a share of', () => {
    // The rule that governs handle time governs this too: a duration with
    // nothing to be measured against gets no percentage bar.
    expect(wrapupReadout(stats({ avg_wrapup_seconds: 18 }), undefined).scale).toBeNull();
    expect(wrapupReadout(stats({ avg_wrapup_seconds: 18 }), 0).scale).toBeNull();
  });

  it('warns once agents are using nearly the whole window', () => {
    const readout = wrapupReadout(stats({ avg_wrapup_seconds: 41 }), 45);
    expect(readout.caveat).toMatch(/running out of time/);
  });

  it('does not warn one second under the threshold', () => {
    // 90% of 45 is 40.5, so 40 is under and 41 is over. Pinned because an
    // off-by-one here turns a tuning hint into a permanent scold.
    expect(wrapupReadout(stats({ avg_wrapup_seconds: 40 }), 45).caveat).toBeNull();
  });

  it('degrades without the campaign’s window rather than inventing one', () => {
    const readout = wrapupReadout(stats({ avg_wrapup_seconds: 18 }), undefined);
    expect(readout.value).toBe('0:18');
    expect(readout.denominator).toBeNull();
    expect(readout.caveat).toBeNull();
    expect(readout.detail).toMatch(/didn’t load/);
  });

  it('does not divide by a zero window', () => {
    expect(wrapupReadout(stats({ avg_wrapup_seconds: 0 }), 0).caveat).toBeNull();
  });
});

describe('connectsBreakdown', () => {
  it('drops out entirely rather than showing buckets that cannot sum', () => {
    expect(connectsBreakdown(stats({ human_connects: 10 })).total).toBeNull();
    expect(connectsBreakdown(stats({ human_connects: 10 })).segments).toEqual([]);
    expect(connectsBreakdown(null).total).toBeNull();
  });

  it('sums the three buckets to every bridged call', () => {
    const breakdown = connectsBreakdown(
      stats({ human_connects: 40, machine_connects: 12, unclassified_connects: 3 }),
    );
    expect(breakdown.total).toBe(55);
    expect(breakdown.segments.map((s) => s.value)).toEqual([40, 12, 3]);
  });

  it('marks the machine bucket unmeasured when the catalog has no voicemail code', () => {
    const breakdown = connectsBreakdown(
      stats({
        human_connects: 40,
        machine_connects: 0,
        unclassified_connects: 3,
        machine_connects_available: false,
      }),
    );
    const machine = breakdown.segments.find((s) => s.key === 'machine')!;
    expect(machine.unmeasured).toBe(true);
    expect(machine.hint).toMatch(/no voicemail code/);
    // Still counted in the total: the calls happened, we just cannot name them.
    expect(breakdown.total).toBe(43);
  });

  it('leaves the machine bucket measured when the flag is absent', () => {
    const breakdown = connectsBreakdown(
      stats({ human_connects: 40, machine_connects: 0, unclassified_connects: 0 }),
    );
    expect(breakdown.segments.find((s) => s.key === 'machine')!.unmeasured).toBe(false);
  });

  it('keeps a real count when the code was removed AFTER voicemails were recorded', () => {
    /*
     * `disposition_catalog` is patchable on a live campaign, and core's two
     * reads disagree by design: the count reads each attempt's historical
     * `disposition_code`, the availability flag reads the CURRENT catalog. Drop
     * the code from a campaign with history and the flag says `false` while the
     * count is still truthfully 7.
     *
     * Blanking it would discard true history to report that no voicemails
     * happened — at the exact moment an operator has changed the setting and is
     * looking to see what it did.
     */
    const breakdown = connectsBreakdown(
      stats({
        human_connects: 40,
        machine_connects: 7,
        unclassified_connects: 3,
        machine_connects_available: false,
      }),
    );
    const machine = breakdown.segments.find((s) => s.key === 'machine')!;
    expect(machine.unmeasured).toBe(false);
    expect(machine.value).toBe(7);
    expect(machine.hint).toMatch(/has been removed/);
    expect(machine.hint).not.toMatch(/no way to mark one/);
  });
});

describe('RATE_MIN_ATTEMPTS', () => {
  /**
   * The one rule on this surface that is a decision of the console's rather
   * than a reading of core's payload.
   *
   * A rate is the figure that leaves the room — repeated in a stand-up, written
   * into a weekly summary, used to decide whether a list is worth buying again.
   * Over a handful of dials it is noise wearing a decimal point: at eight dials
   * one extra answer moves the connect rate twelve points, so the number quoted
   * on Tuesday is a different number on Wednesday for reasons that have nothing
   * to do with the campaign. Core's arithmetic is exact; what is withheld is the
   * settled air of a measurement, not the accuracy.
   */
  const rated = { connect_rate_pct: 40, success_rate_pct: 25, attempts_connected: 8 };

  it('withholds both rates one dial under the floor', () => {
    const dials = RATE_MIN_ATTEMPTS - 1;
    for (const readout of [
      connectRateReadout(stats({ ...rated, attempts_total: dials })),
      conversionRateReadout(stats({ ...rated, attempts_total: dials })),
    ]) {
      expect(readout.known).toBe(false);
      expect(readout.value).toBe('Not enough dials');
      // Dimmed like every other unknown, never coloured: this is the absence of
      // a number, not a bad one.
      expect(readout.caveat).toBeNull();
      expect(readout.scale).toBeNull();
      expect(readout.detail).toContain(`${RATE_MIN_ATTEMPTS} dials placed`);
      // The withheld card still says how far off the campaign is, so a
      // supervisor knows the figure is coming rather than broken.
      expect(readout.denominator).toEqual({ lead: '24', rest: 'dials placed so far' });
    }
  });

  it('publishes both rates exactly at the floor', () => {
    const at = { ...rated, attempts_total: RATE_MIN_ATTEMPTS };
    expect(connectRateReadout(stats(at)).value).toBe('40%');
    expect(connectRateReadout(stats(at)).known).toBe(true);
    expect(conversionRateReadout(stats(at)).value).toBe('25%');
    expect(conversionRateReadout(stats(at)).known).toBe(true);
  });

  it('does not withhold on a payload that never carried the dial count', () => {
    /*
     * `undefined` is "this payload did not say", exactly as it is for every
     * other field in this module. An older core that never sent the counter has
     * not told us the campaign is small, and blanking the screen's most-read
     * figure on the strength of a missing field would be inventing the reading
     * that costs the most.
     */
    const readout = connectRateReadout(stats({ connect_rate_pct: 40 }));
    expect(readout.known).toBe(true);
    expect(readout.value).toBe('40%');
    expect(conversionRateReadout(stats({ success_rate_pct: 25 })).known).toBe(true);
  });

  it('uses the singular for a campaign that has placed exactly one dial', () => {
    expect(connectRateReadout(stats({ connect_rate_pct: 100, attempts_total: 1 })).denominator)
      .toEqual({ lead: '1', rest: 'dial placed so far' });
  });

  it('lets a failed read and an empty campaign outrank the volume floor', () => {
    // Both are facts about the payload; the floor is a policy of ours about how
    // much evidence is enough, and it must not overwrite either sentence.
    expect(connectRateReadout(stats({ attempts_total: 3 })).value).toBe('—');
    expect(connectRateReadout(stats({ connect_rate_pct: null, attempts_total: 0 })).value)
      .toBe('No data');
  });

  it('leaves handle time and wrap-up alone', () => {
    // Averages over completed calls, not proportions. A mean of four calls is a
    // weak mean, but "3:14 over four calls" is a fact a supervisor discounts on
    // sight, and it is not the figure that gets quoted as a headline percentage.
    const thin = stats({ attempts_total: 4, aht_seconds: 194, avg_wrapup_seconds: 38 });
    expect(handleTimeReadout(thin).known).toBe(true);
    expect(handleTimeReadout(thin).value).toBe('3:14');
    expect(wrapupReadout(thin, 45).known).toBe(true);
    expect(wrapupReadout(thin, 45).value).toBe('0:38');
  });

  it('answers the same question `ratesWithheld` is asked by the cost card', () => {
    expect(ratesWithheld(stats({ attempts_total: 24 }))).toBe(true);
    expect(ratesWithheld(stats({ attempts_total: 25 }))).toBe(false);
    expect(ratesWithheld(stats())).toBe(false);
    expect(ratesWithheld(null)).toBe(false);
  });
});

describe('connectsBreakdown shares', () => {
  it('states each bucket as a share of every bridged call', () => {
    const breakdown = connectsBreakdown(
      stats({ human_connects: 40, machine_connects: 8, unclassified_connects: 2 }),
    );
    expect(breakdown.segments.map((s) => s.share)).toEqual([80, 16, 4]);
  });

  it('gives an unmeasured bucket no share, so it draws no segment', () => {
    /*
     * The em-dash rule reaching the bar. A structural `0` with no voicemail code
     * in the catalog is not a bucket that happened to be empty, so it must not
     * appear in the bar as a hairline the reader counts as a third thing — and
     * its percentage cell is blanked for the same reason its count is.
     */
    const machine = connectsBreakdown(
      stats({
        human_connects: 40,
        machine_connects: 0,
        unclassified_connects: 10,
        machine_connects_available: false,
      }),
    ).segments.find((s) => s.key === 'machine')!;
    expect(machine.unmeasured).toBe(true);
    expect(machine.share).toBeNull();
  });

  it('does not divide by a campaign that has connected nothing', () => {
    const breakdown = connectsBreakdown(
      stats({ human_connects: 0, machine_connects: 0, unclassified_connects: 0 }),
    );
    expect(breakdown.total).toBe(0);
    expect(breakdown.segments.map((s) => s.share)).toEqual([null, null, null]);
  });
});

describe('handledCallCost', () => {
  /**
   * Handle time and wrap-up are each a tuning input for a different setting, and
   * neither answers the question a supervisor is holding — "how many
   * conversations can this floor have today". Their sum does.
   */
  const busy = { aht_seconds: 194, avg_wrapup_seconds: 38 };

  it('adds the two legs into one occupied minute per connected call', () => {
    const cost = handledCallCost(stats(busy))!;
    expect(cost.total).toBe('3:52');
    expect(cost.talk.label).toBe('3:14');
    expect(cost.wrapup.label).toBe('0:38');
    expect(cost.talk.percent + cost.wrapup.percent).toBeCloseTo(100);
  });

  it('turns the cost into conversations an agent can take in an hour', () => {
    // 3600 / 232 = 15.51…
    expect(handledCallCost(stats(busy))!.perHour).toBe('15.5');
  });

  it('takes wins per hour at the campaign’s own conversion rate, and names it', () => {
    const cost = handledCallCost(stats({ ...busy, success_rate_pct: 20.5, attempts_total: 400 }))!;
    expect(cost.winsPerHour).toBe('3.2');
    // The rate travels with the figure derived from it. A bare "3.2" beside a
    // bare "15.5" is two numbers with no stated relationship.
    expect(cost.conversionRate).toBe('20.5%');
  });

  it('withholds wins per hour with the rate it is made of', () => {
    /*
     * `winsPerHour` is `perHour × success_rate_pct`. A conversion rate this
     * console refuses to publish must not reappear multiplied into a figure
     * wearing a decimal point and the word "wins", which is more quotable than
     * the rate was.
     */
    const cost = handledCallCost(stats({ ...busy, success_rate_pct: 20.5, attempts_total: 9 }))!;
    expect(cost.winsPerHour).toBeNull();
    expect(cost.conversionRate).toBeNull();
    // The cost itself is an average over completed calls and stands.
    expect(cost.perHour).toBe('15.5');
  });

  it('has nothing to say when the conversion rate has not been measured', () => {
    const cost = handledCallCost(stats({ ...busy, success_rate_pct: null }))!;
    expect(cost.winsPerHour).toBeNull();
  });

  it('needs BOTH averages, and never substitutes a zero for the missing one', () => {
    /*
     * The failure this guards. Treating an absent wrap-up as 0 would not degrade
     * the estimate, it would INFLATE it — 3600/194 is 18.6 an hour against a
     * true 15.5 — and a supervisor comparing that target against a floor doing
     * eleven has been handed a number derived from a field that never loaded.
     */
    expect(handledCallCost(stats({ aht_seconds: 194 }))).toBeNull();
    expect(handledCallCost(stats({ avg_wrapup_seconds: 38 }))).toBeNull();
    expect(handledCallCost(stats({ aht_seconds: 194, avg_wrapup_seconds: null }))).toBeNull();
    expect(handledCallCost(stats({ aht_seconds: null, avg_wrapup_seconds: 38 }))).toBeNull();
    expect(handledCallCost(null)).toBeNull();
  });

  it('does not divide by a zero-length handled call', () => {
    expect(handledCallCost(stats({ aht_seconds: 0, avg_wrapup_seconds: 0 }))).toBeNull();
  });

  it('says out loud that the figure is a ceiling', () => {
    // No break, no ringing, no gap between contacts, nobody logged out. Every
    // one is real time this arithmetic does not know about, so the caveat is
    // part of the figure rather than a footnote under it.
    expect(handledCallCost(stats(busy))!.caveat)
      .toBe('A ceiling, not a forecast — it assumes an agent takes a call the moment the last one is written up.');
  });
});
