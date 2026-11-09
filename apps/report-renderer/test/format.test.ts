import { describe, expect, it } from 'vitest';
import { bucketDate, clockTime, count, dateTime, dayHours, dayLabel, duration, hoursIntoDay, localDayStart, wallClockInto, pct, rangeLabel, rate, rateText, servedRate } from '../src/format';
import { excelValue, localExcelDate } from '../src/xlsx/sheet';

describe('format', () => {
  it('writes counts with lakh grouping (the console’s en-IN) and trims percentages', () => {
    expect(count(1234567)).toBe('12,34,567');
    expect(pct(18)).toBe('18%');
    expect(pct(18.44)).toBe('18.4%');
  });

  it('writes durations compactly, hours past a day', () => {
    expect(duration(41)).toBe('41 s');
    expect(duration(198)).toBe('3 m 18 s');
    expect(duration(511_800)).toBe('142 h 10 m');
  });

  it('writes dates British style and times in the zone, 24-hour', () => {
    expect(rangeLabel('2026-10-09', '2026-11-07')).toBe('9 Oct – 7 Nov 2026');
    expect(dayLabel('2026-11-07')).toBe('Sat 7 Nov');
    expect(clockTime('2026-11-07T12:34:00Z', 'Asia/Kolkata')).toBe('18:04');
    expect(dateTime('2026-11-08T03:30:00Z', 'Asia/Kolkata')).toBe('8 Nov 2026 09:00');
    expect(hoursIntoDay('2026-11-07T04:00:00Z', '2026-11-07', 'Asia/Kolkata')).toBeCloseTo(9.5, 6);
  });

  it('turns a rate with no denominator or below its floor into words, never 0', () => {
    expect(rateText(rate(0, 0, 25))).toBe('No calls to rate');
    expect(rateText(rate(3, 24, 25))).toBe('Not enough calls to rate');
    expect(rateText(rate(10, 25, 25))).toBe('40%');
    expect(rateText(servedRate(36.4, false))).toBe('Not enough calls to rate');
    expect(rateText(servedRate(null, true))).toBe('No calls to rate');
  });
});

describe('workbook cells', () => {
  it('shows an instant at its wall clock in the zone, across a clock change', () => {
    expect(localExcelDate('2026-10-09T03:41:00Z', 'Asia/Kolkata').toISOString()).toBe('2026-10-09T09:11:00.000Z');
    expect(localExcelDate('2026-10-25T00:30:00Z', 'Europe/London').toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(localExcelDate('2026-10-25T01:30:00Z', 'Europe/London').toISOString()).toBe('2026-10-25T01:30:00.000Z');
  });

  it('converts units and keeps words as text', () => {
    expect(excelValue(90, 'duration_s', 'UTC')).toBeCloseTo(90 / 86400, 12);
    expect(excelValue(42.5, 'percent', 'UTC')).toBeCloseTo(0.425, 12);
    expect(excelValue('Not enough calls to rate', 'percent', 'UTC')).toBe('Not enough calls to rate');
    expect(excelValue(null, 'int', 'UTC')).toBeNull();
    expect(excelValue('2026-10-09', 'date', 'UTC')).toEqual(new Date('2026-10-09T00:00:00Z'));
  });

  it('dates a trend bucket by its bucket_start: a day as served, an instant in the zone', () => {
    expect(bucketDate('2026-10-11', 'Asia/Kolkata')).toBe('2026-10-11');
    // 20:00 UTC on 10 Oct is already 11 Oct in Kolkata.
    expect(bucketDate('2026-10-10T20:00:00.000Z', 'Asia/Kolkata')).toBe('2026-10-11');
    expect(bucketDate('2026-10-10T20:00:00.000Z', 'Europe/London')).toBe('2026-10-10');
  });

  it('measures a day by elapsed time, 23 or 25 hours on a clock change', () => {
    expect(dayHours('2026-10-24', 'Europe/London')).toBe(24);
    expect(dayHours('2026-10-25', 'Europe/London')).toBe(25);
    expect(dayHours('2026-03-29', 'Europe/London')).toBe(23);
    expect(dayHours('2026-11-07', 'Asia/Kolkata')).toBe(24);
    expect(new Date(localDayStart('2026-10-25', 'Europe/London')).toISOString()).toBe('2026-10-24T23:00:00.000Z');
    // 01:30 GMT, the second 01:30 of the day: two and a half hours in, not one and a half.
    expect(hoursIntoDay('2026-10-25T01:30:00Z', '2026-10-25', 'Europe/London')).toBeCloseTo(2.5, 6);
    expect(hoursIntoDay('2026-10-25T00:30:00Z', '2026-10-25', 'Europe/London')).toBeCloseTo(1.5, 6);
    expect(wallClockInto(1, '2026-10-25', 'Europe/London')).toBe('01');
    expect(wallClockInto(2, '2026-10-25', 'Europe/London')).toBe('01');
    expect(wallClockInto(1, '2026-03-29', 'Europe/London')).toBe('02');
    // Midnight that does not exist (Santiago's clocks skip from 00:00 to 01:00): the day starts after the gap.
    expect(new Date(localDayStart('2026-09-06', 'America/Santiago')).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(dayHours('2026-09-06', 'America/Santiago')).toBe(23);
  });
});
