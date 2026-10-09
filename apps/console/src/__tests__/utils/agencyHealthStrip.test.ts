import { describe, it, expect } from 'vitest';
import {
  AGENCY_STALL_LABELS,
  AGENCY_STALL_PRIORITY,
  abandonmentReadout,
  concurrencyReadout,
  sortStallCodes,
  splitFact,
  stallCopy,
} from '../../utils/agencyHealthStrip';
import type { AgencyStall, AgencyStallCode } from '../../types/agency-campaign';

/**
 * The health strip's derivations (§C.2, §C.3, CR-2).
 *
 * Everything here is a claim made to a supervisor about a live campaign, so the
 * cases that matter are the ones where being wrong sends them after the wrong
 * problem: the ranking that decides which single diagnosis they read, and the
 * two "we don't know" values that must never render as reassuring zeroes.
 */

/** A fixed stand-in for the locale formatter, so no test depends on the host. */
const at = (iso: string) => `«${iso}»`;

describe('stall priority', () => {
  it('is exactly core’s AGENCY_STALL_PRIORITY, in order', () => {
    // Mirrored by hand from `magic-voice-core/src/agency/contracts.ts`. Pinned
    // literally rather than derived, because the whole point of the constant is
    // that a reorder is a decision someone made — it should break a test, not
    // quietly change which diagnosis a supervisor sees.
    expect([...AGENCY_STALL_PRIORITY]).toEqual([
      'auto_paused_abandonment',
      'dnc_unavailable',
      'no_agents_available',
      'concurrency_saturated',
      'outside_calling_hours',
      'list_exhausted_retries_pending',
      // PORT NOTE (magick-agency): `credits_low` (priority 7) removed — plan §3.3.
      'elevated_failure_rate',
    ]);
  });

  it('labels every code, so a disclosure can never render an empty line', () => {
    for (const code of AGENCY_STALL_PRIORITY) {
      expect(AGENCY_STALL_LABELS[code]).toBeTruthy();
    }
  });
});

describe('sortStallCodes', () => {
  it('sorts by priority, NOT by the order the array arrived in', () => {
    // Core does send `other_stalls` ranked. This asserts the console does not
    // depend on that: reversed input must come back in priority order.
    // PORT NOTE (magick-agency): cusui's fixture carried `credits_low`, which is
    // no longer a stall code; `outside_calling_hours` takes its slot.
    const scrambled: AgencyStallCode[] = [
      'elevated_failure_rate',
      'no_agents_available',
      'outside_calling_hours',
      'dnc_unavailable',
    ];
    expect(sortStallCodes(scrambled)).toEqual([
      'dnc_unavailable',
      'no_agents_available',
      'outside_calling_hours',
      'elevated_failure_rate',
    ]);
  });

  it('drops a code this build has no label for', () => {
    // A "3 more issues" count whose disclosure lists two names is worse than an
    // honest two — so unknown codes leave the count as well as the list.
    const withUnknown = ['dnc_unavailable', 'time_travel_paradox'] as AgencyStallCode[];
    expect(sortStallCodes(withUnknown)).toEqual(['dnc_unavailable']);
  });

  it('does not mutate its input', () => {
    // PORT NOTE (magick-agency): `credits_low` → `elevated_failure_rate` (removed code).
    const input: AgencyStallCode[] = ['elevated_failure_rate', 'dnc_unavailable'];
    sortStallCodes(input);
    expect(input).toEqual(['elevated_failure_rate', 'dnc_unavailable']);
  });
});

describe('stallCopy — each arm names its own evidence', () => {
  it('auto_paused_abandonment says the rate was MEASURED, not that it is current', () => {
    const stall: AgencyStall = {
      code: 'auto_paused_abandonment',
      measured_pct: 3.42,
      ceiling_pct: 3,
      paused_at: '2026-08-15T09:30:00.000Z',
    };
    const copy = stallCopy(stall, at);

    expect(copy.headline).toContain('3.4%');
    expect(copy.headline).toContain('3%');
    // The figure is frozen at the instant the guardrail fired (core migration
    // 089). Calling it a current rate means a supervisor who has since staffed
    // up watches a number that cannot move and concludes the fix failed.
    expect(copy.evidence).toContain('«2026-08-15T09:30:00.000Z»');
    expect(copy.evidence).toMatch(/not a live rate/i);
    expect(copy.headline).not.toMatch(/currently|right now/i);
  });

  it('dnc_unavailable says the whole workspace is affected', () => {
    const copy = stallCopy({ code: 'dnc_unavailable', tenant_wide: true }, at);
    expect(copy.evidence).toMatch(/workspace/i);
    expect(copy.evidence).toMatch(/every campaign/i);
  });

  it('no_agents_available breaks the roster down by break reason', () => {
    const copy = stallCopy(
      {
        code: 'no_agents_available',
        agents_on_shift: 6,
        on_break_by_reason: { training: 1, lunch: 3 },
        on_call: 2,
        last_dial_at: '2026-08-15T10:00:00.000Z',
      },
      at,
    );
    expect(copy.evidence).toContain('6 agents on shift');
    expect(copy.evidence).toContain('2 on a call');
    // Largest reason first — the one holding the most agents is the actionable
    // one, and it is what a supervisor scanning under pressure reads.
    expect(copy.evidence).toContain('4 on break (lunch 3, training 1)');
    // The last dial is EVIDENCE, not advice — a fact about the campaign the
    // supervisor can check, which sat in `advice` only because the banner had
    // nowhere else to put it. What to do about an empty floor is the "Open the
    // floor" link, so this arm now offers no advice sentence at all.
    expect(copy.evidence).toContain('«2026-08-15T10:00:00.000Z»');
    expect(copy.advice).toBeUndefined();
  });

  it('no_agents_available distinguishes “never dialed” from “stopped dialing”', () => {
    const copy = stallCopy(
      {
        code: 'no_agents_available',
        agents_on_shift: 0,
        on_break_by_reason: {},
        on_call: 0,
        last_dial_at: null,
      },
      at,
    );
    // Two different problems with two different fixes; a missing timestamp must
    // not silently render as a blank where a time would go.
    expect(copy.evidence).toMatch(/never placed a call/i);
    expect(copy.evidence).not.toMatch(/on break/i);
  });

  it('concurrency_saturated names the numbers and says who can change the limit', () => {
    const copy = stallCopy({ code: 'concurrency_saturated', limit: 5, in_use: 5 }, at);
    expect(copy.headline).toContain('5 of 5');
    // D10: read-only. The advice must not imply the supervisor can raise it.
    expect(copy.advice).toMatch(/support/i);
  });

  it('outside_calling_hours falls back honestly when no window resolves', () => {
    const withWindow = stallCopy(
      {
        code: 'outside_calling_hours',
        contacts_waiting: 412,
        next_window_opens_at: '2026-08-16T03:30:00.000Z',
      },
      at,
    );
    expect(withWindow.evidence).toContain('412 contacts');
    expect(withWindow.advice).toContain('«2026-08-16T03:30:00.000Z»');

    const noWindow = stallCopy(
      { code: 'outside_calling_hours', contacts_waiting: 1, next_window_opens_at: null },
      at,
    );
    expect(noWindow.evidence).toContain('1 contact ');
    expect(noWindow.advice).toMatch(/no upcoming window/i);
  });

  it('list_exhausted_retries_pending pluralises retries and handles a null next time', () => {
    const one = stallCopy(
      { code: 'list_exhausted_retries_pending', retries_pending: 1, next_retry_at: null },
      at,
    );
    expect(one.evidence).toContain('1 retry');
    expect(one.advice).toMatch(/no retry time is set/i);

    const many = stallCopy(
      {
        code: 'list_exhausted_retries_pending',
        retries_pending: 12,
        next_retry_at: '2026-08-15T14:00:00.000Z',
      },
      at,
    );
    expect(many.evidence).toContain('12 retries');
    expect(many.advice).toContain('«2026-08-15T14:00:00.000Z»');
  });

  it('credits_low is GONE — no label, dropped from a disclosure, no "top up" copy anywhere (magick-agency)', () => {
    // PORT NOTE (magick-agency): cusui's case was "credits_low renders even though
    // core never emits it" (master inserted the arm from its balance). Agency v1
    // has no credits, and plan §3.3 removes the code from the union AND the
    // console's health-strip copy, because a declared-but-unproducible code is the
    // pattern `docs/reference/magickvoice-platform/agency.md` warns about. This is that deletion's test.
    const removed = 'credits_low' as AgencyStallCode;
    expect(AGENCY_STALL_PRIORITY).not.toContain(removed);
    expect(Object.keys(AGENCY_STALL_LABELS)).not.toContain('credits_low');
    expect(sortStallCodes([removed, 'dnc_unavailable'])).toEqual(['dnc_unavailable']);
    for (const label of Object.values(AGENCY_STALL_LABELS)) {
      expect(label.toLowerCase()).not.toContain('credit');
    }
  });

  it('elevated_failure_rate names its window rather than implying “lately”', () => {
    const copy = stallCopy(
      { code: 'elevated_failure_rate', failed_pct: 62.5, attempts: 80, window_minutes: 15 },
      at,
    );
    expect(copy.headline).toContain('62.5%');
    expect(copy.evidence).toContain('80 attempts');
    expect(copy.evidence).toContain('15 minutes');
  });
});

describe('concurrencyReadout — CR-2', () => {
  it('renders the live count against the ceiling', () => {
    const out = concurrencyReadout(5, 3);
    expect(out.value).toBe('3 of 5');
    expect(out.saturated).toBe(false);
    expect(out.unknown).toBe(false);
  });

  it('flags saturation only when the count is known', () => {
    expect(concurrencyReadout(5, 5).saturated).toBe(true);
    expect(concurrencyReadout(5, 6).saturated).toBe(true);
  });

  it('treats a null in-use as UNKNOWN — never 0, never saturated', () => {
    // `null` means Redis could not answer. Rendering 0 invites a supervisor to
    // conclude there is headroom; rendering "saturated" sends them to support
    // about a limit we merely failed to read. Both are the wrong instruction.
    const out = concurrencyReadout(5, null);
    expect(out.unknown).toBe(true);
    expect(out.saturated).toBe(false);
    expect(out.value).not.toBe('0 of 5');
    expect(out.value).toContain('5');
    expect(out.detail).toMatch(/couldn’t read/i);
  });

  it('treats an absent in-use the same as a null one', () => {
    const out = concurrencyReadout(5, undefined);
    expect(out.unknown).toBe(true);
    expect(out.saturated).toBe(false);
  });

  it('degrades to a dash when the limit itself did not load', () => {
    const out = concurrencyReadout(undefined, null);
    expect(out.value).toBe('—');
    expect(out.saturated).toBe(false);
  });
});

describe('abandonmentReadout — §C.3', () => {
  it('draws the rate against THIS campaign’s ceiling, not a constant', () => {
    const out = abandonmentReadout(2.4, 3);
    expect(out.value).toBe('2.4%');
    expect(out.detail).toContain('3%');
    expect(out.over).toBe(false);
  });

  it('goes amber at 75% of the ceiling and over at the ceiling', () => {
    expect(abandonmentReadout(2.25, 3).nearCeiling).toBe(true);
    expect(abandonmentReadout(2.24, 3).nearCeiling).toBe(false);
    expect(abandonmentReadout(3, 3).over).toBe(true);
    expect(abandonmentReadout(3, 3).nearCeiling).toBe(false);
  });

  it('renders a null rate as “no data”, never as 0%', () => {
    // Core sends null when no calls were answered in the window. "No calls
    // answered yet" and "no calls abandoned" are different facts, and rendering
    // the first as a reassuring 0.0% is how a guardrail gets trusted before it
    // has measured anything.
    const out = abandonmentReadout(null, 3);
    expect(out.value).toBe('No data');
    expect(out.value).not.toContain('0');
    expect(out.over).toBe(false);
    expect(out.nearCeiling).toBe(false);
  });

  it('renders an absent rate as a dash and still states the ceiling', () => {
    const out = abandonmentReadout(undefined, 3);
    expect(out.value).toBe('—');
    expect(out.detail).toContain('3%');
  });

  it('shows the denominator, so a tiny sample cannot read as a trend', () => {
    // `2 of 5` and `40 of 100` are the same 40%. Only one of them is news, and
    // it is not the one a supervisor should restaff over (MAG-151).
    const out = abandonmentReadout(40, 50, { abandoned: 2, answered: 5 });
    expect(out.detail).toContain('2 of 5 answered calls');
  });

  it('uses the singular for a denominator of one', () => {
    expect(abandonmentReadout(100, 5, { abandoned: 1, answered: 1 }).detail)
      .toContain('1 of 1 answered call.');
  });

  it('omits the sample when the counts did not arrive', () => {
    expect(abandonmentReadout(2.4, 3, { abandoned: undefined, answered: 12 }).detail)
      .not.toMatch(/\bof\b \d/);
    expect(abandonmentReadout(2.4, 3).detail).not.toMatch(/\bof\b \d/);
  });

  it('states the sample on a no-ceiling payload too', () => {
    expect(abandonmentReadout(2.4, undefined, { abandoned: 3, answered: 125 }).detail)
      .toContain('3 of 125 answered calls');
  });
});

describe('the evidence run — facts, and the numbers inside them', () => {
  /**
   * The banner reads the facts, not the joined string. These pin the one thing
   * that could quietly go wrong once the two exist side by side: they must be
   * the same words.
   */
  it('joins to exactly the evidence sentence, for every arm', () => {
    const arms: AgencyStall[] = [
      { code: 'auto_paused_abandonment', measured_pct: 3.42, ceiling_pct: 3, paused_at: 'P' },
      { code: 'dnc_unavailable', tenant_wide: true },
      {
        code: 'no_agents_available',
        agents_on_shift: 2,
        on_break_by_reason: { lunch: 1 },
        on_call: 0,
        last_dial_at: 'D',
      },
      { code: 'concurrency_saturated', limit: 5, in_use: 5 },
      { code: 'outside_calling_hours', contacts_waiting: 412, next_window_opens_at: null },
      { code: 'list_exhausted_retries_pending', retries_pending: 3, next_retry_at: null },
      { code: 'elevated_failure_rate', failed_pct: 62.5, attempts: 80, window_minutes: 15 },
    ];
    for (const stall of arms) {
      const copy = stallCopy(stall, at);
      expect(copy.facts.length).toBeGreaterThan(0);
      expect(copy.facts.map((fact) => fact.text).join(' · ')).toBe(copy.evidence);
    }
  });

  it('emphasises a number that is really a substring of its own fact', () => {
    // The emphasis is a substring rather than a separate value precisely so it
    // cannot drift from the sentence. If it ever stops matching, the fact still
    // renders — but the banner silently loses every bold number, which nothing
    // else here would catch.
    const copy = stallCopy(
      {
        code: 'no_agents_available',
        agents_on_shift: 1200,
        on_break_by_reason: { lunch: 3 },
        on_call: 7,
        last_dial_at: '2026-08-15T10:00:00.000Z',
      },
      at,
    );
    for (const fact of copy.facts) {
      if (!fact.emphasis) continue;
      expect(fact.text).toContain(fact.emphasis);
    }
    // Localised, so the bold run covers the whole number and not "1" of "1,200".
    expect(copy.facts[0]).toEqual({ text: '1,200 agents on shift', emphasis: '1,200' });
    expect(splitFact(copy.facts[0]!)).toEqual({
      before: '',
      value: '1,200',
      after: ' agents on shift',
    });
  });

  it('splitFact degrades to the whole sentence rather than dropping words', () => {
    expect(splitFact({ text: 'No emphasis here.' })).toEqual({
      before: 'No emphasis here.',
      value: '',
      after: '',
    });
    // An emphasis that does not match is a styling miss, never a missing fact.
    expect(splitFact({ text: 'Nine lines free', emphasis: '9' })).toEqual({
      before: 'Nine lines free',
      value: '',
      after: '',
    });
    expect(splitFact({ text: 'Last call placed at 09:21', emphasis: '09:21' })).toEqual({
      before: 'Last call placed at ',
      value: '09:21',
      after: '',
    });
  });
});

describe('the meters', () => {
  it('fills concurrency to the ratio of the ceiling', () => {
    expect(concurrencyReadout(30, 12).fill).toBeCloseTo(0.4);
    expect(concurrencyReadout(5, 5).fill).toBe(1);
  });

  it('clamps an over-limit count rather than overflowing the track', () => {
    // Core's count is account-wide and can exceed the campaign's view of the
    // limit; a 120% bar is a rendering bug, not a fact worth drawing.
    expect(concurrencyReadout(5, 6).fill).toBe(1);
  });

  it('draws NOTHING when the count is unknown — never a zero-width bar', () => {
    // A 0% fill is a drawn claim that the account is idle. We do not know that;
    // we know we could not read it, which is a different thing to show.
    expect(concurrencyReadout(30, null).fill).toBeNull();
    expect(concurrencyReadout(30, undefined).fill).toBeNull();
    expect(concurrencyReadout(undefined, 4).fill).toBeNull();
    // A zero limit is not a ratio either — and would divide by zero.
    expect(concurrencyReadout(0, 0).fill).toBeNull();
  });

  it('scales abandonment so the campaign’s OWN ceiling is a full track', () => {
    // Against 100% every real rate is a few pixels, which teaches a supervisor
    // they have room they do not have. The ceiling is the scale.
    expect(abandonmentReadout(2.4, 3).fill).toBeCloseTo(0.8);
    expect(abandonmentReadout(3, 3).fill).toBe(1);
    expect(abandonmentReadout(9, 3).fill).toBe(1);
  });

  it('bands the fill by proximity to that ceiling', () => {
    expect(abandonmentReadout(1, 3).band).toBe('ok');
    expect(abandonmentReadout(2.25, 3).band).toBe('near');
    expect(abandonmentReadout(3, 3).band).toBe('over');
  });

  it('never draws or bands a rate that was not measured', () => {
    // The null-not-zero rule, in the meter: `null` is core's "no answered calls
    // in the window", and a reassuring empty green bar is exactly the reading
    // this field exists to prevent.
    const noData = abandonmentReadout(null, 3);
    expect(noData.fill).toBeNull();
    expect(noData.band).toBe('unknown');

    const absent = abandonmentReadout(undefined, 3);
    expect(absent.fill).toBeNull();
    expect(absent.band).toBe('unknown');
  });

  it('draws no bar for a known rate with no ceiling to scale it against', () => {
    // The number still renders; the bar does not, because a bar with no scale
    // is a picture of a comparison nobody made.
    const out = abandonmentReadout(2.4, undefined);
    expect(out.value).toBe('2.4%');
    expect(out.fill).toBeNull();
    expect(out.band).toBe('unknown');
    expect(out.ceilingLabel).toBeNull();
  });

  it('labels the ceiling tick with the campaign’s own figure', () => {
    expect(abandonmentReadout(2.4, 3).ceilingLabel).toBe('3% ceiling');
    expect(abandonmentReadout(2.4, 5.5).ceilingLabel).toBe('5.5% ceiling');
    // Present even when the rate is not, because the tick is a fact about the
    // campaign's configuration rather than about the measurement.
    expect(abandonmentReadout(null, 3).ceilingLabel).toBe('3% ceiling');
  });
});

describe('abandonmentReadout when core will not act on the breach', () => {
  /*
    Core's guardrail gained a fourth refusal on 2026-09-11: a breach whose
    numerator is a SINGLE call and whose denominator is below `ceil(100/ceiling)`
    does not pause the campaign, because before that `1 of 1` read 100% and paused
    campaigns permanently.

    That made the live sentence here FALSE in exactly the case a supervisor is most
    likely to meet first — the first abandoned call of a fresh campaign. And it
    fails in the worst direction: "the campaign pauses itself above it" beside a
    campaign that is visibly still dialing does not read as a small-sample nuance,
    it reads as a broken guardrail, and the next move is to stop it by hand.
  */
  it('stops promising a pause that core will not perform', () => {
    // 1 of 1 = 100%, and core leaves this running.
    const readout = abandonmentReadout(100, 3, { abandoned: 1, answered: 1 });
    expect(readout.detail).not.toContain('pauses itself above it');
    expect(readout.detail).toContain('keeps dialing');
    // The reason, not just the fact — "over the limit whatever we did" is the
    // whole point: at n=1 no pacing decision could have produced a passing number.
    expect(readout.detail).toContain('whatever we did');
    // And it still says a pause is coming, once the rate can mean something.
    expect(readout.detail).toContain('pauses itself once');
  });

  it('holds at the boundary core uses, not one of its own', () => {
    // 1 of 33 = 3.03%: over a 3% ceiling, and suppressed by core.
    expect(abandonmentReadout(3.03, 3, { abandoned: 1, answered: 33 }).detail)
      .toContain('keeps dialing');
    // A 1% ceiling needs 100 answered calls before one abandon can clear it, so
    // the threshold has to scale with the ceiling rather than being a constant.
    expect(abandonmentReadout(2, 1, { abandoned: 1, answered: 50 }).detail)
      .toContain('keeps dialing');
    expect(abandonmentReadout(2, 1, { abandoned: 1, answered: 150 }).detail)
      .toContain('pauses itself above it');
  });

  it('keeps the promise wherever core WILL pause', () => {
    // Two abandoned calls: core pauses however small the sample, so the original
    // sentence is true and must survive.
    expect(abandonmentReadout(100, 3, { abandoned: 2, answered: 2 }).detail)
      .toContain('pauses itself above it');
    // A catastrophic small campaign pauses too.
    expect(abandonmentReadout(80, 3, { abandoned: 20, answered: 25 }).detail)
      .toContain('pauses itself above it');
    // And the real case is untouched.
    expect(abandonmentReadout(4, 3, { abandoned: 4, answered: 100 }).detail)
      .toContain('pauses itself above it');
  });

  it('falls back to the promise when the counts are absent', () => {
    // The pause is the norm and the suppression the exception, so an unknowable
    // denominator must not weaken the sentence — the failure would be telling
    // every supervisor their campaign might not stop.
    expect(abandonmentReadout(100, 3).detail).toContain('pauses itself above it');
    expect(abandonmentReadout(100, 3, { abandoned: undefined, answered: 1 }).detail)
      .toContain('pauses itself above it');
  });

  it('does not touch the number, the meter or the band', () => {
    // The rate IS over the ceiling and the strip should still say so in colour.
    // This changes what we PROMISE, never what we report — suppressing the band
    // would hide a real breach behind a sample-size argument.
    const suppressed = abandonmentReadout(100, 3, { abandoned: 1, answered: 1 });
    expect(suppressed.over).toBe(true);
    expect(suppressed.band).toBe('over');
    expect(suppressed.value).toBe(abandonmentReadout(100, 3).value);
  });
});

describe('abandonmentReadout on a campaign that has finished', () => {
  /*
    This is a rolling 24-hour figure about the whole ACCOUNT. On a campaign that
    stopped three weeks ago it describes this afternoon, so the live wording —
    "against this campaign's 3% limit, the campaign pauses itself above it" — is
    present tense about a campaign that cannot pause, beside a percentage a
    supervisor will read as that campaign's own abandonment rate.
  */
  it('stops claiming the campaign will pause itself', () => {
    const readout = abandonmentReadout(2.1, 3, undefined, true);
    expect(readout.detail).not.toContain('pauses itself');
    expect(readout.detail).toContain('has stopped');
    expect(readout.detail).toContain('no longer counted');
  });

  it('keeps the live wording by default, which is the safe direction', () => {
    // Live copy on a dead campaign is unhelpful; terminal copy on a LIVE one
    // would tell a supervisor their running campaign had stopped.
    expect(abandonmentReadout(2.1, 3).detail).toContain('pauses itself');
  });

  it('still renders the number and the meter either way', () => {
    const finished = abandonmentReadout(2.1, 3, undefined, true);
    expect(finished.value).toBe(abandonmentReadout(2.1, 3).value);
    expect(finished.fill).toBe(abandonmentReadout(2.1, 3).fill);
    expect(finished.band).toBe(abandonmentReadout(2.1, 3).band);
  });
});
