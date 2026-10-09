import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createPollBackoff,
  parseRetryAfterHeader,
  retryAfterSecondsFromError,
  retryAfterSecondsFromUnknown,
} from '../../utils/poll-backoff';

describe('parseRetryAfterHeader', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterHeader('12')).toBe(12);
  });

  it('treats Retry-After: 0 as retry immediately, not a 60s default', () => {
    expect(parseRetryAfterHeader('0')).toBe(0);
    expect(retryAfterSecondsFromUnknown(429, { error: 'Too Many Requests' }, undefined, '0')).toBe(0);
  });

  it('returns null for empty or junk', () => {
    expect(parseRetryAfterHeader(null)).toBeNull();
    expect(parseRetryAfterHeader('')).toBeNull();
    expect(parseRetryAfterHeader('nope')).toBeNull();
  });

  it('reads an HTTP-date as seconds from now', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T04:09:00Z'));
    try {
      expect(parseRetryAfterHeader('Mon, 07 Sep 2026 04:09:30 GMT')).toBe(30);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('retryAfterSecondsFromUnknown', () => {
  it('prefers the Retry-After header over the body', () => {
    expect(retryAfterSecondsFromUnknown(
      429,
      { retryAfter: 99, message: 'Rate limit exceeded. Try again in 7 seconds.' },
      undefined,
      '15',
    )).toBe(15);
  });

  it('reads the API\'s retryAfter body field', () => {
    expect(retryAfterSecondsFromUnknown(429, { retryAfter: 22 })).toBe(22);
  });

  it('parses "Try again in N seconds"', () => {
    expect(retryAfterSecondsFromUnknown(
      429,
      { message: 'Rate limit exceeded. Try again in 8 seconds.' },
    )).toBe(8);
  });

  it('defaults a bare 429 to 60 seconds', () => {
    expect(retryAfterSecondsFromUnknown(429, { error: 'Too Many Requests' })).toBe(60);
  });

  it('does not invent a wait for a non-429', () => {
    expect(retryAfterSecondsFromUnknown(500, { message: 'boom' })).toBeNull();
  });
});

describe('retryAfterSecondsFromError', () => {
  it('honours a structured retryAfterSeconds field', () => {
    expect(retryAfterSecondsFromError({
      statusCode: 429,
      retryAfterSeconds: 9,
      details: { message: 'Rate limit exceeded. Try again in 99 seconds.' },
    })).toBe(9);
  });
});

describe('createPollBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T04:09:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips ticks until the parsed wait elapses', () => {
    const backoff = createPollBackoff();
    expect(backoff.isCoolingDown()).toBe(false);
    backoff.note({
      statusCode: 429,
      details: { message: 'Rate limit exceeded. Try again in 45 seconds.' },
      message: 'Rate limit exceeded. Try again in 45 seconds.',
    });
    expect(backoff.isCoolingDown()).toBe(true);
    vi.advanceTimersByTime(44_000);
    expect(backoff.isCoolingDown()).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(backoff.isCoolingDown()).toBe(false);
  });

  it('ignores non-429 errors', () => {
    const backoff = createPollBackoff();
    backoff.note(new Error('boom'));
    expect(backoff.isCoolingDown()).toBe(false);
  });

  it('Retry-After: 0 does not start a cooldown', () => {
    const backoff = createPollBackoff();
    backoff.note({ statusCode: 429, retryAfterSeconds: 0 });
    expect(backoff.isCoolingDown()).toBe(false);
  });
});
