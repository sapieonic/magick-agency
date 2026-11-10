import { describe, expect, it } from 'vitest';
import type { AgencyInboundHoliday, AgencyInboundHoursInterval } from '@magick-agency/contracts/agency';
import {
  INBOUND_NEXT_OPENING_HORIZON_DAYS,
  inboundHolidaySpanDays,
  inboundScheduleState,
  isInboundCalendarDate,
  nextInboundOpening,
  parseInboundClock,
  type InboundSchedule,
} from '../../../src/inbound-schedule.js';

/*
 * The inbound route schedule (docs/inbound.md §3 step 1, §7). Instants are written in UTC with
 * the local wall time beside them. 2026 calendar: 2026-11-09 is a Monday; Europe/London springs
 * forward on Sun 29 Mar (01:00 GMT → 02:00 BST) and falls back on Sun 25 Oct (02:00 BST → 01:00
 * GMT); America/New_York springs forward on Sun 8 Mar (02:00 EST → 03:00 EDT) and falls back on
 * Sun 1 Nov (02:00 EDT → 01:00 EST).
 */

const at = (iso: string) => new Date(iso);

function weekdays(start: string, end: string, days = [1, 2, 3, 4, 5]): AgencyInboundHoursInterval[] {
  return days.map((day) => ({ day, start, end }));
}

function schedule(
  weekly_hours: AgencyInboundHoursInterval[],
  holidays: AgencyInboundHoliday[] = [],
  timezone = 'Europe/London',
): InboundSchedule {
  return { timezone, weekly_hours, holidays };
}

const holiday = (from: string, to = from, label: string | null = null): AgencyInboundHoliday => ({ from, to, label });

const OFFICE = schedule(weekdays('09:00', '17:00'));

describe('inboundScheduleState', () => {
  it('a weekday stretch is open from its start to just before its end, on its days only', () => {
    // Winter: London is on GMT, so local = UTC.
    expect(inboundScheduleState(OFFICE, at('2026-11-09T08:59:59Z'))).toBe('closed'); // Mon 08:59:59
    expect(inboundScheduleState(OFFICE, at('2026-11-09T09:00:00Z'))).toBe('open'); // Mon 09:00
    expect(inboundScheduleState(OFFICE, at('2026-11-09T16:59:59Z'))).toBe('open');
    expect(inboundScheduleState(OFFICE, at('2026-11-09T17:00:00Z'))).toBe('closed'); // end is exclusive
    expect(inboundScheduleState(OFFICE, at('2026-11-14T12:00:00Z'))).toBe('closed'); // Sat
    expect(inboundScheduleState(OFFICE, at('2026-11-15T12:00:00Z'))).toBe('closed'); // Sun
  });

  it('reads the wall clock in the route timezone, summer time included', () => {
    // Mon 6 Jul 2026, BST (UTC+1): 09:00 local is 08:00Z.
    expect(inboundScheduleState(OFFICE, at('2026-07-06T07:59:59Z'))).toBe('closed');
    expect(inboundScheduleState(OFFICE, at('2026-07-06T08:00:00Z'))).toBe('open');
    expect(inboundScheduleState(OFFICE, at('2026-07-06T15:59:59Z'))).toBe('open');
    expect(inboundScheduleState(OFFICE, at('2026-07-06T16:00:00Z'))).toBe('closed');
    // Asia/Kolkata, +05:30 all year: 09:00 IST is 03:30Z.
    const kolkata = schedule(weekdays('09:00', '17:00'), [], 'Asia/Kolkata');
    expect(inboundScheduleState(kolkata, at('2026-11-09T03:29:59Z'))).toBe('closed');
    expect(inboundScheduleState(kolkata, at('2026-11-09T03:30:00Z'))).toBe('open');
  });

  it('several stretches on one day: a lunch break is closed', () => {
    const lunch = schedule([{ day: 1, start: '09:00', end: '12:00' }, { day: 1, start: '13:00', end: '17:00' }]);
    expect(inboundScheduleState(lunch, at('2026-11-09T11:59:00Z'))).toBe('open');
    expect(inboundScheduleState(lunch, at('2026-11-09T12:30:00Z'))).toBe('closed');
    expect(inboundScheduleState(lunch, at('2026-11-09T13:00:00Z'))).toBe('open');
  });

  it('24:00 runs to midnight, and a 00:00 start the next day carries on without a gap', () => {
    const allDay = schedule([{ day: 1, start: '00:00', end: '24:00' }, { day: 2, start: '00:00', end: '06:00' }]);
    expect(inboundScheduleState(allDay, at('2026-11-09T00:00:00Z'))).toBe('open');
    expect(inboundScheduleState(allDay, at('2026-11-09T23:59:59Z'))).toBe('open');
    expect(inboundScheduleState(allDay, at('2026-11-10T00:00:00Z'))).toBe('open');
    expect(inboundScheduleState(allDay, at('2026-11-10T06:00:00Z'))).toBe('closed');
  });

  describe('an overnight stretch (22:00–02:00) belongs to the day it opens', () => {
    const late = schedule([{ day: 5, start: '22:00', end: '02:00' }]); // Friday night
    it('runs from Friday 22:00 into Saturday 02:00, though Saturday has no hours', () => {
      expect(inboundScheduleState(late, at('2026-11-13T21:59:59Z'))).toBe('closed'); // Fri 21:59
      expect(inboundScheduleState(late, at('2026-11-13T22:00:00Z'))).toBe('open'); // Fri 22:00
      expect(inboundScheduleState(late, at('2026-11-13T23:59:59Z'))).toBe('open');
      expect(inboundScheduleState(late, at('2026-11-14T00:00:00Z'))).toBe('open'); // Sat 00:00
      expect(inboundScheduleState(late, at('2026-11-14T01:59:59Z'))).toBe('open');
      expect(inboundScheduleState(late, at('2026-11-14T02:00:00Z'))).toBe('closed');
    });
    it('does not open on another evening, nor run its tail after a day that does not open it', () => {
      expect(inboundScheduleState(late, at('2026-11-14T22:30:00Z'))).toBe('closed'); // Sat 22:30
      expect(inboundScheduleState(late, at('2026-11-13T01:00:00Z'))).toBe('closed'); // Fri 01:00 (Thu had none)
    });
    it('a holiday on the opening day cancels the whole stretch, tail included', () => {
      const xmas = schedule([{ day: 5, start: '22:00', end: '02:00' }], [holiday('2026-12-25')]); // Fri
      expect(inboundScheduleState(xmas, at('2026-12-25T23:00:00Z'))).toBe('closed');
      expect(inboundScheduleState(xmas, at('2026-12-26T01:00:00Z'))).toBe('closed');
    });
    it('a holiday on the morning after stops the stretch at midnight', () => {
      const boxing = schedule([{ day: 5, start: '22:00', end: '02:00' }], [holiday('2026-11-14')]); // the Saturday
      expect(inboundScheduleState(boxing, at('2026-11-13T23:30:00Z'))).toBe('open');
      expect(inboundScheduleState(boxing, at('2026-11-14T00:30:00Z'))).toBe('closed');
    });
  });

  it('a holiday on a weekday closes it all day; a holiday range covers every date in it', () => {
    const s = schedule(weekdays('09:00', '17:00'), [holiday('2026-11-11'), holiday('2026-11-16', '2026-11-18')]);
    expect(inboundScheduleState(s, at('2026-11-10T10:00:00Z'))).toBe('open'); // Tue
    expect(inboundScheduleState(s, at('2026-11-11T10:00:00Z'))).toBe('closed'); // Wed, a holiday
    expect(inboundScheduleState(s, at('2026-11-12T10:00:00Z'))).toBe('open'); // Thu
    expect(inboundScheduleState(s, at('2026-11-16T10:00:00Z'))).toBe('closed'); // Mon..Wed range
    expect(inboundScheduleState(s, at('2026-11-18T16:59:00Z'))).toBe('closed');
    expect(inboundScheduleState(s, at('2026-11-19T09:00:00Z'))).toBe('open');
  });

  it('a holiday is a LOCAL date: an Asia/Kolkata holiday starts at 18:30Z the evening before', () => {
    const s = schedule([{ day: 3, start: '00:00', end: '24:00' }, { day: 2, start: '00:00', end: '24:00' }], [holiday('2026-11-11')], 'Asia/Kolkata');
    expect(inboundScheduleState(s, at('2026-11-10T18:29:59Z'))).toBe('open'); // Tue 23:59:59 IST
    expect(inboundScheduleState(s, at('2026-11-10T18:30:00Z'))).toBe('closed'); // Wed 00:00 IST
  });

  describe('DST, on the wall clock', () => {
    it('Europe/London spring-forward: a stretch opening in the gap is open from the first instant after it', () => {
      const s = schedule([{ day: 7, start: '01:30', end: '05:00' }]);
      expect(inboundScheduleState(s, at('2026-03-29T00:59:59Z'))).toBe('closed'); // 00:59:59 GMT
      expect(inboundScheduleState(s, at('2026-03-29T01:00:00Z'))).toBe('open'); // 02:00 BST
      expect(inboundScheduleState(s, at('2026-03-29T03:59:59Z'))).toBe('open'); // 04:59:59 BST
      expect(inboundScheduleState(s, at('2026-03-29T04:00:00Z'))).toBe('closed'); // 05:00 BST
    });

    it('Europe/London fall-back: the repeated hour is evaluated on its wall time, both passes', () => {
      const s = schedule([{ day: 7, start: '01:30', end: '03:00' }]);
      expect(inboundScheduleState(s, at('2026-10-25T00:15:00Z'))).toBe('closed'); // 01:15 BST
      expect(inboundScheduleState(s, at('2026-10-25T00:30:00Z'))).toBe('open'); // 01:30 BST
      expect(inboundScheduleState(s, at('2026-10-25T01:15:00Z'))).toBe('closed'); // 01:15 GMT (second pass)
      expect(inboundScheduleState(s, at('2026-10-25T01:30:00Z'))).toBe('open'); // 01:30 GMT
      expect(inboundScheduleState(s, at('2026-10-25T03:00:00Z'))).toBe('closed'); // 03:00 GMT
    });

    it('America/New_York spring-forward and fall-back', () => {
      const spring = schedule([{ day: 7, start: '02:30', end: '06:00' }], [], 'America/New_York');
      expect(inboundScheduleState(spring, at('2026-03-08T06:59:59Z'))).toBe('closed'); // 01:59:59 EST
      expect(inboundScheduleState(spring, at('2026-03-08T07:00:00Z'))).toBe('open'); // 03:00 EDT
      const fall = schedule([{ day: 7, start: '01:30', end: '05:00' }], [], 'America/New_York');
      expect(inboundScheduleState(fall, at('2026-11-01T05:30:00Z'))).toBe('open'); // 01:30 EDT
      expect(inboundScheduleState(fall, at('2026-11-01T06:15:00Z'))).toBe('closed'); // 01:15 EST
      expect(inboundScheduleState(fall, at('2026-11-01T06:30:00Z'))).toBe('open'); // 01:30 EST
    });
  });

  it('an empty week is closed, every day', () => {
    expect(inboundScheduleState(schedule([]), at('2026-11-09T12:00:00Z'))).toBe('closed');
  });

  it.each([
    ['a bare abbreviation', schedule(weekdays('09:00', '17:00'), [], 'EST')],
    ['an unknown zone', schedule(weekdays('09:00', '17:00'), [], 'Mars/Olympus_Mons')],
    ['day 0 (Postgres dow)', schedule([{ day: 0, start: '09:00', end: '17:00' }])],
    ['a 24:30 end', schedule([{ day: 1, start: '09:00', end: '24:30' }])],
    ['a time with seconds', schedule([{ day: 1, start: '09:00:00', end: '17:00' }])],
    ['a holiday on 30 February', schedule(weekdays('09:00', '17:00'), [holiday('2026-02-30')])],
    ['a holiday ending before it starts', schedule(weekdays('09:00', '17:00'), [holiday('2026-11-12', '2026-11-11')])],
    ['hours that are not a list', { timezone: 'UTC', weekly_hours: {} as unknown as AgencyInboundHoursInterval[], holidays: [] }],
    ['a null stretch', schedule([null as unknown as AgencyInboundHoursInterval])],
  ])('%s is unresolvable, with no next opening', (_label, s) => {
    expect(inboundScheduleState(s, at('2026-11-09T12:00:00Z'))).toBe('unresolvable');
    expect(nextInboundOpening(s, at('2026-11-09T12:00:00Z'))).toBeNull();
  });

  it('an invalid instant is unresolvable', () => {
    expect(inboundScheduleState(OFFICE, new Date(Number.NaN))).toBe('unresolvable');
    expect(nextInboundOpening(OFFICE, new Date(Number.NaN))).toBeNull();
  });
});

describe('nextInboundOpening', () => {
  it('is the instant itself while the route is open', () => {
    const now = at('2026-11-09T10:15:00Z');
    expect(nextInboundOpening(OFFICE, now)).toEqual(now);
  });

  it('later the same day, the next morning, and over the weekend', () => {
    expect(nextInboundOpening(OFFICE, at('2026-11-09T07:00:00Z'))).toEqual(at('2026-11-09T09:00:00Z')); // Mon early
    expect(nextInboundOpening(OFFICE, at('2026-11-09T17:00:00Z'))).toEqual(at('2026-11-10T09:00:00Z')); // Mon close
    expect(nextInboundOpening(OFFICE, at('2026-11-13T18:00:00Z'))).toEqual(at('2026-11-16T09:00:00Z')); // Fri → Mon
    expect(nextInboundOpening(OFFICE, at('2026-11-14T12:00:00Z'))).toEqual(at('2026-11-16T09:00:00Z')); // Sat → Mon
  });

  it('after a lunch break, the afternoon stretch', () => {
    const lunch = schedule([{ day: 1, start: '09:00', end: '12:00' }, { day: 1, start: '13:00', end: '17:00' }]);
    expect(nextInboundOpening(lunch, at('2026-11-09T12:30:00Z'))).toEqual(at('2026-11-09T13:00:00Z'));
  });

  it('in summer time and in a half-hour zone', () => {
    expect(nextInboundOpening(OFFICE, at('2026-07-06T05:00:00Z'))).toEqual(at('2026-07-06T08:00:00Z')); // 09:00 BST
    const kolkata = schedule(weekdays('09:00', '17:00'), [], 'Asia/Kolkata');
    expect(nextInboundOpening(kolkata, at('2026-11-09T00:00:00Z'))).toEqual(at('2026-11-09T03:30:00Z'));
  });

  it('skips a holiday on a weekday', () => {
    const s = schedule(weekdays('09:00', '17:00'), [holiday('2026-11-11')]);
    expect(nextInboundOpening(s, at('2026-11-10T17:30:00Z'))).toEqual(at('2026-11-12T09:00:00Z')); // Tue eve → Thu
    expect(nextInboundOpening(s, at('2026-11-11T10:00:00Z'))).toEqual(at('2026-11-12T09:00:00Z')); // on the holiday
  });

  it('across a long weekend: Christmas Friday and the Monday after are holidays', () => {
    const s = schedule(weekdays('09:00', '17:00'), [holiday('2026-12-25', '2026-12-25', 'Christmas Day'), holiday('2026-12-28', '2026-12-28', 'Boxing Day (substitute)')]);
    // Thu 24 Dec 17:30 → Tue 29 Dec 09:00 (GMT).
    expect(nextInboundOpening(s, at('2026-12-24T17:30:00Z'))).toEqual(at('2026-12-29T09:00:00Z'));
  });

  it('across a holiday range spanning the new year', () => {
    const s = schedule(weekdays('09:00', '17:00'), [holiday('2026-12-24', '2027-01-01')]);
    expect(nextInboundOpening(s, at('2026-12-23T18:00:00Z'))).toEqual(at('2027-01-04T09:00:00Z')); // Mon 4 Jan
  });

  it('an overnight stretch opens at its evening start; a holiday that cancels it moves on a week', () => {
    const late = schedule([{ day: 5, start: '22:00', end: '02:00' }]);
    expect(nextInboundOpening(late, at('2026-11-14T03:00:00Z'))).toEqual(at('2026-11-20T22:00:00Z'));
    const xmas = schedule([{ day: 5, start: '22:00', end: '02:00' }], [holiday('2026-12-25')]);
    expect(nextInboundOpening(xmas, at('2026-12-25T12:00:00Z'))).toEqual(at('2027-01-01T22:00:00Z'));
  });

  describe('exact openings across DST changes', () => {
    it('Europe/London spring-forward: a 01:30 opening, which does not exist, opens at 02:00 BST', () => {
      const s = schedule([{ day: 7, start: '01:30', end: '05:00' }]);
      expect(nextInboundOpening(s, at('2026-03-29T00:00:00Z'))).toEqual(at('2026-03-29T01:00:00Z'));
    });

    it('Europe/London spring-forward: an ordinary 09:00 opening that day is on BST', () => {
      const s = schedule([{ day: 7, start: '09:00', end: '17:00' }]);
      expect(nextInboundOpening(s, at('2026-03-29T00:00:00Z'))).toEqual(at('2026-03-29T08:00:00Z'));
    });

    it('Europe/London fall-back: a 01:30 opening in the repeated hour is its first pass (BST)', () => {
      const s = schedule([{ day: 7, start: '01:30', end: '03:00' }]);
      expect(nextInboundOpening(s, at('2026-10-25T00:00:00Z'))).toEqual(at('2026-10-25T00:30:00Z'));
      // From inside the gap the second pass makes (01:15 GMT, closed), the reopening at 01:30 GMT.
      expect(nextInboundOpening(s, at('2026-10-25T01:15:00Z'))).toEqual(at('2026-10-25T01:30:00Z'));
    });

    it('America/New_York spring-forward: a 02:30 opening, which does not exist, opens at 03:00 EDT', () => {
      const s = schedule([{ day: 7, start: '02:30', end: '06:00' }], [], 'America/New_York');
      expect(nextInboundOpening(s, at('2026-03-08T05:00:00Z'))).toEqual(at('2026-03-08T07:00:00Z'));
    });

    it('America/New_York fall-back: a 01:30 opening is its first pass (EDT)', () => {
      const s = schedule([{ day: 7, start: '01:30', end: '05:00' }], [], 'America/New_York');
      expect(nextInboundOpening(s, at('2026-11-01T04:00:00Z'))).toEqual(at('2026-11-01T05:30:00Z'));
    });

    it('America/New_York: the Monday after the change opens on EST', () => {
      expect(nextInboundOpening(schedule(weekdays('09:00', '17:00'), [], 'America/New_York'), at('2026-10-30T22:00:00Z')))
        .toEqual(at('2026-11-02T14:00:00Z')); // Fri 18:00 EDT → Mon 09:00 EST
    });
  });

  it('no hours: never opens', () => {
    expect(nextInboundOpening(schedule([]), at('2026-11-09T12:00:00Z'))).toBeNull();
  });

  it('holidays covering the whole horizon: never opens (bounded, not searched for ever)', () => {
    const holidays: AgencyInboundHoliday[] = [];
    for (let i = 0; i < 14; i++) {
      const from = new Date(Date.UTC(2026, 10, 9 + i * 31));
      const to = new Date(Date.UTC(2026, 10, 9 + i * 31 + 30));
      holidays.push(holiday(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)));
    }
    expect(14 * 31).toBeGreaterThan(INBOUND_NEXT_OPENING_HORIZON_DAYS);
    expect(nextInboundOpening(schedule(weekdays('09:00', '17:00'), holidays), at('2026-11-09T12:00:00Z'))).toBeNull();
  });

  it('finds an opening a year away (one weekday a year, the rest holidays)', () => {
    // Open only on Mondays, every Monday a holiday until 2027-11-01.
    const s = schedule([{ day: 1, start: '09:00', end: '10:00' }], [holiday('2026-11-09', '2027-10-31')]);
    expect(nextInboundOpening(s, at('2026-11-09T12:00:00Z'))).toEqual(at('2027-11-01T09:00:00Z'));
  });
});

describe('the parts the route API validates with', () => {
  it.each([
    ['00:00', 0], ['09:30', 34_200], ['23:59', 86_340], ['24:00', 86_400],
    ['24:01', null], ['9:00', null], ['09:60', null], ['25:00', null], ['09:00:00', null], [' 09:00', null], [900, null],
  ])('parseInboundClock(%j) → %j', (raw, want) => {
    expect(parseInboundClock(raw)).toBe(want);
  });

  it.each([
    ['2026-11-09', true], ['2028-02-29', true], ['2026-02-29', false], ['2026-02-30', false], ['2026-13-01', false],
    ['0000-01-01', false], ['2026-1-01', false], ['20261109', false], [null, false],
  ])('isInboundCalendarDate(%j) → %j', (raw, want) => {
    expect(isInboundCalendarDate(raw)).toBe(want);
  });

  it('inboundHolidaySpanDays counts both ends, across a month and a DST change', () => {
    expect(inboundHolidaySpanDays('2026-12-25', '2026-12-25')).toBe(1);
    expect(inboundHolidaySpanDays('2026-12-24', '2027-01-01')).toBe(9);
    expect(inboundHolidaySpanDays('2026-03-28', '2026-03-30')).toBe(3);
  });
});
