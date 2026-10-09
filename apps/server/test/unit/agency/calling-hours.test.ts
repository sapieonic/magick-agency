import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Calling hours in the CONTACT's timezone.
//
// Every assertion here is an exact instant, never a range. An
// approximate assertion on a clock-derived value is how a doubled fake clock
// hid behind `toBeGreaterThan(0)`, and this module's whole output is a clock
// derivation. `now` is a parameter, so there is nothing to fake.
//
// The module is pure and holds only a per-zone `Intl.DateTimeFormat` cache
// keyed by zone string, so there is no cross-test state to tear down — hence no
// `afterEach`. That is a property of this file, not a general exemption.
//
// FALSIFICATION, per assertion group, recorded where it changed what the test
// asserts:
//  - customer-vs-campaign zone: making `resolveCallingWindow` always return the
//    campaign default turns the New York contact `open` at 01:00 local.
//  - the DST gap: returning the two-pass candidate without `snapForwardToOpen`
//    answers 2026-03-08T06:00Z, which is 01:00 local — an hour BEFORE the 02:00
//    window opens. That falsification is why the gap case exists at all; the
//    first draft of this file asserted only that the result was "in the future".
//  - `0` in calling_days: accepting it as Sunday makes the rejection case
//    `closed` instead of `unresolvable`, and a Sunday campaign silently runs.
//  - the 8-day horizon: capping the search at 7 offsets makes the single-weekday
//    case return null, which the gate would park rather than schedule.
// ---------------------------------------------------------------------------

import {
  callingWindowState,
  nextWindowOpen,
  resolveCallingWindow,
  isUsableTimezone,
  type CallingWindow,
} from '../../../src/agency/calling-hours.js';

/** Postgres renders a `TIME` column as `HH:MM:SS`; use that shape throughout. */
const IST_9_TO_8: CallingWindow = {
  start: '09:00:00', end: '20:00:00', days: [1, 2, 3, 4, 5], timezone: 'Asia/Kolkata',
};

const at = (iso: string): Date => new Date(iso);

// Anchors, verified against Intl rather than assumed:
//   2026-08-11T03:00Z = Tue 08:30 IST   2026-08-11T05:00Z = Tue 10:30 IST
//   2026-08-11T15:00Z = Tue 20:30 IST   2026-08-14T16:00Z = Fri 21:30 IST
//   2026-08-15T16:00Z = Sat 21:30 IST

describe('callingWindowState — the ordinary window', () => {
  it('is closed before the window opens and open inside it', () => {
    expect(callingWindowState(IST_9_TO_8, at('2026-08-11T03:00:00Z'))).toBe('closed');
    expect(callingWindowState(IST_9_TO_8, at('2026-08-11T05:00:00Z'))).toBe('open');
  });

  it('treats the closing time as exclusive', () => {
    // 20:00:00 IST exactly = 14:30Z. A window "until 20:00" that dials at 20:00
    // is a window until 20:01, and the boundary is the only place that shows.
    expect(callingWindowState(IST_9_TO_8, at('2026-08-11T14:29:59Z'))).toBe('open');
    expect(callingWindowState(IST_9_TO_8, at('2026-08-11T14:30:00Z'))).toBe('closed');
  });

  it('treats the opening time as inclusive', () => {
    expect(callingWindowState(IST_9_TO_8, at('2026-08-11T03:29:59Z'))).toBe('closed');
    expect(callingWindowState(IST_9_TO_8, at('2026-08-11T03:30:00Z'))).toBe('open');
  });

  it('is closed on a day outside calling_days even inside the hours', () => {
    // Sat 2026-08-15 12:30 IST — squarely inside 09:00–20:00, wrong day.
    expect(callingWindowState(IST_9_TO_8, at('2026-08-15T07:00:00Z'))).toBe('closed');
  });
});

describe('nextWindowOpen — the instant an unclaim writes to next_attempt_at', () => {
  it('returns today opening when the tick runs before it', () => {
    // Tue 08:30 IST → Tue 09:00 IST.
    expect(nextWindowOpen(IST_9_TO_8, at('2026-08-11T03:00:00Z'))?.toISOString())
      .toBe('2026-08-11T03:30:00.000Z');
  });

  it('rolls to tomorrow when today has closed', () => {
    // Tue 20:30 IST → Wed 09:00 IST. Strictly in the future is the point: with
    // today's already-past opening the contact is re-claimed on the next tick.
    const next = nextWindowOpen(IST_9_TO_8, at('2026-08-11T15:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-12T03:30:00.000Z');
    expect(next!.getTime()).toBeGreaterThan(at('2026-08-11T15:00:00Z').getTime());
  });

  it('skips the weekend from Friday night', () => {
    // Fri 21:30 IST → Mon 09:00 IST, not Sat.
    expect(nextWindowOpen(IST_9_TO_8, at('2026-08-14T16:00:00Z'))?.toISOString())
      .toBe('2026-08-17T03:30:00.000Z');
  });

  it('skips the weekend from inside the weekend', () => {
    // Sat 21:30 IST → Mon 09:00 IST.
    expect(nextWindowOpen(IST_9_TO_8, at('2026-08-15T16:00:00Z'))?.toISOString())
      .toBe('2026-08-17T03:30:00.000Z');
  });

  it('reaches a full week ahead for a single-weekday campaign', () => {
    // Tuesdays only, asked on Tuesday evening: the answer is 7 days out, which a
    // 7-offset search cannot see because offset 0 is already spent.
    const tuesdaysOnly = { ...IST_9_TO_8, days: [2] };
    expect(nextWindowOpen(tuesdaysOnly, at('2026-08-11T15:00:00Z'))?.toISOString())
      .toBe('2026-08-18T03:30:00.000Z');
  });

  it('always returns an instant the window is actually open at', () => {
    // The invariant behind every case above, asserted directly so a future
    // change to the search cannot satisfy the exact values by coincidence.
    for (const iso of [
      '2026-08-11T03:00:00Z', '2026-08-11T15:00:00Z',
      '2026-08-14T16:00:00Z', '2026-08-15T16:00:00Z',
    ]) {
      const next = nextWindowOpen(IST_9_TO_8, at(iso));
      expect(next).not.toBeNull();
      expect(callingWindowState(IST_9_TO_8, next!)).toBe('open');
    }
  });
});

describe('the contact timezone decides, not the campaign', () => {
  const CAMPAIGN = {
    calling_window_start: '09:00:00',
    calling_window_end: '20:00:00',
    calling_days: [1, 2, 3, 4, 5],
    default_timezone: 'Asia/Kolkata',
  };

  it('refuses a New York contact at 01:00 local while the campaign zone says 10:30', () => {
    // THE test for this ticket. 2026-08-11T05:00Z is 10:30 IST — mid-window —
    // and 01:00 in New York. An implementation that evaluated the campaign's
    // zone, or the server's, dials a real person at one in the morning and every
    // configuration screen still reads 09:00–20:00.
    const window = resolveCallingWindow(CAMPAIGN, { timezone: 'America/New_York' });
    expect(window.timezone).toBe('America/New_York');
    expect(window.timezoneSource).toBe('contact');
    expect(callingWindowState(window, at('2026-08-11T05:00:00Z'))).toBe('closed');

    // Same instant, same campaign, a contact in the campaign's own zone: open.
    // The pair is what shows the zone is doing the work rather than the clock.
    const local = resolveCallingWindow(CAMPAIGN, { timezone: null });
    expect(local.timezoneSource).toBe('campaign_default');
    expect(callingWindowState(local, at('2026-08-11T05:00:00Z'))).toBe('open');
  });

  it('defers the New York contact to 09:00 New York time, not 09:00 IST', () => {
    const window = resolveCallingWindow(CAMPAIGN, { timezone: 'America/New_York' });
    // Tue 09:00 EDT = 13:00Z. 09:00 IST would have been 03:30Z — six and a half
    // hours earlier, i.e. 23:30 the previous night for this customer.
    expect(nextWindowOpen(window, at('2026-08-11T05:00:00Z'))?.toISOString())
      .toBe('2026-08-11T13:00:00.000Z');
  });

  it('falls back to the campaign default for an unusable contact zone, and says so', () => {
    // Absent or unusable ⇒ the campaign default. An unparseable value from a
    // mapped CSV column is not an excuse to infer one from the phone number.
    const window = resolveCallingWindow(CAMPAIGN, { timezone: 'Mars/Olympus_Mons' });
    expect(window.timezone).toBe('Asia/Kolkata');
    expect(window.timezoneSource).toBe('campaign_default');
    // Flagged, because the alternative symptom is calls at the wrong local time
    // for one slice of a roster and nothing to grep for.
    expect(window.contactTimezoneRejected).toBe(true);
  });

  it('does not flag an absent contact zone as a rejection', () => {
    // The common case — no mapped column at all — must not look like bad data.
    expect(resolveCallingWindow(CAMPAIGN, { timezone: null }).contactTimezoneRejected).toBe(false);
    expect(resolveCallingWindow(CAMPAIGN, { timezone: '  ' }).contactTimezoneRejected).toBe(false);
  });

  it('reports unresolvable when the campaign default is unusable too', () => {
    // Nothing left to fall back to. `unresolvable`, never `open`.
    const window = resolveCallingWindow(
      { ...CAMPAIGN, default_timezone: 'Not/AZone' }, { timezone: null },
    );
    expect(callingWindowState(window, at('2026-08-11T05:00:00Z'))).toBe('unresolvable');
    expect(nextWindowOpen(window, at('2026-08-11T05:00:00Z'))).toBeNull();
  });

  it('refuses a bare abbreviation, because ICU resolves EST to America/Panama', () => {
    // Measured on this runtime: `new Intl.DateTimeFormat('en-US',{timeZone:'EST'})`
    // resolves to **America/Panama**, which observes no DST. Accepting it would
    // place every call an hour off for half the year, on the early side. The rule is that
    // an honest default beats an inferred zone that puts a call out of hours, so
    // the abbreviation is refused and the campaign default applies.
    expect(new Intl.DateTimeFormat('en-US', { timeZone: 'EST' }).resolvedOptions().timeZone)
      .toBe('America/Panama');

    for (const abbrev of ['EST', 'IST', 'GMT', 'EST5EDT']) {
      expect(isUsableTimezone(abbrev)).toBe(false);
      const window = resolveCallingWindow(CAMPAIGN, { timezone: abbrev });
      expect(window.timezone).toBe('Asia/Kolkata');
      expect(window.contactTimezoneRejected).toBe(true);
    }

    // The Area/Location form is what we do accept, plus bare UTC.
    expect(isUsableTimezone('America/New_York')).toBe(true);
    expect(isUsableTimezone('UTC')).toBe(true);
  });

  it('never throws on customer-supplied junk', () => {
    // A RangeError from Intl escaping into the pacing tick takes the campaign
    // down, not the contact. These are shapes a CSV column really produces.
    for (const junk of ['', '   ', 'UTC+5:30', 'IST', 'Asia/Kolkatta', '../../etc/passwd', '🙂']) {
      expect(isUsableTimezone(junk)).toBe(false);
      const w = { ...IST_9_TO_8, timezone: junk };
      expect(() => callingWindowState(w, at('2026-08-11T05:00:00Z'))).not.toThrow();
      expect(callingWindowState(w, at('2026-08-11T05:00:00Z'))).toBe('unresolvable');
      expect(nextWindowOpen(w, at('2026-08-11T05:00:00Z'))).toBeNull();
    }
  });
});

describe('calling_days is ISO-8601 and 0 is rejected', () => {
  it('reads 7 as Sunday', () => {
    const sundays = { ...IST_9_TO_8, days: [7] };
    // Sun 2026-08-16 12:30 IST = 07:00Z.
    expect(callingWindowState(sundays, at('2026-08-16T07:00:00Z'))).toBe('open');
    // Mon is not.
    expect(callingWindowState(sundays, at('2026-08-17T07:00:00Z'))).toBe('closed');
  });

  it('rejects 0 rather than reading it as Sunday', () => {
    // A caller sending 0 believes Postgres `dow`. Accepting it means we and they
    // disagree about which days the campaign runs, and the disagreement is
    // invisible until someone is called on a Sunday.
    const dowStyle = { ...IST_9_TO_8, days: [0, 1, 2, 3, 4, 5] };
    expect(callingWindowState(dowStyle, at('2026-08-16T07:00:00Z'))).toBe('unresolvable');
    expect(callingWindowState(dowStyle, at('2026-08-11T05:00:00Z'))).toBe('unresolvable');
    expect(nextWindowOpen(dowStyle, at('2026-08-11T05:00:00Z'))).toBeNull();
  });

  it('rejects out-of-range and non-integer members', () => {
    for (const days of [[8], [-1], [1.5], [1, 9]] as number[][]) {
      expect(callingWindowState({ ...IST_9_TO_8, days }, at('2026-08-11T05:00:00Z')))
        .toBe('unresolvable');
    }
  });

  it('treats an empty calling_days as no dialable day, not every day', () => {
    // The operator cleared the picker. Widening that to seven days dials a whole
    // roster on a misconfiguration; there is no next opening to defer to either.
    const none = { ...IST_9_TO_8, days: [] };
    expect(callingWindowState(none, at('2026-08-11T05:00:00Z'))).toBe('closed');
    expect(nextWindowOpen(none, at('2026-08-11T05:00:00Z'))).toBeNull();
  });
});

describe('degenerate and overnight windows', () => {
  it('treats start == end as an empty window, not a 24-hour one', () => {
    // Both readings fit the schema. Only this one declines to dial at 03:00
    // because someone typed the same time twice.
    const zero = { ...IST_9_TO_8, start: '09:00:00', end: '09:00:00' };
    expect(callingWindowState(zero, at('2026-08-11T05:00:00Z'))).toBe('closed');
    expect(callingWindowState(zero, at('2026-08-11T03:30:00Z'))).toBe('closed');
    expect(nextWindowOpen(zero, at('2026-08-11T05:00:00Z'))).toBeNull();
  });

  it('keeps an overnight window open across midnight', () => {
    // Fri 20:00 → Sat 02:00 IST, Fridays only. calling_days gates the day the
    // window OPENS; the small hours belong to the Friday that opened them.
    const overnight = { ...IST_9_TO_8, start: '20:00:00', end: '02:00:00', days: [5] };
    expect(callingWindowState(overnight, at('2026-08-14T15:30:00Z'))).toBe('open');  // Fri 21:00
    expect(callingWindowState(overnight, at('2026-08-14T19:30:00Z'))).toBe('open');  // Sat 01:00
    expect(callingWindowState(overnight, at('2026-08-14T20:30:00Z'))).toBe('closed'); // Sat 02:00
    expect(callingWindowState(overnight, at('2026-08-15T15:30:00Z'))).toBe('closed'); // Sat 21:00
  });

  it('schedules an overnight window to its next opening day', () => {
    const overnight = { ...IST_9_TO_8, start: '20:00:00', end: '02:00:00', days: [5] };
    // Sat 03:00 IST = 2026-08-14T21:30Z → next Friday 20:00 IST = 14:30Z.
    expect(nextWindowOpen(overnight, at('2026-08-14T21:30:00Z'))?.toISOString())
      .toBe('2026-08-21T14:30:00.000Z');
  });
});

describe('daylight saving', () => {
  // America/New_York, 2026-03-08: clocks jump 02:00 EST → 03:00 EDT, so local
  // 02:00–03:00 does not exist that day. Verified against Intl, not assumed.
  const NY_2_TO_6: CallingWindow = {
    start: '02:00:00', end: '06:00:00', days: [1, 2, 3, 4, 5, 6, 7], timezone: 'America/New_York',
  };

  it('opens a window at the transition when its opening time does not exist', () => {
    // now = 00:30 EST. The naive two-pass conversion of "02:00 local" lands on
    // 2026-03-08T06:00Z, which is 01:00 EST — an hour BEFORE the window opens,
    // and in the future, so a gate trusting it would dial. The right answer is
    // the transition itself, 03:00 EDT.
    const next = nextWindowOpen(NY_2_TO_6, at('2026-03-08T05:30:00Z'));
    expect(next?.toISOString()).toBe('2026-03-08T07:00:00.000Z');
    expect(callingWindowState(NY_2_TO_6, next!)).toBe('open');
    // Stated as the property, not just the value: the answer is never an instant
    // at which the window is shut.
    expect(callingWindowState(NY_2_TO_6, at('2026-03-08T06:00:00Z'))).toBe('closed');
  });

  it('handles the autumn repeated hour without leaving the window', () => {
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:00–02:00 happens
    // twice. Either occurrence is lawfully inside a window that includes 01:00,
    // so the only thing that must hold is that the answer is open.
    const next = nextWindowOpen(NY_2_TO_6, at('2026-11-01T02:00:00Z'));
    expect(next).not.toBeNull();
    expect(callingWindowState(NY_2_TO_6, next!)).toBe('open');
    expect(next!.getTime()).toBeGreaterThan(at('2026-11-01T02:00:00Z').getTime());
  });

  it('evaluates a summer instant with the summer offset', () => {
    // EDT (-4) in August, EST (-5) in January, same wall-clock window. If the
    // offset were captured once, one of these two is wrong by an hour.
    expect(callingWindowState(
      { ...NY_2_TO_6, start: '09:00:00', end: '20:00:00' }, at('2026-08-11T13:00:00Z'),
    )).toBe('open');   // 09:00 EDT
    expect(callingWindowState(
      { ...NY_2_TO_6, start: '09:00:00', end: '20:00:00' }, at('2026-01-13T13:00:00Z'),
    )).toBe('closed'); // 08:00 EST
  });
});

describe('time-of-day parsing', () => {
  it('accepts HH:MM as well as the HH:MM:SS Postgres renders', () => {
    expect(callingWindowState({ ...IST_9_TO_8, start: '09:00', end: '20:00' },
      at('2026-08-11T05:00:00Z'))).toBe('open');
  });

  it('accepts 24:00:00 as end-of-day, so an all-day window has no hole in it', () => {
    // `23:59:59` leaves a one-second gap at the end of every day. As a campaign
    // config that is a rounding error; as a test fixture it is a flake that fires
    // once a day and looks like anything but a clock. Postgres' `TIME` permits
    // `24:00:00`, so it is the honest way to say "until midnight".
    const allDay = { ...IST_9_TO_8, start: '00:00:00', end: '24:00:00', days: [1, 2, 3, 4, 5, 6, 7] };
    for (const iso of [
      '2026-08-11T18:29:59Z',   // 23:59:59 IST — the second `23:59:59` excludes
      '2026-08-11T18:30:00Z',   // 00:00:00 IST the next day
      '2026-08-15T12:00:00Z',   // a Saturday
    ]) {
      expect(callingWindowState(allDay, at(iso))).toBe('open');
    }
    // Contrast, so the reason for the sentinel is visible rather than asserted.
    const almost = { ...allDay, end: '23:59:59' };
    expect(callingWindowState(almost, at('2026-08-11T18:29:59Z'))).toBe('closed');
  });

  it('rejects 24:xx, which is not a time', () => {
    for (const bad of ['24:00:01', '24:30', '24:01:00']) {
      expect(callingWindowState({ ...IST_9_TO_8, end: bad }, at('2026-08-11T05:00:00Z')))
        .toBe('unresolvable');
    }
  });

  it('reports unresolvable for a time it cannot read, rather than assuming midnight', () => {
    // '9am' parsing to 0 would open the window at midnight — the failure mode
    // that makes a lenient parser worse than a strict one here.
    for (const bad of ['9am', '', '25:00', '09:60', 'noon']) {
      expect(callingWindowState({ ...IST_9_TO_8, start: bad }, at('2026-08-11T05:00:00Z')))
        .toBe('unresolvable');
    }
  });
});
