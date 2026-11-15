import { describe, expect, it } from 'vitest';
import { AGENCY_PROMISE_MAX_DAYS_AHEAD } from '@magick-agency/contracts/agency';
import {
  addDays,
  dayStartIn,
  followUpDay,
  formatPromiseDay,
  normalisePromiseAmount,
  parsePromiseDate,
  promiseDateRefusal,
  promiseState,
  todayIn,
  validatePromiseFields,
} from '../../../src/promise-to-pay';

const day = (year: number, month: number, d: number) => ({ year, month, day: d });

describe('parsePromiseDate (PT4)', () => {
  it('reads a real YYYY-MM-DD date', () => {
    expect(parsePromiseDate('2026-11-18')).toEqual(day(2026, 11, 18));
    expect(parsePromiseDate('2028-02-29')).toEqual(day(2028, 2, 29));
  });

  it('refuses a date that does not exist rather than rolling it over', () => {
    expect(parsePromiseDate('2026-02-29')).toBeNull();
    expect(parsePromiseDate('2026-02-30')).toBeNull();
    expect(parsePromiseDate('2026-04-31')).toBeNull();
    expect(parsePromiseDate('2026-13-01')).toBeNull();
    expect(parsePromiseDate('2026-00-10')).toBeNull();
    expect(parsePromiseDate('2026-01-00')).toBeNull();
  });

  it('refuses every other shape', () => {
    for (const v of ['2026-11-18T00:00:00Z', '18/11/2026', '2026-1-8', ' 2026-11-18', '20261118', '', null, 20261118, {}]) {
      expect(parsePromiseDate(v)).toBeNull();
    }
  });
});

describe('promiseDateRefusal (PT4)', () => {
  const today = day(2026, 11, 15);
  it('accepts today and up to the bound ahead', () => {
    expect(promiseDateRefusal('2026-11-15', today)).toBeNull();
    expect(promiseDateRefusal(formatPromiseDay(addDays(today, AGENCY_PROMISE_MAX_DAYS_AHEAD)), today)).toBeNull();
  });
  it('refuses yesterday, a day past the bound, and junk', () => {
    expect(promiseDateRefusal('2026-11-14', today)).toBe('past');
    expect(promiseDateRefusal(formatPromiseDay(addDays(today, AGENCY_PROMISE_MAX_DAYS_AHEAD + 1)), today)).toBe('too_far');
    expect(promiseDateRefusal('2062-11-15', today)).toBe('too_far');
    expect(promiseDateRefusal('2026-02-30', today)).toBe('invalid');
  });
});

describe('normalisePromiseAmount (PT5)', () => {
  it('keeps the digits exactly, to two places', () => {
    expect(normalisePromiseAmount('12500')).toBe('12500.00');
    expect(normalisePromiseAmount('12500.5')).toBe('12500.50');
    expect(normalisePromiseAmount('0.1')).toBe('0.10');
    expect(normalisePromiseAmount('0')).toBe('0.00');
    expect(normalisePromiseAmount('007.25')).toBe('7.25');
    expect(normalisePromiseAmount(' 99.99 ')).toBe('99.99');
    expect(normalisePromiseAmount('999999999999.99')).toBe('999999999999.99');
    expect(normalisePromiseAmount(12500.5)).toBe('12500.50');
  });
  it('refuses negatives, three places, separators, exponents and overflow', () => {
    for (const v of ['-1', '1.234', '12,500', '1e3', '1000000000000', '.5', '5.', 'abc', '', NaN, Infinity, -2, 1e21, null, true]) {
      expect(normalisePromiseAmount(v)).toBeNull();
    }
  });
});

describe('todayIn and dayStartIn: the customer\'s calendar', () => {
  it('reads today in the customer\'s zone, not UTC', () => {
    // 20:00 UTC on 15 Nov is already 16 Nov in Kolkata and still 15 Nov in New York.
    const now = new Date('2026-11-15T20:00:00Z');
    expect(todayIn('Asia/Kolkata', now)).toEqual(day(2026, 11, 16));
    expect(todayIn('America/New_York', now)).toEqual(day(2026, 11, 15));
    expect(todayIn('Not/AZone', now)).toBeNull();
  });

  it('puts a day\'s start at local midnight, DST included', () => {
    expect(dayStartIn('Asia/Kolkata', day(2026, 11, 18))?.toISOString()).toBe('2026-11-17T18:30:00.000Z');
    // London's autumn change is at 02:00 on 25 Oct 2026: that day starts at 00:00 BST.
    expect(dayStartIn('Europe/London', day(2026, 10, 25))?.toISOString()).toBe('2026-10-24T23:00:00.000Z');
    expect(dayStartIn('Europe/London', day(2026, 10, 26))?.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    // New York springs forward at 02:00 on 8 Mar 2026: midnight still exists.
    expect(dayStartIn('America/New_York', day(2026, 3, 8))?.toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });

  it('never puts the start on the day before when midnight itself is skipped', () => {
    // Santiago springs forward at 00:00 on 6 Sep 2026 (00:00 -> 01:00): the day starts at 01:00 local.
    const start = dayStartIn('America/Santiago', day(2026, 9, 6))!;
    expect(start).not.toBeNull();
    expect(todayIn('America/Santiago', start)).toEqual(day(2026, 9, 6));
    expect(todayIn('America/Santiago', new Date(start.getTime() - 1000))).toEqual(day(2026, 9, 5));
  });
});

describe('promiseState (PT7)', () => {
  const dueFrom = new Date('2026-11-17T18:30:00Z');
  const dueUntil = new Date('2026-11-18T18:30:00Z');
  it('is upcoming before the day, due today during it, then missed or followed up', () => {
    expect(promiseState({ dueFrom, dueUntil, followedUp: false }, new Date('2026-11-17T18:29:59Z'))).toBe('upcoming');
    expect(promiseState({ dueFrom, dueUntil, followedUp: false }, dueFrom)).toBe('due_today');
    expect(promiseState({ dueFrom, dueUntil, followedUp: true }, new Date('2026-11-18T18:29:59Z'))).toBe('due_today');
    expect(promiseState({ dueFrom, dueUntil, followedUp: false }, dueUntil)).toBe('missed');
    expect(promiseState({ dueFrom, dueUntil, followedUp: true }, dueUntil)).toBe('followed_up');
  });
});

describe('followUpDay (PT2)', () => {
  it('counts calendar days, across months and years', () => {
    expect(followUpDay(day(2026, 11, 28), 3)).toEqual(day(2026, 12, 1));
    expect(followUpDay(day(2026, 12, 30), 14)).toEqual(day(2027, 1, 13));
  });
});

describe('validatePromiseFields (PT8)', () => {
  const today = day(2026, 11, 15);
  const ptp = { requires_promise: true };
  it('takes a date and an optional amount on a promise entry', () => {
    expect(validatePromiseFields(ptp, { promise_date: '2026-11-18' }, today))
      .toEqual({ ok: true, promise: { day: day(2026, 11, 18), date: '2026-11-18', amount: null } });
    expect(validatePromiseFields(ptp, { promise_date: '2026-11-18', promise_amount: '12500' }, today))
      .toEqual({ ok: true, promise: { day: day(2026, 11, 18), date: '2026-11-18', amount: '12500.00' } });
    expect(validatePromiseFields(ptp, { promise_date: '2026-11-18', promise_amount: '' }, today))
      .toEqual({ ok: true, promise: { day: day(2026, 11, 18), date: '2026-11-18', amount: null } });
  });
  it('needs the date, refuses a bad date or amount', () => {
    expect(validatePromiseFields(ptp, {}, today)).toEqual({ ok: false, code: 'promise_required' });
    expect(validatePromiseFields(ptp, { promise_amount: '5' }, today)).toEqual({ ok: false, code: 'promise_required' });
    expect(validatePromiseFields(ptp, { promise_date: '2026-11-14' }, today)).toEqual({ ok: false, code: 'invalid_promise_date' });
    expect(validatePromiseFields(ptp, { promise_date: '2026-11-18', promise_amount: '-5' }, today))
      .toEqual({ ok: false, code: 'invalid_promise_amount' });
  });
  it('refuses a promise on an entry that does not ask for one, and passes an entry without one', () => {
    expect(validatePromiseFields({}, { promise_date: '2026-11-18' }, today)).toEqual({ ok: false, code: 'promise_not_expected' });
    expect(validatePromiseFields({}, { promise_amount: '1' }, today)).toEqual({ ok: false, code: 'promise_not_expected' });
    expect(validatePromiseFields({ requires_promise: 'yes' }, { promise_date: '2026-11-18' }, today))
      .toEqual({ ok: false, code: 'promise_not_expected' });
    expect(validatePromiseFields({}, {}, today)).toEqual({ ok: true, promise: null });
    expect(validatePromiseFields({}, { promise_date: null, promise_amount: '' }, today)).toEqual({ ok: true, promise: null });
  });
});
