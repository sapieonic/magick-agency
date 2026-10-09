import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDate,
  formatDateShort,
  formatTime,
  formatRelativeTime,
  formatDuration,
  formatPhone,
  formatNumber,
  formatPercentage,
  truncateId,
} from '../../utils/format';

// ─── formatDuration ───────────────────────────────────────────────────────────

describe('formatDuration', () => {
  // null / undefined / zero / negative guard
  it('returns -- for null', () => expect(formatDuration(null)).toBe('--'));
  it('returns -- for undefined', () => expect(formatDuration(undefined)).toBe('--'));
  it('returns -- for 0', () => expect(formatDuration(0)).toBe('--'));
  it('returns -- for negative values', () => expect(formatDuration(-1)).toBe('--'));
  it('returns -- for -0', () => expect(formatDuration(-0)).toBe('--'));

  // sub-minute
  it('formats 1 second', () => expect(formatDuration(1)).toBe('0:01'));
  it('formats 9 seconds with leading zero', () => expect(formatDuration(9)).toBe('0:09'));
  it('formats 59 seconds', () => expect(formatDuration(59)).toBe('0:59'));

  // minute boundaries
  it('formats 60 seconds as 1:00', () => expect(formatDuration(60)).toBe('1:00'));
  it('formats 61 seconds as 1:01', () => expect(formatDuration(61)).toBe('1:01'));
  it('formats 65 seconds as 1:05', () => expect(formatDuration(65)).toBe('1:05'));
  it('formats 120 seconds as 2:00', () => expect(formatDuration(120)).toBe('2:00'));

  // over an hour (no hour component — just minutes overflow)
  it('formats 3600 seconds as 60:00', () => expect(formatDuration(3600)).toBe('60:00'));
  it('formats 3661 seconds as 61:01', () => expect(formatDuration(3661)).toBe('61:01'));
});

// There are no credit formatters (agency has no credits), so no cases cover
// `formatCredits`, `formatLedgerMillicredits` or `formatCreditsExact`.

describe('formatPhone', () => {
  // falsy guards
  it('returns -- for null', () => expect(formatPhone(null)).toBe('--'));
  it('returns -- for undefined', () => expect(formatPhone(undefined)).toBe('--'));
  it('returns -- for empty string', () => expect(formatPhone('')).toBe('--'));

  // valid Indian number — exactly 13 chars starting with +91
  it('formats a valid +91 number (13 chars)', () =>
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210'));
  it('splits digits as +91 [5 digits] [5 digits]', () => {
    const result = formatPhone('+919876543210');
    const parts = result.split(' ');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('+91');
    expect(parts[1]).toHaveLength(5);
    expect(parts[2]).toHaveLength(5);
  });

  // off-by-one lengths — must not be formatted
  it('returns +91 numbers with 12 chars as-is (too short)', () =>
    expect(formatPhone('+91987654321')).toBe('+91987654321'));
  it('returns +91 numbers with 14 chars as-is (too long)', () =>
    expect(formatPhone('+9198765432101')).toBe('+9198765432101'));

  // non-Indian numbers
  it('returns non-+91 numbers as-is', () =>
    expect(formatPhone('+12025551234')).toBe('+12025551234'));
  it('returns plain numeric strings as-is', () =>
    expect(formatPhone('9876543210')).toBe('9876543210'));
});

// ─── formatPercentage ────────────────────────────────────────────────────────

describe('formatPercentage', () => {
  it('formats 0 as "0.0%"', () => expect(formatPercentage(0)).toBe('0.0%'));
  it('formats 0.5 as "50.0%"', () => expect(formatPercentage(0.5)).toBe('50.0%'));
  it('formats 1 as "100.0%"', () => expect(formatPercentage(1)).toBe('100.0%'));
  it('formats 0.123 as "12.3%"', () => expect(formatPercentage(0.123)).toBe('12.3%'));
  it('rounds to 1 decimal place', () => expect(formatPercentage(0.1234)).toBe('12.3%'));
  it('always ends with %', () => expect(formatPercentage(0.75)).toMatch(/%$/));
});

// ─── truncateId ──────────────────────────────────────────────────────────────

describe('truncateId', () => {
  it('truncates to the default length of 8', () =>
    expect(truncateId('abcdefghij')).toBe('abcdefgh'));
  it('truncates to a custom length', () =>
    expect(truncateId('abcdefghij', 4)).toBe('abcd'));
  it('returns the full string when it is shorter than the length', () =>
    expect(truncateId('abc', 8)).toBe('abc'));
  it('returns the full string when it exactly equals the length', () =>
    expect(truncateId('abcdefgh', 8)).toBe('abcdefgh'));
  it('returns empty string for empty input', () =>
    expect(truncateId('')).toBe(''));
  it('handles length 0', () =>
    expect(truncateId('abcdef', 0)).toBe(''));
  it('handles length 1', () =>
    expect(truncateId('abcdef', 1)).toBe('a'));
  it('preserves UUIDs correctly', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(truncateId(uuid, 8)).toBe('550e8400');
  });
});

// ─── formatNumber ────────────────────────────────────────────────────────────

describe('formatNumber', () => {
  it('formats 0', () => expect(formatNumber(0)).toBe('0'));
  it('formats single-digit numbers', () => expect(formatNumber(7)).toBe('7'));
  it('returns a string', () => expect(typeof formatNumber(1000)).toBe('string'));
  it('preserves all digits regardless of locale separators', () =>
    expect(formatNumber(12345).replace(/[,\s]/g, '')).toBe('12345'));
  it('preserves all digits for large numbers', () =>
    expect(formatNumber(9876543).replace(/[,\s]/g, '')).toBe('9876543'));
});

// ─── formatRelativeTime ───────────────────────────────────────────────────────

describe('formatRelativeTime', () => {
  const BASE = '2024-06-01T12:00:00Z';

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // "just now" bucket: < 60 seconds
  it('returns "just now" for 0 seconds elapsed', () => {
    vi.setSystemTime(new Date(BASE));
    expect(formatRelativeTime(BASE)).toBe('just now');
  });
  it('returns "just now" for 30 seconds elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:30Z'));
    expect(formatRelativeTime(BASE)).toBe('just now');
  });
  it('returns "just now" for exactly 59 seconds elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T12:00:59Z'));
    expect(formatRelativeTime(BASE)).toBe('just now');
  });

  // "Xm ago" bucket: 60 seconds – 59 minutes 59 seconds
  it('returns "1m ago" at exactly 60 seconds elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T12:01:00Z'));
    expect(formatRelativeTime(BASE)).toBe('1m ago');
  });
  it('returns "5m ago" for 5 minutes elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T12:05:00Z'));
    expect(formatRelativeTime(BASE)).toBe('5m ago');
  });
  it('returns "59m ago" at exactly 59 minutes elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T12:59:00Z'));
    expect(formatRelativeTime(BASE)).toBe('59m ago');
  });

  // "Xh ago" bucket: 1 hour – 23 hours 59 minutes
  it('returns "1h ago" at exactly 60 minutes elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T13:00:00Z'));
    expect(formatRelativeTime(BASE)).toBe('1h ago');
  });
  it('returns "2h ago" for 2 hours elapsed', () => {
    vi.setSystemTime(new Date('2024-06-01T14:00:00Z'));
    expect(formatRelativeTime(BASE)).toBe('2h ago');
  });
  it('returns "23h ago" at exactly 23 hours elapsed', () => {
    vi.setSystemTime(new Date('2024-06-02T11:00:00Z'));
    expect(formatRelativeTime(BASE)).toBe('23h ago');
  });

  // "Xd ago" bucket: 1 day – 6 days
  it('returns "1d ago" at exactly 24 hours elapsed', () => {
    vi.setSystemTime(new Date('2024-06-02T12:00:00Z'));
    expect(formatRelativeTime(BASE)).toBe('1d ago');
  });
  it('returns "2d ago" for 2 days elapsed', () => {
    vi.setSystemTime(new Date('2024-06-03T12:00:00Z'));
    expect(formatRelativeTime(BASE)).toBe('2d ago');
  });
  it('returns "6d ago" at exactly 6 days elapsed', () => {
    vi.setSystemTime(new Date('2024-06-07T12:00:00Z'));
    expect(formatRelativeTime(BASE)).toBe('6d ago');
  });

  // formatDateShort fallback: >= 7 days
  it('falls back to a short date string at exactly 7 days elapsed', () => {
    vi.setSystemTime(new Date('2024-06-08T12:00:00Z'));
    const result = formatRelativeTime(BASE);
    expect(result).not.toMatch(/ago$/);
    expect(result).not.toBe('just now');
  });
  it('falls back to a short date string for old timestamps', () => {
    vi.setSystemTime(new Date('2024-06-15T12:00:00Z'));
    const result = formatRelativeTime(BASE);
    expect(result).toContain('Jun');
  });
});

// ─── formatDate ───────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('returns a non-empty string', () =>
    expect(formatDate('2024-06-01T10:30:00Z').length).toBeGreaterThan(0));

  it('includes the year', () =>
    expect(formatDate('2024-06-01T10:30:00Z')).toContain('2024'));

  it('includes the month abbreviation', () =>
    expect(formatDate('2024-06-01T10:30:00Z')).toContain('Jun'));

  it('includes the day', () =>
    expect(formatDate('2024-01-15T10:30:00Z')).toContain('15'));

  it('contains a time separator (colon)', () =>
    expect(formatDate('2024-06-01T10:30:00Z')).toContain(':'));

  it('produces different output for different dates', () =>
    expect(formatDate('2024-01-01T00:00:00Z')).not.toBe(formatDate('2024-12-31T23:59:59Z')));
});

// ─── formatDateShort ─────────────────────────────────────────────────────────

describe('formatDateShort', () => {
  it('returns a non-empty string', () =>
    expect(formatDateShort('2024-06-01T10:30:00Z').length).toBeGreaterThan(0));

  it('does not include the year', () =>
    expect(formatDateShort('2024-06-01T10:30:00Z')).not.toContain('2024'));

  it('includes the month abbreviation', () =>
    expect(formatDateShort('2024-06-01T10:30:00Z')).toContain('Jun'));

  it('includes the day', () =>
    expect(formatDateShort('2024-01-15T10:30:00Z')).toContain('15'));

  it('produces different output for different months', () =>
    expect(formatDateShort('2024-01-01T00:00:00Z')).not.toBe(formatDateShort('2024-06-01T00:00:00Z')));
});

// ─── formatTime ──────────────────────────────────────────────────────────────

describe('formatTime', () => {
  it('returns a non-empty string', () =>
    expect(formatTime('2024-06-01T10:30:00Z').length).toBeGreaterThan(0));

  it('contains a time separator (colon)', () =>
    expect(formatTime('2024-06-01T10:30:00Z')).toContain(':'));

  it('produces different output for different times', () =>
    expect(formatTime('2024-06-01T08:00:00Z')).not.toBe(formatTime('2024-06-01T20:00:00Z')));
});
