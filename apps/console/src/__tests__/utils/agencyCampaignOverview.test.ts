import { describe, expect, it } from 'vitest';
import {
  campaignRunLength,
  CONTACT_FUNNEL_STATES,
  CONTACT_STATE_BUCKET,
  campaignTimeline,
  contactFunnel,
  floorSummary,
  funnelBarWithheldNote,
  howItEndedLines,
  howItRanLines,
  listWorkedRing,
  onCallNote,
  pulseFigures,
  retriesNote,
  RING_CIRCUMFERENCE,
} from '../../utils/agencyCampaignOverview';
import { RATE_MIN_ATTEMPTS, ratesWithheld } from '../../utils/agencyCampaignPerformance';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';

/**
 * The Overview panel's derivations.
 *
 * Everything on that panel is now a proportion, a rate or a share, and every
 * one of them is computed from a payload of optional-and-nullable fields. The
 * failure these tests exist to stop is the quiet one: a missing number rendered
 * as a confident `0`, or a null rate rendered as a reassuring `0%`. Both look
 * exactly like a real measurement on screen, and both are read as verdicts on a
 * campaign.
 */

function stats(over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats {
  return {
    contacts_total: 1000,
    contacts_pending: 400,
    contacts_in_flight: 3,
    contacts_completed: 550,
    contacts_suppressed: 20,
    contacts_exhausted: 27,
    retries_pending: 12,
    attempts_live: 3,
    attempts_total: 1400,
    attempts_connected: 610,
    human_connects: 500,
    connect_rate_pct: 35.714,
    attempts_success: 120,
    success_rate_pct: 19.67,
    stall: null,
    other_stalls: [],
    concurrency_limit: 5,
    concurrency_in_use: 2,
    abandonment_ceiling_pct: 3,
    ...over,
  };
}

describe('the contact funnel', () => {
  it('renders nothing at all when there are no stats', () => {
    const funnel = contactFunnel(null);

    expect(funnel.drawable).toBe(false);
    expect(funnel.total).toBeNull();
    expect(funnel.totalLabel).toBe('—');
    expect(funnel.segments).toEqual([]);
    // The key still lists all five, so the reader learns which states exist
    // even when none of them has a number.
    expect(funnel.cells).toHaveLength(5);
    expect(funnel.cells.every((c) => c.value === '—')).toBe(true);
    expect(funnel.cells.every((c) => c.percentLabel === null)).toBe(true);
  });

  it('withholds every proportion on a campaign with no contacts — 0/0 is not 0%', () => {
    const funnel = contactFunnel(stats({
      contacts_total: 0,
      contacts_pending: 0,
      contacts_in_flight: 0,
      contacts_completed: 0,
      contacts_suppressed: 0,
      contacts_exhausted: 0,
    }));

    expect(funnel.drawable).toBe(false);
    expect(funnel.segments).toEqual([]);
    // The counts are real zeros and are reported as such. It is the SHARE that
    // does not exist, and a `0.0%` beside each state would invent one.
    expect(funnel.cells.map((c) => c.value)).toEqual(['0', '0', '0', '0', '0']);
    expect(funnel.cells.every((c) => c.percent === null)).toBe(true);
  });

  it('keeps a hairline state on the bar rather than rounding it away', () => {
    const funnel = contactFunnel(stats({
      contacts_total: 5000,
      contacts_completed: 4999,
      contacts_in_flight: 1,
      contacts_pending: 0,
      contacts_suppressed: 0,
      contacts_exhausted: 0,
    }));

    // One contact in five thousand is 0.02% of the bar. It is still drawn (the
    // stylesheet floors the segment at 5px), because a bar showing one colour
    // beside a key listing two reads as "nothing is in flight".
    const drawn = funnel.segments.map((s) => s.key);
    expect(drawn).toEqual(['contacts_completed', 'contacts_in_flight']);
    expect(funnel.segments[1]!.widthPercent).toBeCloseTo(0.02, 5);
    expect(funnel.barLabel).toContain('In flight 1');

    // A real zero is not drawn — there is nothing to see — but keeps its row.
    expect(drawn).not.toContain('contacts_pending');
    expect(funnel.cells.find((c) => c.key === 'contacts_pending')!.value).toBe('0');
  });

  it('draws a short bar rather than inventing a total when a state is missing', () => {
    const funnel = contactFunnel(stats({ contacts_exhausted: undefined }));

    const exhausted = funnel.cells.find((c) => c.key === 'contacts_exhausted')!;
    expect(exhausted.value).toBe('—');
    expect(exhausted.count).toBeNull();
    expect(exhausted.percentLabel).toBeNull();
    // Nothing is redistributed onto the other four: dividing by the SUM of the
    // states would silently fill the bar to 100% and hide the failed read.
    expect(funnel.cells.find((c) => c.key === 'contacts_completed')!.percentLabel).toBe('55%');
    expect(funnel.segments.map((s) => s.key)).not.toContain('contacts_exhausted');
  });

  it('carries the counters’ own hint copy, so nothing was reworded by accident', () => {
    const funnel = contactFunnel(stats());
    const hints = Object.fromEntries(funnel.cells.map((c) => [c.key, c.hint]));

    expect(hints['contacts_pending']).toBe('Not yet dialed, or waiting on a retry.');
    expect(hints['contacts_in_flight']).toBe('Being dialed right now.');
    expect(hints['contacts_completed']).toBe('Finished with a recorded call outcome.');
    expect(hints['contacts_exhausted']).toBe('Finished after every permitted retry was used.');
  });

  it('does not tell a supervisor that a suppressed contact was skipped', () => {
    /*
      The one hint deliberately NOT carried over. "Skipped because of Do Not
      Call rules or an unusable number" is false in the commonest case on a
      collections campaign: the contact was dialed, answered, and written up
      with an outcome configured to stop calling. Those are the campaign's
      *successes* — the same rows the pulse strip counts two panels up — and
      describing them as skipped inverts what happened.

      Asserted as a prohibition on the claim rather than an exact string, so the
      copy can still be improved without this test having an opinion about
      wording it should not have.
    */
    const hint = contactFunnel(stats()).cells
      .find((c) => c.key === 'contacts_suppressed')!.hint;

    expect(hint).not.toMatch(/skipped/i);
    expect(hint).not.toMatch(/never dialed/i);
    // It must still say where the actual reason lives, per-contact.
    expect(hint).toMatch(/Contacts tab/);
  });
});

describe('the contact state the stats payload does not count', () => {
  /*
    `AgencyContactState` has six members; `AgencyCampaignStats` carries counters
    for five. The missing one is `connected` — "On a call" — so on any campaign
    with a bridged contact the five counters cannot sum to `contacts_total`.

    Observed on production: 36 contacts, five buckets summing to 33, a bar drawn
    to 91.7% and a key whose rows added to 91.7%, with nothing anywhere on the
    panel to say where the other three contacts were. The bar was *honest* — it
    divides by `contacts_total`, so it correctly drew short — it just had no way
    to say why.
  */
  const reconciling = (over: Partial<AgencyCampaignStats> = {}): AgencyCampaignStats =>
    stats({
      contacts_total: 36,
      contacts_completed: 0,
      contacts_in_flight: 0,
      contacts_pending: 2,
      contacts_suppressed: 23,
      contacts_exhausted: 8,
      ...over,
    });

  it('names the remainder instead of leaving the bar quietly short', () => {
    const funnel = contactFunnel(reconciling());

    // Nothing is left over: the remainder IS the on-call count, by construction.
    expect(funnel.unaccounted).toBe(0);
    expect(funnel.reconciles).toBe(true);

    const onCall = funnel.cells.find((c) => c.key === 'contacts_on_call')!;
    expect(onCall.label).toBe('On a call');
    expect(onCall.count).toBe(3);
    expect(onCall.percentLabel).toBe('8.3%');
    // It is a subtraction, not a reading, and says so.
    expect(onCall.derived).toBe(true);

    // With the sixth state named, the key now accounts for the whole list.
    const shares = funnel.cells.reduce((sum, c) => sum + (c.percent ?? 0), 0);
    expect(shares).toBeCloseTo(100, 6);
    expect(funnel.barLabel).toContain('On a call 3');
  });

  it('stays out of the way when the buckets already reconcile', () => {
    // A *derived* zero says only "the counters add up", which the absence of
    // the row says more quietly. Six rows on every healthy campaign would train
    // a supervisor to skim past the one campaign where it is not zero.
    const funnel = contactFunnel(reconciling({ contacts_pending: 5 }));

    expect(funnel.unaccounted).toBe(0);
    expect(funnel.reconciles).toBe(true);
    expect(funnel.cells.map((c) => c.key)).not.toContain('contacts_on_call');
    expect(funnel.cells).toHaveLength(5);
  });

  it('refuses to attribute a failed read to a customer being mid-conversation', () => {
    /*
      The trap this guard exists for. A missing counter ALSO produces a short
      bar, and subtracting from the total would turn a delivery problem into a
      confident claim that three people are on the phone right now. Unknowable
      is the only honest answer.
    */
    const funnel = contactFunnel(reconciling({ contacts_exhausted: undefined }));

    expect(funnel.unaccounted).toBeNull();
    expect(funnel.cells.map((c) => c.key)).not.toContain('contacts_on_call');
  });

  it('draws no bar at all on an incoherent payload', () => {
    /*
      The stylesheet is why this is not cosmetic. `.funnelSeg` is
      `flex: 0 1 auto`: `flex-grow: 0` is what makes the module's promise true —
      segments summing to 91.7% stop at 91.7%, because nothing grows to fill the
      track. But `flex-shrink: 1` means the converse does not hold: segments
      summing PAST 100% get shrunk proportionally until they fit, rendering the
      always-full bar this module refuses to compute, arrived at through CSS
      instead of arithmetic.

      So the counts stay and the picture goes.
    */
    const funnel = contactFunnel(reconciling({ contacts_suppressed: 40 }));

    expect(funnel.reconciles).toBe(false);
    expect(funnel.segments).toEqual([]);
    // The counts themselves are still the facts, and are still reported.
    expect(funnel.cells.find((c) => c.key === 'contacts_suppressed')!.value).toBe('40');
    // And the reader is told why the shape is missing.
    const note = funnelBarWithheldNote(funnel);
    expect(note).not.toBeNull();
    expect(note!).toMatch(/do not add up/);
    expect(note!).toMatch(/reload/i);
  });

  it('withholds a negative remainder rather than clamping it to zero', () => {
    /*
      Counters summing PAST the total means the payload was assembled from two
      moments — the same incoherence `listWorkedRing` already refuses to draw.
      Clamping to 0 would report "the buckets reconcile", which is the one thing
      we know to be untrue.
    */
    const funnel = contactFunnel(reconciling({ contacts_suppressed: 40 }));

    expect(funnel.reconciles).toBe(false);
    expect(funnel.unaccounted).toBeNull();
    expect(funnel.cells.map((c) => c.key)).not.toContain('contacts_on_call');
  });

  it('prefers a real counter over the subtraction the moment the API carries one', () => {
    // Forward-compatible: `contacts_on_call` is not on the payload today, but
    // it is the field that closes this properly, and it must win when it lands.
    const funnel = contactFunnel({
      ...reconciling(),
      contacts_on_call: 3,
    } as AgencyCampaignStats & { contacts_on_call: number });

    const onCall = funnel.cells.find((c) => c.key === 'contacts_on_call')!;
    expect(onCall.count).toBe(3);
    expect(onCall.derived).toBe(false);
  });

  it('does not state a derived figure as an observation', () => {
    const onCall = contactFunnel(reconciling()).cells
      .find((c) => c.key === 'contacts_on_call')!;

    // The plain hint asserts a fact ("Bridged to an agent right now"). While the
    // number is a subtraction, the hint must not.
    expect(onCall.hint).not.toBe('Bridged to an agent right now.');
    expect(onCall.hint).toMatch(/do not cover/);
    // And it must route the reader to the one place that can confirm it.
    expect(onCall.hint).toMatch(/Contacts tab/);
  });

  it('reads as an observation once it is one', () => {
    const onCall = contactFunnel({
      ...reconciling(),
      contacts_on_call: 3,
    } as AgencyCampaignStats & { contacts_on_call: number })
      .cells.find((c) => c.key === 'contacts_on_call')!;

    expect(onCall.hint).toBe('Bridged to an agent right now.');
  });

  describe('the note beneath the funnel', () => {
    it('says nothing while the campaign is running — being on a call is the point', () => {
      expect(onCallNote(contactFunnel(reconciling()), null)).toBeNull();
    });

    it('names the contradiction on a campaign that was stopped', () => {
      const note = onCallNote(contactFunnel(reconciling()), 'stopped');

      expect(note).not.toBeNull();
      expect(note!).toContain('3 contacts are');
      expect(note!).toMatch(/stopped/);
      // It reports the fact and who can act; it does not guess the cause.
      expect(note!).toMatch(/Support/);
      expect(note!).not.toMatch(/lease|stale|bug|reaper/i);
    });

    it('does not tell a completed campaign that it stopped', () => {
      /*
        The bug the `terminal` boolean bought. `completed` and `stopped` are
        different events everywhere else in this file — `campaignTimeline`,
        `howItEndedLines` — and this note sits a couple of inches under a badge
        that says which one happened. A boolean made it say "stopped" under a
        badge reading **Completed**.
      */
      const note = onCallNote(contactFunnel(reconciling()), 'completed');

      expect(note).not.toBeNull();
      expect(note!).toContain('3 contacts are');
      expect(note!).not.toMatch(/stopp/i);
      expect(note!).toMatch(/finished/);
      expect(note!).toMatch(/Support/);
    });

    it('does not claim the calls have ended', () => {
      /*
        It used to add "The calls themselves have ended." — true of the three
        production rows it was written for, unknowable from here, and reachable
        as a falsehood: stopping a campaign stops NEW dials and lets live calls
        finish, so for the first minutes after a stop the sentence contradicts a
        perfectly ordinary floor.

        This function reads a derived remainder. It reads no `attempts_live`, no
        attempt state and no talk time, so it may not speak about the calls at
        all — only about how the contacts are MARKED.
      */
      for (const ending of ['stopped', 'completed'] as const) {
        const note = onCallNote(contactFunnel(reconciling()), ending)!;

        expect(note).toMatch(/still marked as being on a call/);
        expect(note).not.toMatch(/calls (themselves )?have ended/i);
        expect(note).not.toMatch(/the calls/i);
      }
    });

    it('agrees with itself about one contact', () => {
      const note = onCallNote(contactFunnel(reconciling({ contacts_pending: 4 })), 'stopped');
      expect(note).toContain('1 contact is');
    });

    it('says nothing when the buckets reconcile', () => {
      expect(onCallNote(contactFunnel(reconciling({ contacts_pending: 5 })), 'stopped')).toBeNull();
    });

    it('says nothing when the remainder is unknowable', () => {
      // A missing counter must not become a fault report about stuck contacts.
      const funnel = contactFunnel(reconciling({ contacts_exhausted: undefined }));
      expect(onCallNote(funnel, 'stopped')).toBeNull();
    });
  });

  it('names what a measured count does not explain', () => {
    /*
      The invariant the panel now claims: every contact is in a listed cell or in
      `unaccounted`. Summing only the five would break it the moment the API carries
      `contacts_on_call` and disagrees with the residual — sending 2 where the
      five leave 3 would report 3 unaccounted beside a cell reading 2, and the
      genuinely unexplained 1 would go unnamed.
    */
    const funnel = contactFunnel({
      ...reconciling(),
      contacts_on_call: 2,
    } as AgencyCampaignStats & { contacts_on_call: number });

    const onCall = funnel.cells.find((c) => c.key === 'contacts_on_call')!;
    expect(onCall.count).toBe(2);
    expect(onCall.derived).toBe(false);
    // 36 total − (0+0+2+23+8 counted) − 2 measured on-call = 1 still unexplained.
    expect(funnel.unaccounted).toBe(1);
    expect(funnel.reconciles).toBe(true);
  });

  it('treats a measured count that overshoots the total as incoherent', () => {
    const funnel = contactFunnel({
      ...reconciling(),
      contacts_on_call: 10,
    } as AgencyCampaignStats & { contacts_on_call: number });

    expect(funnel.reconciles).toBe(false);
    expect(funnel.unaccounted).toBeNull();
    expect(funnel.segments).toEqual([]);
  });

  it('keeps a measured zero, unlike a derived one', () => {
    // Once it is a reading, "no contact is on a call" is a fact worth printing.
    const funnel = contactFunnel({
      ...reconciling({ contacts_pending: 5 }),
      contacts_on_call: 0,
    } as AgencyCampaignStats & { contacts_on_call: number });

    const onCall = funnel.cells.find((c) => c.key === 'contacts_on_call')!;
    expect(onCall.count).toBe(0);
    expect(onCall.value).toBe('0');
    expect(onCall.derived).toBe(false);
    // A real zero is still not drawn on the bar — there is nothing to see.
    expect(funnel.segments.map((s) => s.key)).not.toContain('contacts_on_call');
  });
});

describe('the retries note', () => {
  it('names the count and what it means for the waiting state', () => {
    expect(retriesNote(stats({ retries_pending: 287 })))
      .toBe('287 of the waiting contacts are queued retries — scheduled for a later attempt, '
        + 'possibly hours away.');
  });

  it('says nothing when there is nothing queued, and nothing when it did not load', () => {
    expect(retriesNote(stats({ retries_pending: 0 }))).toBeNull();
    expect(retriesNote(stats({ retries_pending: undefined }))).toBeNull();
    expect(retriesNote(null)).toBeNull();
  });
});

describe('the list-worked ring', () => {
  it('counts the three states nothing dials again', () => {
    // 550 + 20 + 27 of 1000.
    const ring = listWorkedRing(stats());

    expect(ring.known).toBe(true);
    expect(ring.percent).toBeCloseTo(59.7, 5);
    expect(ring.label).toBe('60%');
    expect(ring.caption).toBe('597 of 1,000 contacts');
    const [dash] = ring.dashArray.split(' ');
    expect(Number(dash)).toBeCloseTo(RING_CIRCUMFERENCE * 0.597, 0);
  });

  it('refuses to draw an arc from an incomplete payload', () => {
    // Two of three components is a ring that understates the campaign by an
    // unknowable amount while looking exactly as authoritative as a whole one.
    const ring = listWorkedRing(stats({ contacts_suppressed: undefined }));

    expect(ring.known).toBe(false);
    expect(ring.percent).toBeNull();
    expect(ring.label).toBe('—');
    expect(ring.dashArray.startsWith('0 ')).toBe(true);
  });

  it('says there is no list rather than reporting 0% worked', () => {
    const ring = listWorkedRing(stats({
      contacts_total: 0,
      contacts_completed: 0,
      contacts_suppressed: 0,
      contacts_exhausted: 0,
    }));

    expect(ring.known).toBe(false);
    expect(ring.label).toBe('—');
    expect(ring.caption).toBe('No contacts have been added to this campaign yet.');
  });

  it('has nothing to say without a payload', () => {
    expect(listWorkedRing(null).caption).toBe('The contact counts didn’t load.');
  });
});

describe('the pulse strip', () => {
  it('attaches each rate to the cell holding its own numerator, named', () => {
    const pulse = pulseFigures(stats());

    expect(pulse.dials.value).toBe('1,400');
    // `connect_rate_pct` counts human connects, which is the cell BELOW this
    // one. Pairing it with `attempts_connected` would invite the reader to
    // divide the two and arrive at a third, wrong figure.
    expect(pulse.reached.value).toBe('610');
    expect(pulse.reached.sub).toBeNull();

    expect(pulse.humans.value).toBe('500');
    expect(pulse.humans.sub).toBe('35.7% of dials placed');

    expect(pulse.wins.value).toBe('120');
    // Measured against connected calls, not against dials — the two rates on
    // this payload have different denominators, so each names its own.
    expect(pulse.wins.sub).toBe('19.7% of calls that reached someone');
  });

  it('drops a rate’s sub-line when the API has nothing to measure — never 0%', () => {
    const pulse = pulseFigures(stats({ connect_rate_pct: null, success_rate_pct: null }));

    expect(pulse.humans.sub).toBeNull();
    expect(pulse.wins.sub).toBeNull();
    // The counts beside them are unaffected: a null rate says nothing about
    // whether the numbers above it arrived.
    expect(pulse.humans.known).toBe(true);
    expect(pulse.wins.value).toBe('120');
  });

  it('drops a rate’s sub-line when the field did not arrive at all', () => {
    const pulse = pulseFigures(stats({ connect_rate_pct: undefined, success_rate_pct: undefined }));

    expect(pulse.humans.sub).toBeNull();
    expect(pulse.wins.sub).toBeNull();
  });

  it('renders every absent number as a dash and marks it unknown', () => {
    const pulse = pulseFigures(null);

    for (const figure of [pulse.dials, pulse.reached, pulse.humans, pulse.wins, pulse.live]) {
      expect(figure.value).toBe('—');
      expect(figure.known).toBe(false);
      expect(figure.sub).toBeNull();
    }
  });

  it('keeps a measured zero as a zero', () => {
    const pulse = pulseFigures(stats({ attempts_success: 0, attempts_live: 0 }));

    expect(pulse.wins.value).toBe('0');
    expect(pulse.wins.known).toBe(true);
    expect(pulse.live.value).toBe('0');
  });

  it('puts the floor behind the live-calls figure', () => {
    const pulse = pulseFigures(stats({
      agents_by_state: {
        offline: 4, available: 3, reserved: 0, on_call: 4, wrapup: 1, break: 1,
      },
    }));

    expect(pulse.live.sub).toBe('9 agents on shift · 3 free');
  });
});

describe('the floor summary', () => {
  it('excludes signed-out agents from the shift', () => {
    const floor = floorSummary(stats({
      agents_by_state: {
        offline: 12, available: 3, reserved: 0, on_call: 4, wrapup: 1, break: 1,
      },
    }));

    // 4 + 1 + 0 + 3 + 1. An agent who logged out at 17:00 was not on shift at
    // 18:00 — the same rule the API's `shift_seconds` applies.
    expect(floor.onShift).toBe(9);
    expect(floor.slices.map((s) => s.state)).toEqual(['on_call', 'wrapup', 'available', 'break']);
    expect(floor.slices[0]!.label).toBe('On a call');
    expect(floor.slices[0]!.percent).toBeCloseTo((4 / 9) * 100, 5);
  });

  it('falls back to the aggregate when no breakdown was served, and draws no bar', () => {
    const floor = floorSummary(stats({ agents_by_state: undefined, agents_live: 4 }));

    expect(floor.known).toBe(true);
    expect(floor.onShiftLabel).toBe('4');
    expect(floor.slices).toEqual([]);
    // No "free" claim: `agents_live` cannot answer who is available, and
    // guessing is how a supervisor concludes the floor has spare capacity.
    expect(floor.shiftSub).toBe('4 agents on shift');
  });

  it('reports an unread floor as unknown rather than as an empty one', () => {
    const floor = floorSummary(stats({ agents_by_state: undefined, agents_live: undefined }));

    expect(floor.known).toBe(false);
    expect(floor.onShift).toBeNull();
    expect(floor.onShiftLabel).toBe('—');
    expect(floor.shiftSub).toBeNull();
  });

  it('says "1 agent", not "1 agents"', () => {
    const floor = floorSummary(stats({
      agents_by_state: {
        offline: 0, available: 0, reserved: 0, on_call: 1, wrapup: 0, break: 0,
      },
    }));

    expect(floor.shiftSub).toBe('1 agent on shift · 0 free');
  });
});

describe('how it ran', () => {
  function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
    return { id: 'c1', name: 'Collections', status: 'stopped', ...over };
  }

  it('states the window, the timezone and the wrap-up allowance', () => {
    const lines = howItRanLines(campaign({
      calling_window_start: '09:00',
      calling_window_end: '18:00',
      default_timezone: 'Asia/Kolkata',
      wrapup_seconds: 45,
    }));

    expect(lines).toEqual([
      { label: 'Calling window', value: '09:00–18:00' },
      { label: 'Timezone', value: 'Asia/Kolkata' },
      { label: 'Wrap-up allowed', value: '45 seconds' },
    ]);
  });

  it('omits a line whose field is absent rather than dashing it', () => {
    // A campaign genuinely may set no calling window. "Calling window —" reads
    // as a failed read, when the truth is "it dials at any hour".
    expect(howItRanLines(campaign({ default_timezone: 'UTC' })))
      .toEqual([{ label: 'Timezone', value: 'UTC' }]);
    // Half a window is not a window.
    expect(howItRanLines(campaign({ calling_window_start: '09:00' }))).toEqual([]);
    expect(howItRanLines(campaign())).toEqual([]);
    expect(howItRanLines(null)).toEqual([]);
  });

  it('keeps a zero wrap-up as a real setting', () => {
    expect(howItRanLines(campaign({ wrapup_seconds: 0 })))
      .toEqual([{ label: 'Wrap-up allowed', value: 'None' }]);
    expect(howItRanLines(campaign({ wrapup_seconds: 90 }))[0]!.value).toBe('1.5 minutes');
    expect(howItRanLines(campaign({ wrapup_seconds: 60 }))[0]!.value).toBe('1 minute');
  });
});

/*
  The Overview strip and the Performance cards must never disagree about
  whether a campaign has enough dials for a percentage to be publishable. They
  are different modules read one tab apart, so the rule is shared rather than
  duplicated — these pin that it stays shared.
*/
describe('pulse rates honour the shared low-volume threshold', () => {
  it('drops both rate sub-lines below the threshold, rather than printing them', () => {
    const few = pulseFigures(stats({
      attempts_total: RATE_MIN_ATTEMPTS - 1,
      attempts_connected: 3,
      human_connects: 2,
      connect_rate_pct: 50,
      attempts_success: 0,
      success_rate_pct: 0,
    }));
    // The counts are observations and still render.
    expect(few.humans.value).toBe('2');
    expect(few.wins.value).toBe('0');
    // The percentages over them are not published at this volume.
    expect(few.humans.sub).toBeNull();
    expect(few.wins.sub).toBeNull();
  });

  it('publishes them at the threshold', () => {
    const enough = pulseFigures(stats({
      attempts_total: RATE_MIN_ATTEMPTS,
      attempts_connected: 12,
      human_connects: 8,
      connect_rate_pct: 32,
      attempts_success: 3,
      success_rate_pct: 25,
    }));
    expect(enough.humans.sub).toBe('32% of dials placed');
    expect(enough.wins.sub).toBe('25% of calls that reached someone');
  });

  it('agrees with the Performance section on every campaign, by construction', () => {
    for (const dials of [0, 1, RATE_MIN_ATTEMPTS - 1, RATE_MIN_ATTEMPTS, 4000]) {
      const s = stats({ attempts_total: dials, connect_rate_pct: 30, success_rate_pct: 20 });
      const overviewPublishes = pulseFigures(s).humans.sub !== null;
      expect(overviewPublishes).toBe(!ratesWithheld(s));
    }
  });

  it('still drops the line when the rate itself is null, above the threshold', () => {
    // `null` is "the API has nothing to measure" — never a 0%.
    const s = stats({ attempts_total: 4000, connect_rate_pct: null, success_rate_pct: null });
    expect(pulseFigures(s).humans.sub).toBeNull();
    expect(pulseFigures(s).wins.sub).toBeNull();
  });
});

/*
  ── The campaign's own clock ────────────────────────────────────

  `started_at`, `ended_at` and `last_transition_by` are what let a TERMINAL
  campaign say anything about itself, and a terminal campaign is the primary
  case for this workspace. All three are optional-and-nullable on the wire, so
  the failures worth pinning are the ones that read as facts: a duration that
  came out negative because two services stamped two clocks, an automatic
  pause attributed to nobody at all, and a "Agents who worked it: 0" on a
  campaign the API never measured.
*/

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('campaignRunLength', () => {
  it('reads seconds below a minute, and never a negative one', () => {
    expect(campaignRunLength(0)).toBe('0 seconds');
    expect(campaignRunLength(1)).toBe('1 second');
    expect(campaignRunLength(59)).toBe('59 seconds');
    // A clock skew between two services is enough to produce this. It is not a
    // duration, and "-4 seconds" is worse than a floor at zero.
    expect(campaignRunLength(-90)).toBe('0 seconds');
  });

  it('rounds to whole seconds rather than printing a fraction', () => {
    expect(campaignRunLength(1.6)).toBe('2 seconds');
  });

  it('steps up to minutes, then hours, then days', () => {
    expect(campaignRunLength(60)).toBe('1 minute');
    expect(campaignRunLength(3599)).toBe('59 minutes');
    expect(campaignRunLength(3600)).toBe('1 hour');
    expect(campaignRunLength(86_400)).toBe('1 day');
  });

  it('carries at most two components, largest first', () => {
    expect(campaignRunLength(2 * 3600 + 3 * 60)).toBe('2 hours 3 minutes');
    expect(campaignRunLength(3 * 86_400 + 4 * 3600)).toBe('3 days 4 hours');
    /*
      Minutes are dropped once days are in play — a campaign is being given a
      magnitude, not read a clock, and "3 days 4 hours 12 minutes" is three
      figures where the reader wanted one.
    */
    expect(campaignRunLength(3 * 86_400 + 4 * 3600 + 12 * 60)).toBe('3 days 4 hours');
  });

  it('drops a zero component rather than padding it', () => {
    expect(campaignRunLength(3 * 86_400)).toBe('3 days');
    expect(campaignRunLength(3 * 86_400 + 59)).toBe('3 days');
    expect(campaignRunLength(5 * 3600)).toBe('5 hours');
  });

  it('says “1 day”, not “1 days”', () => {
    expect(campaignRunLength(86_400)).toBe('1 day');
    expect(campaignRunLength(2 * 86_400)).toBe('2 days');
    expect(campaignRunLength(3600 + 60)).toBe('1 hour 1 minute');
  });
});

describe('campaignTimeline', () => {
  const NOW = new Date('2026-08-14T18:30:00.000Z');

  function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
    return { id: 'c1', name: 'Collections', status: 'running', ...over };
  }

  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

  it('says nothing at all without a campaign', () => {
    const timeline = campaignTimeline(null, null, NOW);

    expect(timeline.started).toBeNull();
    expect(timeline.ran).toBeNull();
    expect(timeline.ended).toBeNull();
    expect(timeline.duration).toBeNull();
    expect(timeline.actor).toBeNull();
    expect(timeline.neverStarted).toBe(false);
  });

  it('drops the start line entirely when the field did not arrive', () => {
    // An older API. Not "Started —", which reads as a failed read.
    const timeline = campaignTimeline(campaign(), null, NOW);

    expect(timeline.started).toBeNull();
    expect(timeline.ran).toBeNull();
    expect(timeline.neverStarted).toBe(false);
  });

  it('counts a live campaign forward, in the present tense', () => {
    const timeline = campaignTimeline(campaign({ started_at: iso(-6 * HOUR) }), null, NOW);

    expect(timeline.started).toMatch(/^Started .+/);
    expect(timeline.ran).toBe('Running for 6 hours');
    expect(timeline.duration).toBe('6 hours');
    // Nothing has ended, so nothing says it has — beside a live Stop button.
    expect(timeline.ended).toBeNull();
    expect(timeline.endedStamp).toBeNull();
  });

  it('closes the clock on a terminal campaign, in the past tense', () => {
    const timeline = campaignTimeline(
      campaign({
        status: 'stopped',
        started_at: iso(-(3 * DAY + 4 * HOUR)),
        ended_at: iso(0),
      }),
      'stopped',
      NOW,
    );

    expect(timeline.ran).toBe('Ran for 3 days 4 hours');
    expect(timeline.duration).toBe('3 days 4 hours');
    expect(timeline.ended).toMatch(/^Stopped .+/);
    expect(timeline.endedStamp).not.toBeNull();
    // `now` is not consulted once there is an end: a campaign that stopped last
    // month must not grow another month of runtime while the page is open.
    expect(timeline.ran).toBe(
      campaignTimeline(
        campaign({
          status: 'stopped',
          started_at: iso(-(3 * DAY + 4 * HOUR)),
          ended_at: iso(0),
        }),
        'stopped',
        new Date(NOW.getTime() + 30 * DAY),
      ).ran,
    );
  });

  it('drops a backwards duration but keeps both stamps', () => {
    /*
      Two services stamping two clocks is enough to produce an end before a
      start. "Ran for -4 hours" is a number nobody can act on; the two instants
      are still facts and stay.
    */
    const timeline = campaignTimeline(
      campaign({ status: 'stopped', started_at: iso(0), ended_at: iso(-4 * HOUR) }),
      'stopped',
      NOW,
    );

    expect(timeline.duration).toBeNull();
    expect(timeline.ran).toBeNull();
    expect(timeline.started).toMatch(/^Started .+/);
    expect(timeline.ended).toMatch(/^Stopped .+/);
  });

  it('names a person, and names the dialer when there was none', () => {
    const by = (last: AgencyCampaign['last_transition_by']) =>
      campaignTimeline(campaign({ status: 'stopped', last_transition_by: last }), 'stopped', NOW).actor;

    expect(by({ user_id: 'usr-1', name: 'Priya Sharma' })).toBe('Priya Sharma');
    /*
      `null` is the API saying nobody did this — the abandonment auto-pause. On a
      campaign that stopped itself that is the single most useful sentence on
      the page, so it is said rather than dropped.
    */
    expect(by(null)).toBe('Automatically');
    // `undefined` is an older API carrying no such field. This console then
    // has nothing to say either way, so it says nothing.
    expect(by(undefined)).toBeNull();
  });

  it('attributes nothing on a campaign that has not finished', () => {
    // `last_transition_by` describes the CURRENT status, which on a live
    // campaign is "running" — "Stopped by Priya" above a Pause button is a
    // sentence that contradicts the page.
    const timeline = campaignTimeline(
      campaign({ last_transition_by: { user_id: 'usr-1', name: 'Priya Sharma' } }),
      null,
      NOW,
    );

    expect(timeline.actor).toBeNull();
  });

  it('flags “never started” only on a terminal campaign that explicitly did not', () => {
    expect(campaignTimeline(campaign({ status: 'stopped', started_at: null }), 'stopped', NOW)
      .neverStarted).toBe(true);
    // Live and not yet dialing is not the same claim — it may start in a minute.
    expect(campaignTimeline(campaign({ status: 'draft', started_at: null }), null, NOW)
      .neverStarted).toBe(false);
    // Absent is "we were not told", never "it never happened".
    expect(campaignTimeline(campaign({ status: 'stopped' }), 'stopped', NOW)
      .neverStarted).toBe(false);
  });
});

describe('howItEndedLines', () => {
  const NOW = new Date('2026-08-14T18:30:00.000Z');

  function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
    return { id: 'c1', name: 'Collections', status: 'stopped', ...over };
  }

  const stopped = campaign({
    started_at: new Date(NOW.getTime() - (3 * DAY + 4 * HOUR)).toISOString(),
    ended_at: NOW.toISOString(),
    last_transition_by: { user_id: 'usr-1', name: 'Priya Sharma' },
  });

  it('reads how long, then when, then who, then the floor', () => {
    const lines = howItEndedLines(stopped, stats({ agents_peak: 4 }), 'stopped', NOW);

    expect(lines.map((line) => line.label)).toEqual([
      'Ran for',
      'Stopped',
      'Stopped by',
      'Agents who worked it',
    ]);
    expect(lines[0]!.value).toBe('3 days 4 hours');
    expect(lines[2]!.value).toBe('Priya Sharma');
    expect(lines[3]!.value).toBe('4');
  });

  it('says “Automatically” when the dialer stopped it', () => {
    const lines = howItEndedLines(campaign({ ...stopped, last_transition_by: null }), null, 'stopped', NOW);

    expect(lines.find((line) => line.label === 'Stopped by')!.value).toBe('Automatically');
  });

  it('says the campaign never started, rather than that it ran for no time', () => {
    const lines = howItEndedLines(
      campaign({ status: 'stopped', started_at: null, ended_at: NOW.toISOString() }),
      null,
      'stopped',
      NOW,
    );

    // The LABEL carries the subject, so the value can be the answer: "Ran for —
    // Never started" is not a sentence.
    expect(lines[0]).toEqual({ label: 'Dialing', value: 'Never started' });
  });

  it('drops the peak when the API did not measure it, and keeps a measured zero', () => {
    const peak = (value: number | null | undefined) =>
      howItEndedLines(stopped, stats({ agents_peak: value }), 'stopped', NOW)
        .find((line) => line.label === 'Agents who worked it');

    /*
      A stopped campaign's live floor is always empty, so `agents_live` can
      never answer "was anyone ever on this". `null` is the API saying it did not
      measure — an older API, or a campaign predating the agent event log —
      and rendering that as `0` would assert nobody worked the campaign.
    */
    expect(peak(null)).toBeUndefined();
    expect(peak(undefined)).toBeUndefined();
    // A measured zero is the finding this line exists for, so it is said in
    // words rather than shown as a digit that reads like a missing value.
    expect(peak(0)!.value).toBe('None');
    expect(peak(1)!.value).toBe('1');
  });

  it('returns nothing at all when nothing is known, so the block is skipped', () => {
    expect(howItEndedLines(campaign(), null, 'stopped', NOW)).toEqual([]);
    expect(howItEndedLines(null, null, 'stopped', NOW)).toEqual([]);
    // A stats payload with no peak on it adds no line of its own either.
    expect(howItEndedLines(campaign(), stats({ agents_peak: undefined }), 'stopped', NOW)).toEqual([]);
  });
});

/*
  ── "including 1,922 retries" ───────────────────────────────────────────────

  `attempts_total` silently includes retries, so "6,742 dials" against a
  2,100-contact list invites a reconciliation ("the list was dialled three times
  over") that is wrong. The sub-line is the reconciliation, and every way of
  NOT having one is a separate rule.
*/
describe('the retries sub-line under the dial count', () => {
  it('states the retries included in the dial count', () => {
    /*
      The digits are grouped by `toLocaleString`, so the expectation is built
      from the same call rather than written as `1,922`: this suite pins `TZ`
      but not a locale, and a literal here passes on an en-* machine and fails
      on a de-DE one over a difference the sub-line is not about. What IS under
      test is the wording, the plural and that the number quoted is the RETRY
      count — none of which the formatter can supply.
    */
    expect(pulseFigures(stats({ attempts_total: 6742, attempts_retried: 1922 })).dials.sub)
      .toBe(`including ${(1922).toLocaleString()} retries`);
  });

  it('says “1 retry”, not “1 retries”', () => {
    expect(pulseFigures(stats({ attempts_total: 20, attempts_retried: 1 })).dials.sub)
      .toBe('including 1 retry');
  });

  it('says nothing when nothing was retried', () => {
    // A real `0`, and a rule about usefulness rather than honesty: "including 0
    // retries" costs a read and settles a question nobody asked.
    expect(pulseFigures(stats({ attempts_retried: 0 })).dials.sub).toBeNull();
  });

  it('says nothing when the field did not arrive', () => {
    // Nice-to-have on this payload, and there is nothing to fall back on:
    // `retries_pending` counts what is QUEUED, a different population.
    expect(pulseFigures(stats({ attempts_retried: undefined })).dials.sub).toBeNull();
    expect(pulseFigures(null).dials.sub).toBeNull();
  });

  it('says nothing rather than more retries than dials', () => {
    // Not a number the API can produce, but one a mid-deploy pairing of two
    // versions can: "including 8,000 retries" under "6,742 dials" is a screen
    // nobody can act on.
    expect(pulseFigures(stats({ attempts_total: 6742, attempts_retried: 8000 })).dials.sub)
      .toBeNull();
  });

  it('leaves the dial COUNT itself untouched either way', () => {
    // Same reason as above for the grouping. The claim is that the sub-line is
    // additive — it explains the dial count without editing it.
    const dials = (6742).toLocaleString();
    expect(pulseFigures(stats({ attempts_total: 6742, attempts_retried: 1922 })).dials.value)
      .toBe(dials);
    expect(pulseFigures(stats({ attempts_total: 6742 })).dials.value).toBe(dials);
  });
});

/*
  ── The success case, found in review ───────────────────────────────────────
  Everything behind the old `terminal` boolean was worded for `stopped`, so a
  campaign that ran its whole list was told "Stopped by: Automatically" under a
  badge reading "Completed".
*/
describe('a completed campaign is not a stopped one', () => {
  // Its own fixtures: the helpers above are scoped to their describe blocks.
  const NOW = new Date('2026-08-14T18:30:00.000Z');
  const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
  const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign =>
    ({ id: 'c1', name: 'Collections', status: 'running', ...over });

  const finished = campaign({
    status: 'completed',
    started_at: iso(-(2 * DAY)),
    ended_at: iso(-HOUR),
    last_transition_by: null,
  });

  it('says it finished, not that it was stopped', () => {
    const timeline = campaignTimeline(finished, 'completed', NOW);
    expect(timeline.ended).toMatch(/^Finished /);
    expect(timeline.ended).not.toMatch(/^Stopped /);
  });

  it('names NOBODY as its ender, because nobody ended it', () => {
    /*
      `last_transition_by: null` means "no human did this", which on a STOPPED
      campaign is the most useful sentence on the page (the abandonment
      auto-pause). On a completed one it is a fabrication: it ran out of list.
      "Automatically" is the specific fabrication that reads as a fault.
    */
    expect(campaignTimeline(finished, 'completed', NOW).actor).toBeNull();
    const lines = howItEndedLines(finished, null, 'completed', NOW);
    expect(lines.map((line) => line.label)).not.toContain('Stopped by');
    expect(lines.map((line) => line.label)).toContain('Finished');
    expect(JSON.stringify(lines)).not.toContain('Automatically');
  });

  it('still names the ender on a campaign somebody really did stop', () => {
    // The other side of the guard: the `stopped` arm is unchanged.
    const stopped = campaign({
      status: 'stopped',
      started_at: iso(-(2 * DAY)),
      ended_at: iso(-HOUR),
      last_transition_by: null,
    });
    const lines = howItEndedLines(stopped, null, 'stopped', NOW);
    expect(lines.find((line) => line.label === 'Stopped by')?.value).toBe('Automatically');
  });
});

/*
  ── Guards that existed but nothing exercised ───────────────────────────────
  Each of these was proved by a QA mutation that left the suite green.
*/
describe('inconsistent and unparseable payloads', () => {
  const NOW = new Date('2026-08-27T15:30:00.000Z');
  const campaign = (over: Partial<AgencyCampaign> = {}): AgencyCampaign =>
    ({ id: 'c1', name: 'Collections', status: 'running', ...over });

  it('refuses to draw a ring past 100%, rather than clamping only the arc', () => {
    /*
      The arc was clamped and the NUMBER was not, so a payload assembled from two
      reads drew a full circle captioned "160%" and "16 of 10 contacts". A
      percentage over 100 is not a rounding error — one of the four counts is
      from a different moment — so nothing here is salvageable.
    */
    const ring = listWorkedRing({
      contacts_total: 10,
      contacts_completed: 8,
      contacts_suppressed: 5,
      contacts_exhausted: 3,
    } as never);

    expect(ring.known).toBe(false);
    expect(ring.label).not.toContain('160');
    expect(ring.caption).not.toContain('16 of 10');
    expect(ring.dashArray.startsWith('0 ')).toBe(true);
  });

  it('still draws an exactly-complete list', () => {
    // The boundary the guard must not eat: worked === total is 100%, not a
    // contradiction.
    const ring = listWorkedRing({
      contacts_total: 10,
      contacts_completed: 6,
      contacts_suppressed: 3,
      contacts_exhausted: 1,
    } as never);
    expect(ring.known).toBe(true);
    expect(ring.label).toBe('100%');
  });

  it('treats a start in the future as skew, not as a campaign of zero length', () => {
    // `campaignRunLength` clamped the negative to zero, so the header read
    // "Running for 0 seconds" on a campaign that had been dialing all morning.
    const timeline = campaignTimeline(
      campaign({ started_at: '2099-01-01T00:00:00.000Z' }),
      null,
      NOW,
    );
    expect(timeline.duration).toBeNull();
    expect(timeline.ran).toBeNull();
    // The stamp is still a fact and stays.
    expect(timeline.started).toMatch(/^Started /);
  });

  it('keeps a genuine zero-length campaign, which is a measurement', () => {
    const at = '2026-08-27T09:00:00.000Z';
    expect(
      campaignTimeline(campaign({ status: 'stopped', started_at: at, ended_at: at }), 'stopped', NOW)
        .duration,
    ).toBe('0 seconds');
  });

  it('renders nothing at all for an unparseable timestamp', () => {
    const timeline = campaignTimeline(
      campaign({ status: 'stopped', started_at: 'not-a-date', ended_at: '2026-13-45' }),
      'stopped',
      NOW,
    );
    expect(timeline.started).toBeNull();
    expect(timeline.endedStamp).toBeNull();
    expect(timeline.duration).toBeNull();
  });

  it('never renders the string "NaN"', () => {
    // `Math.round(NaN)` survives `Math.max(0, …)` and fell through every branch.
    expect(campaignRunLength(Number.NaN)).not.toContain('NaN');
    expect(campaignRunLength(Number.POSITIVE_INFINITY)).not.toContain('Infinity');
  });

  it('dates an old campaign with its year, and a current one without', () => {
    /*
      "How it ended" exists for campaigns that finished months ago, so this is
      the one screen where the year matters most — and "Stopped 18 Jan" is
      indistinguishable from last January's.
    */
    const old = campaignTimeline(
      campaign({
        status: 'stopped',
        started_at: '2025-01-15T09:00:00.000Z',
        ended_at: '2025-01-18T09:00:00.000Z',
      }),
      'stopped',
      NOW,
    );
    expect(old.endedStamp).toContain('2025');

    const thisYear = campaignTimeline(
      campaign({
        status: 'stopped',
        started_at: '2026-08-20T09:00:00.000Z',
        ended_at: '2026-08-21T09:00:00.000Z',
      }),
      'stopped',
      NOW,
    );
    // A redundant "2026" on every live campaign's header is the commoner read.
    expect(thisYear.endedStamp).not.toContain('2026');
  });
});

describe('the tense follows the status, not "is it terminal?"', () => {
  const NOW = new Date('2026-08-14T18:30:00.000Z');
  const HOURS_6 = 6 * 60 * 60 * 1000;
  const started = new Date(NOW.getTime() - HOURS_6).toISOString();
  const campaign = (status: string): AgencyCampaign =>
    ({ id: 'c1', name: 'Collections', status, started_at: started });

  it('does not tell a PAUSED campaign it is running', () => {
    /*
      "Running for 6 hours" beside a Paused badge and a Resume button is the same
      tense-contradicts-the-control failure `PAUSE_IN_FLIGHT_NOTE` prevents one
      row higher up — and the clock genuinely is not running on a paused
      campaign.
    */
    const ran = campaignTimeline(campaign('paused'), null, NOW).ran;
    expect(ran).not.toContain('Running for');
    expect(ran).toContain('6 hours');
  });

  it('does not tell a STOPPING campaign it is running either', () => {
    expect(campaignTimeline(campaign('stopping'), null, NOW).ran).not.toContain('Running for');
  });

  it('still says "Running for" on a campaign that really is dialing', () => {
    expect(campaignTimeline(campaign('running'), null, NOW).ran).toBe('Running for 6 hours');
  });

  it('still says "Ran for" once it has ended', () => {
    // A finished campaign needs its `ended_at` to have a duration at all — `now`
    // is not consulted once it is over, which is its own pinned rule above.
    const finished = (status: string): AgencyCampaign =>
      ({ ...campaign(status), ended_at: NOW.toISOString() });
    expect(campaignTimeline(finished('stopped'), 'stopped', NOW).ran).toBe('Ran for 6 hours');
    expect(campaignTimeline(finished('completed'), 'completed', NOW).ran).toBe('Ran for 6 hours');
  });
});

describe('funnelBarWithheldNote', () => {
  it('says nothing when there is a bar to draw', () => {
    expect(funnelBarWithheldNote(contactFunnel(stats()))).toBeNull();
  });

  it('separates a failed read from an empty campaign', () => {
    // These two were the page's own inline ternary and must not blur: one is a
    // statement about our knowledge, the other about the campaign.
    expect(funnelBarWithheldNote(contactFunnel(null))).toMatch(/didn’t load/);
    expect(
      funnelBarWithheldNote(contactFunnel(stats({
        contacts_total: 0,
        contacts_pending: 0,
        contacts_in_flight: 0,
        contacts_completed: 0,
        contacts_suppressed: 0,
        contacts_exhausted: 0,
      }))),
    ).toMatch(/No contacts have been added/);
  });

  it('does not attribute an entire uninitialised list to "on a call"', () => {
    /*
      Found by writing this test, not by reading the code.

      Every counted bucket a real `0` against 500 contacts means the five
      counters have said nothing about where any contact is — and subtracting
      anyway put all 500 in "On a call" at 100%, which no concurrency limit in
      the product can produce and which reads as a measurement. A real campaign
      in that state has its contacts in `contacts_pending`, so the payload is
      uninitialised rather than a floor mid-conversation.
    */
    const funnel = contactFunnel(stats({
      contacts_total: 500,
      contacts_pending: 0,
      contacts_in_flight: 0,
      contacts_completed: 0,
      contacts_suppressed: 0,
      contacts_exhausted: 0,
    }));

    expect(funnel.unaccounted).toBeNull();
    expect(funnel.cells.map((c) => c.key)).not.toContain('contacts_on_call');
    expect(funnel.segments).toEqual([]);
    // And the sentence in place of the bar does not turn the withheld
    // subtraction into a claim that the 500 got nowhere.
    const note = funnelBarWithheldNote(funnel)!;
    expect(note).not.toMatch(/has reached any of these states/);
    expect(note).toContain('500');
    expect(note).toMatch(/Reload/);
  });

  it('does not report a missing counter as nobody having got anywhere', () => {
    /*
      The module's own opening rule, broken by the sentence that reports it.

      `contacts_pending` absent with every counter that DID arrive at zero draws
      no segments — and the old copy read "No contact has reached any of these
      states yet", which is a confident claim about 500 people whose bucket is
      the one that did not load. `contacts_pending` is both the likeliest field
      to be missing and the likeliest to hold the whole roster.
    */
    const funnel = contactFunnel(stats({
      contacts_total: 500,
      contacts_pending: undefined,
      contacts_in_flight: 0,
      contacts_completed: 0,
      contacts_suppressed: 0,
      contacts_exhausted: 0,
    }));

    expect(funnel.segments).toEqual([]);
    const note = funnelBarWithheldNote(funnel)!;
    expect(note).not.toMatch(/has reached any of these states/);
    expect(note).not.toMatch(/\bno contact\b/i);
    // It names the population it cannot place, which is the honest half.
    expect(note).toContain('500');
  });

  it('still reconciles a genuinely empty campaign', () => {
    // The boundary the guard must not eat: total 0 with five zeros is coherent,
    // and its remainder is a real 0 rather than unknowable.
    const funnel = contactFunnel(stats({
      contacts_total: 0,
      contacts_pending: 0,
      contacts_in_flight: 0,
      contacts_completed: 0,
      contacts_suppressed: 0,
      contacts_exhausted: 0,
    }));

    expect(funnel.reconciles).toBe(true);
    expect(funnel.unaccounted).toBe(0);
  });
});

describe('the funnel covers every state the roster can report', () => {
  /*
    `CONTACT_STATE_BUCKET` is typed `Record<AgencyContactState, ContactStateKey>`,
    so the COMPILER already refuses a seventh contact state that nobody has
    classified. What the compiler cannot check is the other direction: that the
    bucket each state is mapped to is one the funnel actually declares, and that
    the funnel declares no bucket no state can reach.

    Both halves are how the original drift happened — two lists in one repo,
    keyed differently (`connected` vs `contacts_*`), with nothing tying them
    together.
  */
  it('maps every contact state to a bucket the funnel declares', () => {
    const declared = new Set(CONTACT_FUNNEL_STATES.map((state) => state.key));

    for (const [state, bucket] of Object.entries(CONTACT_STATE_BUCKET)) {
      expect(declared.has(bucket), `${state} → ${bucket} is not a funnel bucket`).toBe(true);
    }
  });

  it('declares no bucket that no contact state can reach', () => {
    const reachable = new Set(Object.values(CONTACT_STATE_BUCKET));

    for (const state of CONTACT_FUNNEL_STATES) {
      expect(reachable.has(state.key), `${state.key} is a bucket nothing maps to`).toBe(true);
    }
  });

  it('gives each state its own bucket, so no two states are conflated', () => {
    // Six states, six buckets. If a future change points two states at one
    // bucket that may well be right, but it must be a decision rather than a
    // typo — the funnel's key would then name one and count two.
    const buckets = Object.values(CONTACT_STATE_BUCKET);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets).toHaveLength(CONTACT_FUNNEL_STATES.length);
  });
});
