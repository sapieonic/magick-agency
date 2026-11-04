import { describe, expect, it } from 'vitest';
import {
  ceilToBucket,
  floorToBucket,
  INSIGHTS_MAX_TREND_BUCKETS,
  parseInsightsRange,
  parseInstant,
  rangeCacheSuffix,
} from '../../../src/agency/insights/range.js';

/**
 * The range reads' query (`src/agency/insights/range.ts`): what is accepted, what is refused, and
 * the range that is served (rounded to the rollup's 15-minute buckets, never past now).
 */

const NOW = new Date('2026-11-04T10:12:34.000Z');
const CREATED = new Date('2026-10-20T08:07:00.000Z');
const parse = (query: Record<string, unknown>, bucket = false) => parseInsightsRange(query, { createdAt: CREATED, now: NOW, bucket });
const served = (query: Record<string, unknown>, bucket = false) => {
  const r = parse(query, bucket);
  if (!r.ok) throw new Error(r.message);
  return { from: r.range.from.toISOString(), to: r.range.to.toISOString(), lifetime: r.range.lifetime, bucket: r.range.bucket };
};
const refused = (query: Record<string, unknown>, bucket = false) => {
  const r = parse(query, bucket);
  return r.ok ? null : r.message;
};

describe('parseInstant', () => {
  it('reads an instant with a zone, any precision', () => {
    expect(parseInstant('2026-11-03T18:30:00.000Z')?.toISOString()).toBe('2026-11-03T18:30:00.000Z');
    expect(parseInstant('2026-11-04T00:00+05:30')?.toISOString()).toBe('2026-11-03T18:30:00.000Z');
    expect(parseInstant('2026-11-04T00:00:00.123456-04:00')?.toISOString()).toBe('2026-11-04T04:00:00.123Z');
  });

  it('refuses a bare date, a wall-clock time, a rolled-over day and garbage', () => {
    for (const text of ['2026-11-04', '2026-11-04T10:00:00', '2026-02-30T00:00:00Z', '2026-11-04T24:30:00Z', 'yesterday', '', '2026-11-04T10:00:00+25:00']) {
      expect(parseInstant(text), text).toBeNull();
    }
  });
});

describe('bucket rounding', () => {
  it('floors and ceils to quarter hours, a boundary staying put', () => {
    expect(floorToBucket(new Date('2026-11-04T10:14:59.999Z')).toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(ceilToBucket(new Date('2026-11-04T10:00:00.001Z')).toISOString()).toBe('2026-11-04T10:15:00.000Z');
    expect(ceilToBucket(new Date('2026-11-04T10:15:00.000Z')).toISOString()).toBe('2026-11-04T10:15:00.000Z');
  });
});

describe('parseInsightsRange', () => {
  it('lifetime: created_at rounded down to the bucket now falls in', () => {
    expect(served({})).toEqual({ from: '2026-10-20T08:00:00.000Z', to: '2026-11-04T10:15:00.000Z', lifetime: true, bucket: null });
  });

  it('rounds an asked range out to whole buckets and echoes it', () => {
    expect(served({ from: '2026-11-03T18:37:00Z', to: '2026-11-04T09:01:00Z' }))
      .toEqual({ from: '2026-11-03T18:30:00.000Z', to: '2026-11-04T09:15:00.000Z', lifetime: false, bucket: null });
  });

  it('a range reaching past now ends at the bucket now falls in (no future zeros)', () => {
    expect(served({ from: '2026-11-03T18:30:00Z', to: '2026-11-04T18:30:00Z' }).to).toBe('2026-11-04T10:15:00.000Z');
  });

  it('one bound alone keeps the other default', () => {
    expect(served({ from: '2026-11-04T00:00:00Z' })).toMatchObject({ from: '2026-11-04T00:00:00.000Z', to: '2026-11-04T10:15:00.000Z', lifetime: false });
    expect(served({ to: '2026-10-21T00:00:00Z' })).toMatchObject({ from: '2026-10-20T08:00:00.000Z', to: '2026-10-21T00:00:00.000Z', lifetime: false });
  });

  it('refuses an inverted, empty or future range', () => {
    expect(refused({ from: '2026-11-04T00:00:00Z', to: '2026-11-03T00:00:00Z' })).toBe('from must be before to.');
    expect(refused({ from: '2026-11-04T00:00:00Z', to: '2026-11-04T00:00:00Z' })).toBe('from must be before to.');
    expect(refused({ from: '2026-11-05T00:00:00Z', to: '2026-11-06T00:00:00Z' })).toBe('The range starts in the future.');
  });

  it('92 calendar days pass, a clock change\'s hour included; one more is refused', () => {
    // 92 days in a zone that falls back an hour inside them: 92 × 24 h + 1 h.
    expect(parse({ from: '2026-08-01T04:00:00Z', to: '2026-11-01T05:00:00Z' }).ok).toBe(true);
    expect(refused({ from: '2026-08-01T00:00:00Z', to: '2026-11-02T00:00:00Z' })).toBe('A range can cover at most 92 days.');
  });

  it('the lifetime is never refused for its length', () => {
    const old = parseInsightsRange({}, { createdAt: new Date('2025-01-01T00:00:00Z'), now: NOW, bucket: true });
    expect(old.ok && old.range.bucket).toBe('day');
  });

  it('refuses unknown and repeated keys, and a bucket on a read that takes none', () => {
    expect(refused({ since: '2026-11-04T00:00:00Z' })).toBe('Unknown parameter: since.');
    expect(refused({ from: ['2026-11-04T00:00:00Z', '2026-11-03T00:00:00Z'] })).toBe('from must be given once.');
    expect(refused({ bucket: 'hour' })).toBe('This read takes no bucket.');
    expect(refused({ from: '2026-11-04' })).toMatch(/^from must be an ISO-8601 instant with a zone/);
  });

  it('bucket: validated, defaulting to hour up to 48 h and day beyond', () => {
    expect(served({ from: '2026-11-03T00:00:00Z' }, true).bucket).toBe('hour');
    expect(served({ from: '2026-11-01T00:00:00Z' }, true).bucket).toBe('day');
    expect(served({ from: '2026-11-01T00:00:00Z', bucket: 'quarter_hour' }, true).bucket).toBe('quarter_hour');
    expect(refused({ bucket: 'week' }, true)).toBe('bucket must be one of quarter_hour, hour, day.');
  });

  it('refuses a series longer than 92 days of quarter hours', () => {
    const year = parseInsightsRange({ bucket: 'quarter_hour' }, { createdAt: new Date('2025-11-01T00:00:00Z'), now: NOW, bucket: true });
    expect(year.ok).toBe(false);
    expect(year.ok ? '' : year.message).toBe(`That range has more than ${INSIGHTS_MAX_TREND_BUCKETS} quarter hour buckets: choose a wider bucket.`);
    expect(parse({ from: '2026-08-04T10:15:00Z', bucket: 'quarter_hour' }, true).ok).toBe(true);
  });

  it('a lifetime read the instant a campaign is made still serves one bucket', () => {
    const r = parseInsightsRange({}, { createdAt: NOW, now: NOW, bucket: false });
    expect(r.ok && [r.range.from.toISOString(), r.range.to.toISOString()]).toEqual(['2026-11-04T10:00:00.000Z', '2026-11-04T10:15:00.000Z']);
  });

  it('the cache names the served range and the bucket', () => {
    const a = parse({ from: '2026-11-04T00:00:00Z', to: '2026-11-04T10:01:00Z' }, true);
    const b = parse({ from: '2026-11-04T00:00:00Z', to: '2026-11-04T10:14:00Z' }, true);
    const c = parse({ from: '2026-11-04T00:00:00Z', to: '2026-11-04T10:14:00Z', bucket: 'quarter_hour' }, true);
    if (!a.ok || !b.ok || !c.ok) throw new Error('refused');
    expect(rangeCacheSuffix(a.range)).toBe(rangeCacheSuffix(b.range));
    expect(rangeCacheSuffix(c.range)).not.toBe(rangeCacheSuffix(b.range));
  });
});
