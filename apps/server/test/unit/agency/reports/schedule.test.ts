import { describe, expect, it } from 'vitest';
import {
  localDateOf,
  localDayBounds,
  localInstant,
  nextRunAt,
  parseSendLocalTime,
  periodFor,
  previousRunAt,
  type ReportSchedule,
} from '../../../../src/agency/reports/schedule.js';

/*
 * The report schedule (docs/reports.md RP2, RP3, RP14). Every assertion is an exact instant: the
 * module is a clock derivation and every instant is an argument, so nothing is faked.
 *
 * Clock changes used (checked against the zone data on this runtime):
 *  - Europe/London: 2026-10-25 01:00Z BST → GMT (01:00–02:00 local happens twice);
 *    2027-03-28 01:00Z GMT → BST (01:00–02:00 local does not exist).
 *  - America/New_York: 2026-11-01 06:00Z EDT → EST (01:00–02:00 twice);
 *    2027-03-14 07:00Z EST → EDT (02:00–03:00 does not exist).
 *  - America/Santiago: 2026-09-06 local midnight does not exist (00:00 → 01:00).
 *  - Asia/Kolkata: UTC+05:30 all year.
 *
 * Mutation-checked: reading a gap with the offset AFTER it (the naive two-pass conversion) reds the
 * gap cases (02:30 resolves to 01:30 EST, an hour early); taking the LATER occurrence in an overlap
 * reds the fall-back cases; cutting periods on the UTC date instead of the local one reds the
 * Kolkata 00:30 case; `>=` instead of `>` in nextRunAt reds "strictly after".
 */

const at = (iso: string) => new Date(iso);
const HOUR = 3_600_000;

function schedule(o: Partial<ReportSchedule> & Pick<ReportSchedule, 'cadence' | 'timezone'>): ReportSchedule {
  return { send_local_time: '07:30', send_weekday: null, send_monthday: null, ...o };
}

describe('localDayBounds: [local midnight of from, local midnight after to)', () => {
  it('October in Europe/London is 31 days and 745 hours: the stored cap exactly (RP2)', () => {
    const { start, end } = localDayBounds('2026-10-01', '2026-10-31', 'Europe/London');
    expect(start.toISOString()).toBe('2026-09-30T23:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe((31 * 24 + 1) * HOUR);
  });

  it('March in Europe/London is 743 hours (the spring change takes one)', () => {
    const { start, end } = localDayBounds('2027-03-01', '2027-03-31', 'Europe/London');
    expect(start.toISOString()).toBe('2027-03-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-03-31T23:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(743 * HOUR);
  });

  it('one day in America/New_York: 23 hours on the spring change, 25 on the fall one', () => {
    const spring = localDayBounds('2027-03-14', '2027-03-14', 'America/New_York');
    expect([spring.start.toISOString(), spring.end.toISOString()]).toEqual(['2027-03-14T05:00:00.000Z', '2027-03-15T04:00:00.000Z']);
    const fall = localDayBounds('2026-11-01', '2026-11-01', 'America/New_York');
    expect([fall.start.toISOString(), fall.end.toISOString()]).toEqual(['2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z']);
  });

  it('Asia/Kolkata: every day is 24 hours from 18:30Z the day before', () => {
    const { start, end } = localDayBounds('2026-11-07', '2026-11-07', 'Asia/Kolkata');
    expect([start.toISOString(), end.toISOString()]).toEqual(['2026-11-06T18:30:00.000Z', '2026-11-07T18:30:00.000Z']);
    const month = localDayBounds('2026-03-01', '2026-03-31', 'Asia/Kolkata');
    expect(month.end.getTime() - month.start.getTime()).toBe(31 * 24 * HOUR);
  });

  it('a local midnight inside a gap starts the day at its first instant, and days stay contiguous', () => {
    const before = localDayBounds('2026-09-05', '2026-09-05', 'America/Santiago');
    const gapDay = localDayBounds('2026-09-06', '2026-09-06', 'America/Santiago');
    expect(gapDay.start.toISOString()).toBe('2026-09-06T04:00:00.000Z'); // 01:00 -03
    expect(before.end.getTime()).toBe(gapDay.start.getTime());
    expect(gapDay.end.getTime() - gapDay.start.getTime()).toBe(23 * HOUR);
  });

  it('leap days: 29 February 2028 is a day, 2027 has none', () => {
    const { start, end } = localDayBounds('2028-02-01', '2028-02-29', 'UTC');
    expect(end.getTime() - start.getTime()).toBe(29 * 24 * HOUR);
    expect(end.toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(() => localDayBounds('2027-02-29', '2027-02-29', 'UTC')).toThrow(RangeError);
  });

  it('refuses a reversed window, a malformed date and an unusable zone', () => {
    expect(() => localDayBounds('2026-10-02', '2026-10-01', 'UTC')).toThrow(RangeError);
    expect(() => localDayBounds('2026-10-1', '2026-10-01', 'UTC')).toThrow(RangeError);
    expect(() => localDayBounds('2026-02-30', '2026-03-01', 'UTC')).toThrow(RangeError);
    // A bare abbreviation resolves to a fixed-offset zone in ICU; refused, as calling hours refuses it.
    expect(() => localDayBounds('2026-10-01', '2026-10-01', 'EST')).toThrow(RangeError);
    expect(() => localDayBounds('2026-10-01', '2026-10-01', 'Mars/Olympus')).toThrow(RangeError);
    expect(() => localDayBounds('2026-10-01', '2026-10-01', ' Europe/London')).toThrow(RangeError);
  });
});

describe('localInstant: the clock-change rule', () => {
  it('a wall time inside a gap runs as far past the gap as it was into it (02:30 → 03:30 EDT)', () => {
    expect(localInstant('America/New_York', '2027-03-14', 2.5 * 3600).toISOString()).toBe('2027-03-14T07:30:00.000Z');
    // London's gap is 01:00–02:00: 01:30 → 02:30 BST.
    expect(localInstant('Europe/London', '2027-03-28', 1.5 * 3600).toISOString()).toBe('2027-03-28T01:30:00.000Z');
  });

  it('a wall time that happens twice resolves to the first occurrence', () => {
    expect(localInstant('America/New_York', '2026-11-01', 1.5 * 3600).toISOString()).toBe('2026-11-01T05:30:00.000Z'); // EDT
    expect(localInstant('Europe/London', '2026-10-25', 1.5 * 3600).toISOString()).toBe('2026-10-25T00:30:00.000Z'); // BST
  });

  it('an ordinary wall time is its one instant', () => {
    expect(localInstant('Asia/Kolkata', '2026-11-08', 7.5 * 3600).toISOString()).toBe('2026-11-08T02:00:00.000Z');
    expect(localInstant('Europe/London', '2026-07-01', 0).toISOString()).toBe('2026-06-30T23:00:00.000Z');
  });
});

describe('localDateOf', () => {
  it('is the date on the zone\'s wall clock, not the UTC date', () => {
    expect(localDateOf(at('2026-11-07T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-11-08');
    expect(localDateOf(at('2026-11-08T03:00:00Z'), 'America/New_York')).toBe('2026-11-07');
  });
});

describe('periodFor: the local dates a subscription run covers', () => {
  it('daily: the previous local day', () => {
    expect(periodFor('daily', at('2026-11-08T07:00:00Z'), 'Europe/London')).toEqual({ from: '2026-11-07', to: '2026-11-07' });
  });

  it('cuts on the local date: 00:30 in Kolkata on the 8th is still the 7th in UTC', () => {
    expect(periodFor('daily', at('2026-11-07T19:00:00Z'), 'Asia/Kolkata')).toEqual({ from: '2026-11-07', to: '2026-11-07' });
  });

  it('weekly: the seven local days ending the day before', () => {
    // Monday 9 November 2026.
    expect(periodFor('weekly', at('2026-11-09T09:00:00Z'), 'Europe/London')).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    // Across a month and a year end.
    expect(periodFor('weekly', at('2027-01-03T12:00:00Z'), 'UTC')).toEqual({ from: '2026-12-27', to: '2027-01-02' });
  });

  it('monthly: the previous calendar month, whatever day it is sent on', () => {
    expect(periodFor('monthly', at('2026-03-01T06:00:00Z'), 'UTC')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(periodFor('monthly', at('2028-03-28T06:00:00Z'), 'UTC')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(periodFor('monthly', at('2027-01-05T06:00:00Z'), 'UTC')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(periodFor('monthly', at('2026-05-15T06:00:00Z'), 'UTC')).toEqual({ from: '2026-04-01', to: '2026-04-30' });
  });

  it('monthly on the 1st at 00:30 London, the first hour after the clocks went back, is October', () => {
    expect(periodFor('monthly', at('2026-11-01T00:30:00Z'), 'Europe/London')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  });
});

describe('nextRunAt: the first send strictly after', () => {
  it('daily at 07:30 Kolkata: today when it is still ahead, tomorrow from the send instant itself', () => {
    const s = schedule({ cadence: 'daily', timezone: 'Asia/Kolkata' });
    expect(nextRunAt(s, at('2026-11-08T00:00:00Z')).toISOString()).toBe('2026-11-08T02:00:00.000Z');
    expect(nextRunAt(s, at('2026-11-08T02:00:00Z')).toISOString()).toBe('2026-11-09T02:00:00.000Z');
    expect(nextRunAt(s, at('2026-11-08T01:59:59Z')).toISOString()).toBe('2026-11-08T02:00:00.000Z');
  });

  it('Kolkata has no clock changes: 400 daily sends are exactly 24 hours apart', () => {
    const s = schedule({ cadence: 'daily', timezone: 'Asia/Kolkata', send_local_time: '18:15' });
    let prev = nextRunAt(s, at('2026-01-01T00:00:00Z'));
    for (let i = 0; i < 400; i++) {
      const next = nextRunAt(s, prev);
      expect(next.getTime() - prev.getTime()).toBe(24 * HOUR);
      prev = next;
    }
  });

  it('weekly on Monday 09:00 London, and a Sunday send across the autumn change keeps 09:00 local', () => {
    const monday = schedule({ cadence: 'weekly', timezone: 'Europe/London', send_local_time: '09:00', send_weekday: 1 });
    expect(nextRunAt(monday, at('2026-11-07T12:00:00Z')).toISOString()).toBe('2026-11-09T09:00:00.000Z');
    const sunday = schedule({ cadence: 'weekly', timezone: 'Europe/London', send_local_time: '09:00', send_weekday: 7 });
    expect(nextRunAt(sunday, at('2026-10-18T08:00:00Z')).toISOString()).toBe('2026-10-25T09:00:00.000Z'); // GMT now
  });

  it('monthly on the 28th 06:00 New York: February, then March in daylight time', () => {
    const s = schedule({ cadence: 'monthly', timezone: 'America/New_York', send_local_time: '06:00', send_monthday: 28 });
    const feb = nextRunAt(s, at('2027-01-28T11:00:00Z'));
    expect(feb.toISOString()).toBe('2027-02-28T11:00:00.000Z');
    expect(nextRunAt(s, feb).toISOString()).toBe('2027-03-28T10:00:00.000Z');
  });

  it('monthly on the 1st crosses the year', () => {
    const s = schedule({ cadence: 'monthly', timezone: 'UTC', send_local_time: '00:00', send_monthday: 1 });
    expect(nextRunAt(s, at('2026-12-01T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('a 02:30 send on New York\'s spring-forward day runs at 03:30 EDT, then 02:30 again', () => {
    const s = schedule({ cadence: 'daily', timezone: 'America/New_York', send_local_time: '02:30' });
    const gap = nextRunAt(s, at('2027-03-13T12:00:00Z'));
    expect(gap.toISOString()).toBe('2027-03-14T07:30:00.000Z');
    expect(nextRunAt(s, gap).toISOString()).toBe('2027-03-15T06:30:00.000Z');
  });

  it('a 01:30 send in London\'s spring gap runs at 02:30 BST', () => {
    const s = schedule({ cadence: 'daily', timezone: 'Europe/London', send_local_time: '01:30' });
    expect(nextRunAt(s, at('2027-03-27T01:30:00Z')).toISOString()).toBe('2027-03-28T01:30:00.000Z');
  });

  it('a send at a wall time that happens twice runs once, at the first', () => {
    const ny = schedule({ cadence: 'daily', timezone: 'America/New_York', send_local_time: '01:30' });
    const first = nextRunAt(ny, at('2026-10-31T12:00:00Z'));
    expect(first.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(nextRunAt(ny, first).toISOString()).toBe('2026-11-02T06:30:00.000Z');
    const london = schedule({ cadence: 'daily', timezone: 'Europe/London', send_local_time: '01:30' });
    const once = nextRunAt(london, at('2026-10-24T12:00:00Z'));
    expect(once.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(nextRunAt(london, once).toISOString()).toBe('2026-10-26T01:30:00.000Z');
  });

  it('two years of sends in every zone and cadence: increasing, on the right day, at the send time except in a gap', () => {
    const zones = ['Europe/London', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'];
    const cases: Array<Partial<ReportSchedule> & Pick<ReportSchedule, 'cadence'>> = [
      { cadence: 'daily', send_local_time: '02:30' },
      { cadence: 'weekly', send_local_time: '01:45', send_weekday: 7 },
      { cadence: 'monthly', send_local_time: '23:59', send_monthday: 28 },
    ];
    for (const timezone of zones) {
      for (const c of cases) {
        const s = schedule({ ...c, timezone });
        let prev = at('2026-01-01T00:00:00Z');
        let lastDate = '';
        while (prev.getTime() < at('2028-01-01T00:00:00Z').getTime()) {
          const next = nextRunAt(s, prev);
          expect(next.getTime()).toBeGreaterThan(prev.getTime());
          const date = localDateOf(next, timezone);
          expect(date > lastDate, `${timezone} ${c.cadence} ${date}`).toBe(true);
          const [y, m, d] = date.split('-').map(Number) as [number, number, number];
          if (c.cadence === 'weekly') expect(new Date(Date.UTC(y, m - 1, d)).getUTCDay()).toBe(0);
          if (c.cadence === 'monthly') expect(d).toBe(28);
          // At the send time, or (only in a gap) later on the same local day.
          const expected = localInstant(timezone, date, parseSendLocalTime(s.send_local_time));
          expect(next.getTime()).toBe(expected.getTime());
          lastDate = date;
          prev = next;
        }
      }
    }
  });
});

describe('previousRunAt: the latest send at or before (catch-up)', () => {
  const s = schedule({ cadence: 'weekly', timezone: 'Europe/London', send_local_time: '09:00', send_weekday: 1 });

  it('a send instant is its own latest', () => {
    expect(previousRunAt(s, at('2026-11-09T09:00:00Z')).toISOString()).toBe('2026-11-09T09:00:00.000Z');
    expect(previousRunAt(s, at('2026-11-09T08:59:59Z')).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('after three weeks down, only the most recent missed send', () => {
    expect(previousRunAt(s, at('2026-11-26T12:00:00Z')).toISOString()).toBe('2026-11-23T09:00:00.000Z');
  });

  it('monthly on the 3rd, asked on the 2nd: last month\'s', () => {
    const m = schedule({ cadence: 'monthly', timezone: 'UTC', send_local_time: '06:00', send_monthday: 3 });
    expect(previousRunAt(m, at('2027-01-02T00:00:00Z')).toISOString()).toBe('2026-12-03T06:00:00.000Z');
  });

  it('round-trips with nextRunAt', () => {
    const d = schedule({ cadence: 'daily', timezone: 'America/New_York', send_local_time: '02:30' });
    let t = at('2027-03-10T00:00:00Z');
    for (let i = 0; i < 10; i++) {
      t = nextRunAt(d, t);
      expect(previousRunAt(d, t).getTime()).toBe(t.getTime());
      expect(previousRunAt(d, new Date(t.getTime() - 1000)).getTime()).toBeLessThan(t.getTime());
    }
  });
});

describe('refusals', () => {
  it('an unusable zone, a malformed send time, a missing or out-of-range day', () => {
    const now = at('2026-11-08T00:00:00Z');
    expect(() => nextRunAt(schedule({ cadence: 'daily', timezone: 'IST' }), now)).toThrow(RangeError);
    for (const t of ['7:30', '24:00', '07:60', '07:30:15', 'noon']) {
      expect(() => nextRunAt(schedule({ cadence: 'daily', timezone: 'UTC', send_local_time: t }), now), t).toThrow(RangeError);
    }
    expect(parseSendLocalTime('07:30:00')).toBe(27_000);
    expect(() => nextRunAt(schedule({ cadence: 'weekly', timezone: 'UTC' }), now)).toThrow(RangeError);
    expect(() => nextRunAt(schedule({ cadence: 'weekly', timezone: 'UTC', send_weekday: 0 }), now)).toThrow(RangeError);
    expect(() => nextRunAt(schedule({ cadence: 'monthly', timezone: 'UTC', send_monthday: 29 }), now)).toThrow(RangeError);
    expect(() => previousRunAt(schedule({ cadence: 'monthly', timezone: 'UTC' }), now)).toThrow(RangeError);
    expect(() => periodFor('daily', now, 'EST')).toThrow(RangeError);
  });
});
