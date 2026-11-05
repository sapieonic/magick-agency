import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  addDaysToDay,
  allowedBuckets,
  defaultBucket,
  insightsRangeQuery,
  rangeChoiceFromParams,
  rangeChoiceToParams,
  resolveInsightsRange,
  servedRangeView,
  zoneDay,
  zoneDayStart,
} from '../../utils/agency/insights/range';

/**
 * The Insights range in the CAMPAIGN's zone, never the reader's.
 *
 * ── Why this file is `.timezone.test.ts` ───────────────────────────────────
 * The claim is that the reader's clock does not leak into the range. The suite
 * is pinned to UTC, where "the reader's zone" and "UTC" are the same thing and
 * the claim cannot fail; this project runs on `pool: 'forks'`, where moving
 * `TZ` moves the clock, so the reader is put in Los Angeles while the campaign
 * dials Pune (Asia/Kolkata, UTC+05:30 all year).
 *
 * Expectations are UTC instants: they are what goes on the wire.
 */

const KOLKATA = 'Asia/Kolkata';
let previousTz: string | undefined;
beforeAll(() => {
  previousTz = process.env['TZ'];
  process.env['TZ'] = 'America/Los_Angeles';
});
afterAll(() => {
  if (previousTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = previousTz;
});

// 2026-11-04 01:00 UTC = 06:30 in Kolkata (4 Nov) = 18:00 on 3 Nov in Los Angeles.
const NOW = new Date('2026-11-04T01:00:00.000Z');

describe('the campaign zone decides the day', () => {
  it('reads today as the Kolkata day even when the reader is still on yesterday', () => {
    expect(new Date(NOW).getDate()).toBe(3); // the reader's own calendar says the 3rd
    expect(zoneDay(KOLKATA, NOW)).toBe('2026-11-04');
  });

  it('starts a Kolkata day at 18:30 UTC the day before', () => {
    expect(zoneDayStart('2026-11-04', KOLKATA).toISOString()).toBe('2026-11-03T18:30:00.000Z');
  });

  it('starts a day at its first real instant where midnight does not exist', () => {
    // Asia/Beirut springs forward at 00:00 on 2026-03-29: 00:00–00:59 never happens.
    const start = zoneDayStart('2026-03-29', 'Asia/Beirut');
    expect(zoneDay('Asia/Beirut', start)).toBe('2026-03-29');
    expect(zoneDay('Asia/Beirut', new Date(start.getTime() - 1))).toBe('2026-03-28');
  });
});

describe('presets, sent as UTC instants', () => {
  it('Today runs from the zone midnight to now (never into the future)', () => {
    const range = resolveInsightsRange({ preset: 'today' }, KOLKATA, NOW);
    expect(insightsRangeQuery(range)).toEqual({ from: '2026-11-03T18:30:00.000Z', to: '2026-11-04T01:00:00.000Z' });
    expect(range.label).toBe('Today');
  });

  it('Yesterday is the whole previous Kolkata day, half-open', () => {
    const range = resolveInsightsRange({ preset: 'yesterday' }, KOLKATA, NOW);
    expect(insightsRangeQuery(range)).toEqual({ from: '2026-11-02T18:30:00.000Z', to: '2026-11-03T18:30:00.000Z' });
  });

  it('Last 7 days is today and the six before it', () => {
    const range = resolveInsightsRange({ preset: 'last_7_days' }, KOLKATA, NOW);
    expect(range.from).toBe('2026-10-28T18:30:00.000Z');
    expect(range.to).toBe(NOW.toISOString());
  });

  it('Lifetime sends nothing at all', () => {
    const range = resolveInsightsRange({ preset: 'lifetime' }, KOLKATA, NOW);
    expect(range.lifetime).toBe(true);
    expect(insightsRangeQuery(range)).toEqual({});
  });

  it('a custom range covers both days whole, in the campaign zone', () => {
    const range = resolveInsightsRange({ preset: 'custom', fromDay: '2026-11-01', toDay: '2026-11-02' }, KOLKATA, NOW);
    expect(insightsRangeQuery(range)).toEqual({ from: '2026-10-31T18:30:00.000Z', to: '2026-11-02T18:30:00.000Z' });
    expect(range.error).toBeNull();
  });

  it('refuses a custom range that is backwards, in the future or too long', () => {
    expect(resolveInsightsRange({ preset: 'custom', fromDay: '2026-11-03', toDay: '2026-11-01' }, KOLKATA, NOW).error)
      .toBe('The start date is after the end date.');
    expect(resolveInsightsRange({ preset: 'custom', fromDay: '2026-11-05', toDay: '2026-11-06' }, KOLKATA, NOW).error)
      .toBe('The range starts in the future.');
    expect(resolveInsightsRange({ preset: 'custom', fromDay: '2026-01-01', toDay: '2026-11-04' }, KOLKATA, NOW).error)
      .toBe('A range can cover at most 92 days.');
  });

  it('falls back to UTC, and says so, for a zone Intl does not know', () => {
    const range = resolveInsightsRange({ preset: 'today' }, 'Mars/Olympus_Mons', NOW);
    expect(range.zoneFallback).toBe(true);
    expect(range.timezone).toBe('UTC');
    expect(range.from).toBe('2026-11-04T00:00:00.000Z');
  });
});

describe('the range in the URL', () => {
  it('round-trips each preset and a custom range, keeping unrelated params', () => {
    for (const preset of ['today', 'yesterday', 'last_7_days'] as const) {
      const params = rangeChoiceToParams({ preset }, new URLSearchParams('keep=1'));
      expect(params.get('keep')).toBe('1');
      expect(rangeChoiceFromParams(params)).toEqual({ preset });
    }
    const custom = rangeChoiceToParams({ preset: 'custom', fromDay: '2026-11-01', toDay: '2026-11-03' });
    expect(custom.toString()).toBe('from=2026-11-01&to=2026-11-03');
    expect(rangeChoiceFromParams(custom)).toEqual({ preset: 'custom', fromDay: '2026-11-01', toDay: '2026-11-03' });
  });

  it('spells Last 7 days as range=7d, and clears a custom range when a preset is chosen', () => {
    const params = rangeChoiceToParams({ preset: 'last_7_days' }, new URLSearchParams('from=2026-11-01&to=2026-11-03'));
    expect(params.toString()).toBe('range=7d');
    expect(rangeChoiceToParams({ preset: 'lifetime' }, params).toString()).toBe('');
  });

  it('reads anything it does not recognise as the lifetime', () => {
    expect(rangeChoiceFromParams(new URLSearchParams('range=fortnight'))).toEqual({ preset: 'lifetime' });
    expect(rangeChoiceFromParams(new URLSearchParams('from=2026-02-30&to=2026-03-01'))).toEqual({ preset: 'lifetime' });
  });
});

describe('bucket widths', () => {
  it('offers quarter hours and hours for a day, and defaults to hours', () => {
    const today = resolveInsightsRange({ preset: 'today' }, KOLKATA, NOW);
    expect(allowedBuckets(today, null, NOW)).toEqual(['quarter_hour', 'hour', 'day']);
    expect(defaultBucket(today, null, NOW)).toBe('hour');
  });

  it('offers no quarter hours over a week, and defaults to days', () => {
    const week = resolveInsightsRange({ preset: 'last_7_days' }, KOLKATA, NOW);
    expect(allowedBuckets(week, null, NOW)).toEqual(['hour', 'day']);
    expect(defaultBucket(week, null, NOW)).toBe('day');
  });

  it('measures a lifetime from the campaign start, and offers days alone when that is unknown', () => {
    const lifetime = resolveInsightsRange({ preset: 'lifetime' }, KOLKATA, NOW);
    expect(allowedBuckets(lifetime, null, NOW)).toEqual(['day']);
    expect(allowedBuckets(lifetime, '2026-11-03T20:00:00.000Z', NOW)).toEqual(['quarter_hour', 'hour', 'day']);
  });
});

describe('the lifetime the server served', () => {
  const lifetime = resolveInsightsRange({ preset: 'lifetime' }, KOLKATA, NOW);
  const served = { from: '2026-08-04T01:00:00.000Z', to: '2026-11-04T01:00:00.000Z', lifetime: true };

  it('a clamped lifetime is "Last 92 days" and sends its window; an unclamped one stays "Lifetime" and sends none', () => {
    expect(servedRangeView(lifetime, { ...served, clamped: true })).toEqual({ label: 'Last 92 days', query: { from: served.from, to: served.to } });
    expect(servedRangeView(lifetime, { ...served, clamped: false })).toEqual({ label: 'Lifetime', query: {} });
    // Before the range reads answer, the choice's own label.
    expect(servedRangeView(lifetime, null)).toEqual({ label: 'Lifetime', query: {} });
  });

  it('an explicit range keeps its own label and instants whatever the answer says', () => {
    const today = resolveInsightsRange({ preset: 'today' }, KOLKATA, NOW);
    expect(servedRangeView(today, { ...served, lifetime: false, clamped: false })).toEqual({ label: 'Today', query: insightsRangeQuery(today) });
  });

  it('measures an old campaign\'s lifetime as the 92 days the server serves', () => {
    expect(defaultBucket(lifetime, '2025-01-01T00:00:00.000Z', NOW)).toBe('day');
    expect(allowedBuckets(lifetime, '2025-01-01T00:00:00.000Z', NOW)).toEqual(['day']);
  });
});

describe('day arithmetic', () => {
  it('adds calendar days across a month end', () => {
    expect(addDaysToDay('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDaysToDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});
