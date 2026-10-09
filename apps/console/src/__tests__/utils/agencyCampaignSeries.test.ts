import { describe, expect, it } from 'vitest';
import { RATE_MIN_ATTEMPTS } from '../../utils/agencyCampaignPerformance';
import {
  CAMPAIGN_SERIES_MAX_DAYS,
  CAMPAIGN_SERIES_WINDOWS,
  CAMPAIGN_SERIES_WINDOW_LABELS,
  campaignSeriesRange,
  campaignSeriesRangeNotes,
  campaignSeriesReach,
  campaignSeriesWindows,
  campaignSeriesZoneNote,
  campaignSingleBucketNote,
  defaultCampaignSeriesWindow,
  rateCeiling,
  rateTrend,
  type CampaignLifespan,
  type CampaignSeriesRange,
  type CampaignSeriesWindow,
  type RateSeriesKey,
  type RateTrend,
} from '../../utils/agencyCampaignSeries';
import type { AgencyAgentStatsBucket } from '../../types/agency-stats';
import type { AgencyCampaignSeries } from '../../types/agency-campaign-series';

/**
 * The campaign workspace's TIME dimension, pinned.
 *
 * Two properties are what this file exists for, and both are the kind that
 * cannot be seen in a screenshot:
 *
 * 1. **`[from, to)` is half-open and `to` is derived.** Every assertion on an
 *    end instant checks it is midnight of the day AFTER the last day shown,
 *    never a `T23:59:59.999` literal — that literal resolves to the earlier
 *    offset wherever the clocks go back at midnight and silently drops the last
 *    local hour, which is the defect `agencyAttemptFilters` was fixed for.
 * 2. **A rate with no denominator is `null`, never `0`.** A day plotted at 0%
 *    because nothing was dialled draws a cliff into the middle of a campaign
 *    that simply was not running, and a supervisor acts on a cliff.
 *
 * `now` is passed explicitly everywhere rather than read off the wall clock, so
 * the boundary cases below (a campaign that ended earlier, an `ended_at` in the
 * future, a range longer than core's cap) are assertions rather than something
 * that happens to hold on the day the suite is run.
 *
 * The suite is pinned to `TZ=UTC` (see docs/reference/magick-comms-cusui/CLAUDE.md, "Testing Patterns"), which is
 * why an instant can be compared to a literal at all. Nothing here needs a
 * second zone: the one zone-sensitive derivation this module reaches —
 * `bucketDay`, for the bar labels — already has a `*.timezone.test.tsx` of its
 * own in `agencyBucketDates.timezone.test.tsx`, and asserting it again here
 * under UTC would pass whatever the code did.
 */

const MIDNIGHT_Z = /T00:00:00\.000Z$/;

/** A campaign's two range-bearing fields, and nothing else — see `CampaignLifespan`. */
/**
 * A campaign's lifespan.
 *
 * `finished` defaults to `false`, and an `ended_at` alone no longer makes a
 * campaign finished — that is the whole point of the field. A fixture that sets
 * `ended_at` without `finished` is describing a LIVE campaign carrying a stale
 * timestamp, which a mixed-version row really can produce; the tests below are
 * explicit about which they mean.
 */
function lifespan(over: Partial<CampaignLifespan> = {}): CampaignLifespan {
  return { started_at: null, ended_at: null, finished: false, ...over };
}

/** A campaign that has finished, however it ended. */
function ended(over: Partial<CampaignLifespan> = {}): CampaignLifespan {
  return lifespan({ finished: true, ...over });
}

function bucket(over: Partial<AgencyAgentStatsBucket> & { bucket_start: string }): AgencyAgentStatsBucket {
  return {
    attempts: 0,
    connected: 0,
    successes: 0,
    talk_seconds: 0,
    wrapup_seconds: 0,
    ...over,
  };
}

/** Days numbered from the 1st of August, so an index is readable in a failure. */
function day(index: number): string {
  return `2026-08-${String(index + 1).padStart(2, '0')}`;
}

function series(
  buckets: Array<Partial<AgencyAgentStatsBucket>>,
  over: Partial<AgencyCampaignSeries> = {},
): AgencyCampaignSeries {
  return {
    campaign_id: 'camp-1',
    bucket: 'day',
    buckets: buckets.map((b, index) => bucket({ bucket_start: day(index), ...b })),
    ...over,
  };
}

function lineOf(trend: RateTrend, key: RateSeriesKey) {
  const line = trend.lines.find((candidate) => candidate.key === key);
  if (!line) throw new Error(`no ${key} line`);
  return line;
}

// ── The range picker ────────────────────────────────────────────────────────

describe('campaignSeriesWindows', () => {
  it('offers "whole campaign" only when the campaign told us when it started', () => {
    const windows = campaignSeriesWindows(lifespan({ started_at: '2026-08-01T09:00:00.000Z' }));
    expect(windows).toEqual(['7d', '14d', '30d', 'life']);
  });

  it('withholds it for an absent, null or unparseable start', () => {
    // Falling back to 30 days and still calling it "Whole campaign" is a label
    // that lies on exactly the campaigns the option exists for.
    for (const started of [undefined, null, 'not-a-date', '']) {
      const windows = campaignSeriesWindows(lifespan({ started_at: started }));
      expect(windows).toEqual(['7d', '14d', '30d']);
      expect(windows).not.toContain('life');
    }
  });

  it('withholds it for a null campaign, and still offers the relative three', () => {
    expect(campaignSeriesWindows(null)).toEqual(['7d', '14d', '30d']);
  });

  it('never invents a window that has no label', () => {
    for (const window of CAMPAIGN_SERIES_WINDOWS) {
      expect(CAMPAIGN_SERIES_WINDOW_LABELS[window]).toBeTruthy();
    }
  });
});

describe('defaultCampaignSeriesWindow', () => {
  it('opens a finished campaign on its whole life', () => {
    // "Last 7 days" on a campaign that stopped three weeks ago is an empty chart
    // under a heading promising a trend, which is indistinguishable from a
    // broken one.
    expect(
      defaultCampaignSeriesWindow(
        ended({ started_at: '2026-06-01T00:00:00.000Z', ended_at: '2026-07-04T00:00:00.000Z' }),
      ),
    ).toBe<CampaignSeriesWindow>('life');
  });

  it('falls back to 14 days for a finished campaign whose start we were not told', () => {
    expect(
      defaultCampaignSeriesWindow(lifespan({ ended_at: '2026-07-04T00:00:00.000Z' })),
    ).toBe<CampaignSeriesWindow>('14d');
  });

  it('opens a live campaign on the last 14 days', () => {
    expect(
      defaultCampaignSeriesWindow(lifespan({ started_at: '2026-06-01T00:00:00.000Z' })),
    ).toBe<CampaignSeriesWindow>('14d');
    expect(defaultCampaignSeriesWindow(null)).toBe<CampaignSeriesWindow>('14d');
  });
});

describe('campaignSeriesRange', () => {
  const NOW = new Date('2026-08-27T15:30:00.000Z');

  it('ends on midnight of the day AFTER the last day shown', () => {
    const range = campaignSeriesRange('7d', lifespan(), NOW);
    // Half-open. A `T23:59:59.999` literal here is ambiguous wherever the clocks
    // go back at midnight and drops the last local hour.
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
    expect(range.to).toMatch(MIDNIGHT_Z);
    expect(range.to).not.toContain('23:59');
    expect(range.from).toMatch(MIDNIGHT_Z);
  });

  it('spans seven days INCLUSIVE of today for "last 7 days"', () => {
    const range = campaignSeriesRange('7d', lifespan(), NOW);
    expect(range.days).toBe(7);
    // Today and the six before it — not today and the seven before it.
    expect(range.from).toBe('2026-08-21T00:00:00.000Z');
  });

  it('spans the width each relative window names', () => {
    expect(campaignSeriesRange('14d', lifespan(), NOW).days).toBe(14);
    expect(campaignSeriesRange('14d', lifespan(), NOW).from).toBe('2026-08-14T00:00:00.000Z');
    expect(campaignSeriesRange('30d', lifespan(), NOW).days).toBe(30);
    expect(campaignSeriesRange('30d', lifespan(), NOW).from).toBe('2026-07-29T00:00:00.000Z');
  });

  it('ends a terminal campaign on its OWN last day, not today', () => {
    // Trailing weeks of structural zeros would compress the part of the chart
    // that has anything in it into the left quarter of the plot.
    const range = campaignSeriesRange(
      '7d',
      ended({ started_at: '2026-06-01T00:00:00.000Z', ended_at: '2026-08-03T18:00:00.000Z' }),
      NOW,
    );
    expect(range.to).toBe('2026-08-04T00:00:00.000Z');
    expect(range.from).toBe('2026-07-28T00:00:00.000Z');
    expect(range.days).toBe(7);
  });

  it('falls back to today when `ended_at` is in the future', () => {
    // Not a thing core produces, but clock skew between a server and a browser
    // is very ordinary — and a range ending tomorrow asks for a day that cannot
    // have happened.
    const range = campaignSeriesRange(
      '7d',
      ended({ ended_at: '2026-09-15T00:00:00.000Z' }),
      NOW,
    );
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
    // The range ends today, but the campaign is over: nothing more will be
    // dialled on it, so the last bar is finished and must not be qualified as
    // "still filling".
    expect(range.partialToday).toBe(false);
  });

  it('ignores an unparseable `ended_at` rather than throwing on it', () => {
    const range = campaignSeriesRange('7d', lifespan({ ended_at: 'whenever' }), NOW);
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
    expect(range.days).toBe(7);
  });

  it('floors a start after the last day at one day, never a negative span', () => {
    const range = campaignSeriesRange(
      'life',
      lifespan({ started_at: '2026-09-01T00:00:00.000Z' }),
      NOW,
    );
    expect(range.days).toBe(1);
    expect(range.clamped).toBe(false);
    expect(range.from).toBe('2026-08-27T00:00:00.000Z');
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
  });

  it('clamps a long life to the cap and keeps the MOST RECENT days', () => {
    const range = campaignSeriesRange(
      'life',
      lifespan({ started_at: '2025-01-01T00:00:00.000Z' }),
      NOW,
    );
    expect(range.days).toBe(CAMPAIGN_SERIES_MAX_DAYS);
    expect(range.clamped).toBe(true);
    // The most recent 92 days ending today — 2026-05-28 … 2026-08-27 inclusive.
    // A range anchored on the campaign's own start would begin in January 2025.
    expect(range.from).toBe('2026-05-28T00:00:00.000Z');
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
  });

  it('does not clamp a life that fits exactly inside the cap', () => {
    const range = campaignSeriesRange(
      'life',
      lifespan({ started_at: '2026-05-28T07:15:00.000Z' }),
      NOW,
    );
    expect(range.days).toBe(CAMPAIGN_SERIES_MAX_DAYS);
    expect(range.clamped).toBe(false);
    expect(range.from).toBe('2026-05-28T00:00:00.000Z');
  });

  it('serves a whole life shorter than the cap unclamped', () => {
    const range = campaignSeriesRange(
      'life',
      lifespan({ started_at: '2026-08-20T23:00:00.000Z' }),
      NOW,
    );
    expect(range.days).toBe(8);
    expect(range.clamped).toBe(false);
    expect(range.from).toBe('2026-08-20T00:00:00.000Z');
  });

  it('falls back to the 14-day width for `life` with no start, never to the epoch', () => {
    // The option is withheld in that state, but a caller can still pass it.
    const range = campaignSeriesRange('life', lifespan(), NOW);
    expect(range.days).toBe(14);
    expect(range.from).toBe('2026-08-14T00:00:00.000Z');
    expect(range.clamped).toBe(false);
  });

  it('marks the range partial only when its last day is today', () => {
    expect(campaignSeriesRange('7d', lifespan(), NOW).partialToday).toBe(true);
    expect(
      campaignSeriesRange('7d', ended({ ended_at: '2026-08-03T00:00:00.000Z' }), NOW)
        .partialToday,
    ).toBe(false);
  });

  it('IGNORES an `ended_at` on a campaign whose status says it is still live', () => {
    /*
      A mixed-version row can carry a timestamp that does not mean "this campaign
      is over". Reading it unguarded truncated a RUNNING campaign to that date —
      "Last 7 days" came back as seven empty bars from last month, and
      `partialToday` was false so nothing said today was still filling. Status is
      the authority here as well as in the default window.
    */
    const range = campaignSeriesRange(
      '7d',
      lifespan({ finished: false, ended_at: '2026-07-03T00:00:00.000Z' }),
      NOW,
    );
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
    expect(range.partialToday).toBe(true);
  });

  it('does not call a campaign that STOPPED today still filling', () => {
    /**
     * `lastDay` is today either way, so a range-level check alone would qualify
     * this one. But "today is still in progress" is a claim about a LIVE
     * campaign whose last day happens to be today — a campaign that stopped at
     * 09:00 has a finished last bar, and telling a supervisor it will keep
     * growing is telling them to come back to a number that will not move.
     */
    const range = campaignSeriesRange(
      '7d',
      ended({ ended_at: '2026-08-27T09:00:00.000Z' }),
      NOW,
    );
    expect(range.partialToday).toBe(false);
    expect(range.to).toBe('2026-08-28T00:00:00.000Z');
  });
});

describe('campaignSeriesRangeNotes', () => {
  const base = { from: 'x', to: 'y', days: 7, endUnknown: false };

  it('says nothing when there is nothing to qualify', () => {
    expect(campaignSeriesRangeNotes({ ...base, clamped: false, partialToday: false })).toEqual([]);
  });

  it('names the cap when the range was cut', () => {
    const notes = campaignSeriesRangeNotes({ ...base, clamped: true, partialToday: false });
    expect(notes).toHaveLength(1);
    // An invisible truncation on a chart is a chart that lies about what it
    // covers, so the number is in the sentence.
    expect(notes[0]).toContain(String(CAMPAIGN_SERIES_MAX_DAYS));
    expect(notes[0]).toContain('most recent');
  });

  it('warns that today is still filling, in words that fit either chart', () => {
    const notes = campaignSeriesRangeNotes({ ...base, clamped: false, partialToday: true });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toBe('Today is still in progress, so its figures are partial.');
    /*
      One note, two charts. It is rendered above the activity chart AND above
      the rate lines, so it may not describe the shape of either — "its bar will
      keep growing" is a sentence about bars, and on the rates section it names
      a mark that is not on screen.
    */
    expect(notes[0]).not.toMatch(/\bbars?\b|\blines?\b/i);
  });

  it('puts the truncation before the partial day when both apply', () => {
    // What the chart COVERS before what its last bar is worth: a reader who has
    // not been told the range was cut cannot judge the rest of it.
    const notes = campaignSeriesRangeNotes({ ...base, clamped: true, partialToday: true });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain(String(CAMPAIGN_SERIES_MAX_DAYS));
    expect(notes[1]).toContain('still in progress');
  });
});

describe('campaignSeriesZoneNote', () => {
  it('names the zone the days were cut in', () => {
    const note = campaignSeriesZoneNote(series([], { timezone: 'Asia/Kolkata' }));
    expect(note).toContain('Asia/Kolkata');
    expect(note).toContain('calling window');
  });

  it('says nothing at all when it cannot name one', () => {
    // "Days are counted in the campaign's time zone" without naming it tells a
    // reader nothing they can check.
    expect(campaignSeriesZoneNote(null)).toBeNull();
    expect(campaignSeriesZoneNote(series([]))).toBeNull();
    expect(campaignSeriesZoneNote(series([], { timezone: null }))).toBeNull();
    expect(campaignSeriesZoneNote(series([], { timezone: '' }))).toBeNull();
  });
});

// ── The axis ────────────────────────────────────────────────────────────────

describe('rateCeiling', () => {
  it('floors at 10 so a low rate still gets a plot with room in it', () => {
    expect(rateCeiling(0)).toBe(10);
    expect(rateCeiling(-4)).toBe(10);
    expect(rateCeiling(0.4)).toBe(10);
    expect(rateCeiling(10)).toBe(10);
  });

  it('rounds up to a clean ten so the midpoint tick divides', () => {
    expect(rateCeiling(12)).toBe(20);
    expect(rateCeiling(20.1)).toBe(30);
    expect(rateCeiling(66)).toBe(70);
  });

  it('caps where a percentage stops', () => {
    expect(rateCeiling(100)).toBe(100);
    expect(rateCeiling(140)).toBe(100);
  });

  it('degrades a non-finite max to the floor rather than a NaN axis', () => {
    expect(rateCeiling(Number.NaN)).toBe(10);
    // An infinity is not a percentage either — it lands on the floor rather
    // than pinning the axis at 100 and making the plot look deliberate.
    expect(rateCeiling(Number.POSITIVE_INFINITY)).toBe(10);
    expect(rateCeiling(Number.NEGATIVE_INFINITY)).toBe(10);
  });
});

// ── The rate trend ──────────────────────────────────────────────────────────

describe('rateTrend — null, never zero', () => {
  it('leaves a day with no dials unmeasured rather than plotting it at 0%', () => {
    /**
     * The rule the whole module is built around. A Sunday with no dials plotted
     * at 0% does not read as "we did not dial on Sunday" — it reads as a cliff,
     * and a supervisor acts on a cliff.
     */
    const trend = rateTrend(series([{ attempts: 0, connected: 0 }]));
    expect(trend.points[0]?.connect).toBeNull();
    expect(trend.points[0]?.connect).not.toBe(0);
    expect(lineOf(trend, 'connect').values).toEqual([null]);
  });

  it('leaves conversion unmeasured on a day with dials but no conversations', () => {
    const trend = rateTrend(series([{ attempts: 60, connected: 0, successes: 0 }]));
    expect(trend.points[0]?.conversion).toBeNull();
    // The connect rate on that same day is a real 0% — nothing answered out of
    // sixty dials is a measurement, not an absence.
    expect(trend.points[0]?.connect).toBe(0);
  });

  it('has no conversion at all when `successes` was absent, whatever the denominator', () => {
    // An absent numerator is an ABSENCE, not a zero — the same rule
    // `attempts_retried` and `agents_peak` follow on this payload. It used to be
    // coerced to 0, which turned "master did not send this" into a measured 0%
    // conversion that joins the line and draws a cliff.
    const raw = bucket({ bucket_start: day(0), attempts: 100, connected: 40 });
    delete (raw as Partial<AgencyAgentStatsBucket>).successes;
    const trend = rateTrend({ campaign_id: 'c', bucket: 'day', buckets: [raw] });

    expect(trend.points[0]?.successes).toBeUndefined();
    expect(trend.points[0]?.conversion).toBeNull();
    // And it must not be plotted: a gap, not a point at zero.
    expect(lineOf(trend, 'conversion').values[0]).toBeNull();
  });

  it('still reports a REAL zero, which is a measurement', () => {
    // The other side: `successes: 0` over a real denominator is "nobody
    // converted today", and that is a finding rather than an absence.
    const trend = rateTrend(series([{ attempts: 100, connected: 40, successes: 0 }]));
    expect(trend.points[0]?.successes).toBe(0);
    expect(trend.points[0]?.conversion).toBe(0);
  });

  it('has no conversion when nothing connected, absent numerator or not', () => {
    const raw = bucket({ bucket_start: day(0), attempts: 60, connected: 0 });
    delete (raw as Partial<AgencyAgentStatsBucket>).successes;
    const trend = rateTrend({ campaign_id: 'c', bucket: 'day', buckets: [raw] });

    expect(trend.points[0]?.conversion).toBeNull();
  });

  it('has no points and nothing drawable for an absent series', () => {
    const trend = rateTrend(null);
    expect(trend.points).toEqual([]);
    expect(trend.drawable).toBe(false);
    expect(trend.withheldNote).toBeNull();
  });
});

describe('rateTrend — the publication threshold', () => {
  it('withholds a day whose own denominator is under the threshold', () => {
    const trend = rateTrend(
      series([{ attempts: RATE_MIN_ATTEMPTS - 1, connected: RATE_MIN_ATTEMPTS - 1 }]),
    );
    const connect = lineOf(trend, 'connect');
    expect(connect.values).toEqual([null]);
    expect(connect.withheldIndices.length).toBe(1);
    // Withheld, not unmeasured: there WAS a denominator, it was just too small.
    expect(connect.unmeasured).toBe(0);
  });

  it('publishes a day that reaches the threshold exactly', () => {
    const trend = rateTrend(
      series([{ attempts: RATE_MIN_ATTEMPTS, connected: RATE_MIN_ATTEMPTS }]),
    );
    const connect = lineOf(trend, 'connect');
    expect(connect.values).toEqual([100]);
    expect(connect.withheldIndices.length).toBe(0);
  });

  it('never counts one day as both withheld and unmeasured', () => {
    const trend = rateTrend(
      series([
        { attempts: 0, connected: 0 },                                    // no denominator
        { attempts: RATE_MIN_ATTEMPTS - 15, connected: 5 },               // too small
        { attempts: 100, connected: 50 },                                 // published
      ]),
    );
    const connect = lineOf(trend, 'connect');
    expect(connect.unmeasured).toBe(1);
    expect(connect.withheldIndices.length).toBe(1);
    expect(connect.unmeasured + connect.withheldIndices.length).toBe(trend.points.length - 1);
    expect(connect.values).toEqual([null, null, 50]);
  });

  it('measures each line against its OWN denominator', () => {
    // Dials for the connect rate, connected calls for conversion. A day can be
    // publishable on one line and withheld on the other.
    const trend = rateTrend(series([{ attempts: 200, connected: 10, successes: 4 }]));
    expect(lineOf(trend, 'connect').values).toEqual([5]);
    expect(lineOf(trend, 'conversion').values).toEqual([null]);
    expect(lineOf(trend, 'conversion').withheldIndices.length).toBe(1);
  });

  it('states the threshold in the withheld note, in the singular for one day', () => {
    const trend = rateTrend(
      series([
        { attempts: 10, connected: 0 },   // connect withheld; conversion unmeasured
        { attempts: 100, connected: 60 },
        { attempts: 100, connected: 60 },
      ]),
    );
    expect(trend.withheldNote).toContain('One day is');
    expect(trend.withheldNote).toContain(String(RATE_MIN_ATTEMPTS));
    // Both halves said plainly: the days show as gaps, and they were dialed.
    // "The gap is the day, not a missing reading" read as a riddle and got
    // skipped, which left the reader unsure whether a hole is a quiet day or a
    // failed fetch — the one question the note exists to answer.
    expect(trend.withheldNote).toMatch(/shows? as (a gap|gaps) in the lines/);
    expect(trend.withheldNote).toMatch(/(It|They) w(as|ere) dialed/);
  });

  it('pluralises the withheld note for more than one day', () => {
    const trend = rateTrend(
      series([
        { attempts: 10, connected: 0 },
        { attempts: 12, connected: 0 },
        { attempts: 100, connected: 60 },
        { attempts: 100, connected: 60 },
      ]),
    );
    expect(trend.withheldNote).toContain('2 days are');
  });

  it('says nothing when nothing was withheld', () => {
    const trend = rateTrend(
      series([
        { attempts: 100, connected: 60, successes: 30 },
        { attempts: 100, connected: 60, successes: 30 },
      ]),
    );
    expect(trend.withheldNote).toBeNull();
  });
});

describe('rateTrend — runs, so a line is never drawn across a gap', () => {
  /** A day the connect line can measure, or one it cannot. */
  const measured = { attempts: 100, connected: 60, successes: 30 };
  const quiet = { attempts: 0, connected: 0, successes: 0 };

  it('opens a run after a leading gap', () => {
    const trend = rateTrend(series([quiet, measured, measured]));
    expect(lineOf(trend, 'connect').runs).toEqual([{ from: 1, to: 2 }]);
  });

  it('closes a run before a trailing gap', () => {
    const trend = rateTrend(series([measured, measured, quiet]));
    expect(lineOf(trend, 'connect').runs).toEqual([{ from: 0, to: 1 }]);
  });

  it('splits into two runs across a gap in the middle', () => {
    const trend = rateTrend(series([measured, measured, quiet, measured, measured]));
    expect(lineOf(trend, 'connect').runs).toEqual([
      { from: 0, to: 1 },
      { from: 3, to: 4 },
    ]);
  });

  it('has no runs at all when nothing was measured', () => {
    const trend = rateTrend(series([quiet, quiet, quiet]));
    expect(lineOf(trend, 'connect').runs).toEqual([]);
  });

  it('is one run when every day was measured', () => {
    const trend = rateTrend(series([measured, measured, measured, measured]));
    expect(lineOf(trend, 'connect').runs).toEqual([{ from: 0, to: 3 }]);
  });

  it('gives a single measured day a run of length one, for the dot', () => {
    const trend = rateTrend(series([quiet, quiet, measured, quiet]));
    expect(lineOf(trend, 'connect').runs).toEqual([{ from: 2, to: 2 }]);
  });

  it('reports the LAST measured index, not the last index', () => {
    const trend = rateTrend(series([measured, measured, quiet, quiet]));
    // The direct label goes on the last reading, which is on day 1 here — a
    // label at index 3 would sit over a day with no line under it.
    expect(lineOf(trend, 'connect').lastIndex).toBe(1);
  });

  it('has no last measured index when nothing was measured', () => {
    const trend = rateTrend(series([quiet, quiet]));
    expect(lineOf(trend, 'connect').lastIndex).toBeNull();
  });
});

describe('rateTrend — drawable, and why not', () => {
  const measured = { attempts: 100, connected: 60, successes: 30 };

  it('is drawable when one line has two measured days, even if the other has none', () => {
    const trend = rateTrend(
      series([
        { attempts: 100, connected: 0, successes: 0 },
        { attempts: 100, connected: 0, successes: 0 },
      ]),
    );
    expect(lineOf(trend, 'connect').drawable).toBe(true);
    expect(lineOf(trend, 'conversion').drawable).toBe(false);
    expect(trend.drawable).toBe(true);
    expect(trend.reason).toBeNull();
  });

  it('is not drawable on a single measured day', () => {
    const trend = rateTrend(series([measured, { attempts: 0, connected: 0 }]));
    expect(lineOf(trend, 'connect').drawable).toBe(false);
    expect(trend.drawable).toBe(false);
  });

  it('distinguishes a range with no days in it from a campaign that did not dial', () => {
    // Every day in the range arrives, zeros included (the endpoint's contract),
    // so an empty `points` is a range with no days in it — a different failure
    // from a quiet week, and the quiet week is the ordinary one.
    const noDays = rateTrend(series([]));
    expect(noDays.drawable).toBe(false);
    expect(noDays.reason).toBe('There are no days in this range.');

    const noDials = rateTrend(series([{ attempts: 0 }, { attempts: 0 }, { attempts: 0 }]));
    expect(noDials.drawable).toBe(false);
    expect(noDials.reason).toBe('Nothing was dialed in this range.');
  });

  it('distinguishes "every day was below the threshold"', () => {
    /**
     * Three different answers, because they lead to three different next
     * actions — widen the range, wait, or nothing at all. One "no data" would
     * collapse them and leave a supervisor unable to tell a quiet campaign from
     * a broken screen.
     */
    const tooSmall = rateTrend(
      series([
        { attempts: RATE_MIN_ATTEMPTS - 1, connected: 3 },
        { attempts: RATE_MIN_ATTEMPTS - 2, connected: 2 },
      ]),
    );
    expect(tooSmall.drawable).toBe(false);
    expect(tooSmall.reason).toContain(String(RATE_MIN_ATTEMPTS));
    // It also points at the figures that ARE measured over a big enough
    // denominator, rather than leaving the reader with nothing.
    expect(tooSmall.reason).toContain('figures above cover the whole campaign');
  });

  it('distinguishes "fewer than two days with calls in them"', () => {
    const oneDay = rateTrend(series([measured, { attempts: 0, connected: 0 }]));
    expect(oneDay.reason).toBe(
      `A trend needs two days with at least ${RATE_MIN_ATTEMPTS} calls each. Pick a wider range.`,
    );
  });

  it('gives each refusal a sentence of its own', () => {
    const reasons = [
      // No days at all.
      rateTrend(series([])).reason,
      // Days, but nothing was dialled on any of them.
      rateTrend(series([{ attempts: 0 }, { attempts: 0 }])).reason,
      // Dialled, but every day is under the publication threshold.
      rateTrend(series([{ attempts: 4, connected: 1 }, { attempts: 3, connected: 1 }])).reason,
      // One publishable day, which is a reading rather than a trend.
      rateTrend(series([{ attempts: 100, connected: 60 }, { attempts: 0, connected: 0 }])).reason,
    ];
    expect(new Set(reasons).size).toBe(4);
    expect(reasons.every((reason) => typeof reason === 'string' && reason.length > 0)).toBe(true);
  });
});

describe('rateTrend — the axis and the legend', () => {
  it('takes the axis top from the largest MEASURED value', () => {
    // A withheld day's raw rate must not raise the axis: the plot would then be
    // scaled by a figure this console is refusing to publish.
    const trend = rateTrend(
      series([
        { attempts: 100, connected: 60, successes: 0 },
        { attempts: 10, connected: 9, successes: 0 },
      ]),
    );
    expect(trend.max).toBe(rateCeiling(60));
    expect(trend.max).toBe(60);
    expect(trend.max).not.toBe(rateCeiling(90));
  });

  it('falls back to the floor when nothing is measured at all', () => {
    expect(rateTrend(series([{ attempts: 0, connected: 0 }])).max).toBe(10);
    expect(rateTrend(null).max).toBe(10);
  });

  it('gives each line a denominator of its own, in the legend entry', () => {
    // A chart has one legend for both lines, so the denominator has to travel IN
    // the entry rather than beside it — the two rates are measured over
    // different things and a reader who assumes one is out by a factor.
    const trend = rateTrend(series([{ attempts: 100, connected: 60, successes: 30 }]));
    const connect = lineOf(trend, 'connect');
    const conversion = lineOf(trend, 'conversion');

    expect(connect.denominator).toBeTruthy();
    expect(conversion.denominator).toBeTruthy();
    expect(connect.denominator).not.toBe(conversion.denominator);
    expect(connect.denominator).toContain('dials');
    expect(conversion.denominator).toContain('spoke to a person');
  });
});

describe('rateTrend — the buckets themselves', () => {
  it('keeps master’s order rather than re-deriving it', () => {
    // Re-sorting here would give the screen a second opinion about a sequence
    // the server already ordered.
    const trend = rateTrend(
      series([
        { bucket_start: '2026-08-03' },
        { bucket_start: '2026-08-01' },
        { bucket_start: '2026-08-02' },
      ]),
    );
    expect(trend.points.map((point) => point.start)).toEqual([
      '2026-08-03',
      '2026-08-01',
      '2026-08-02',
    ]);
  });

  it('keeps a malformed bucket rather than dropping it, and shows the raw string', () => {
    // Losing a bucket breaks the one property the series can be checked against
    // — that its days sum to the totals — so the day survives with the server's
    // own value as its label.
    const trend = rateTrend(
      series([{ bucket_start: 'not-a-day', attempts: 100, connected: 60 }]),
    );
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0]?.start).toBe('not-a-day');
    expect(trend.points[0]?.label).toBe('not-a-day');
    expect(trend.points[0]?.title).toBe('not-a-day');
    // And it is still measured: a label we cannot format is not a missing value.
    expect(trend.points[0]?.connect).toBe(60);
  });

  it('labels a well-formed bucket with its day of the month', () => {
    const trend = rateTrend(series([{ bucket_start: '2026-08-03' }]));
    expect(trend.points[0]?.label).toBe('3');
    // The full-date title is locale-formatted, so only its distinctness from the
    // raw string is asserted here — the calendar arithmetic behind it is pinned
    // in `agencyBucketDates.timezone.test.tsx`.
    expect(trend.points[0]?.title).not.toBe('2026-08-03');
    expect(trend.points[0]?.title).toBeTruthy();
  });

  it('carries the raw counts through beside the derived rates', () => {
    const trend = rateTrend(series([{ attempts: 120, connected: 48, successes: 12 }]));
    expect(trend.points[0]).toMatchObject({
      attempts: 120,
      connected: 48,
      successes: 12,
      connect: 40,
      conversion: 25,
    });
  });
});

/*
  ── Regressions found in review (MAG-167) ───────────────────────────────────
  Three defects that all shared one shape: the screen asserting something false
  in words. Each is pinned here against the exact input that produced it.
*/
describe('review regressions', () => {
  // Its own clock: `NOW` above is scoped to the range describe block.
  const NOW = new Date('2026-08-27T15:30:00.000Z');

  it('treats a finished campaign as finished even when master sent no `ended_at`', () => {
    /*
      `ended_at` is optional because a master that predates the lifecycle
      timestamps does not send it. Keying "has it finished?" on the timestamp
      made a campaign that stopped in July open on the last 14 days — fourteen
      empty bars under a heading promising a trend — and then claim today was
      still filling. Both are statements about a live campaign.
    */
    const noTimestamp = lifespan({
      finished: true,
      started_at: '2026-06-01T00:00:00.000Z',
      ended_at: null,
    });

    expect(defaultCampaignSeriesWindow(noTimestamp)).toBe<CampaignSeriesWindow>('life');
    expect(campaignSeriesRange('7d', noTimestamp, NOW).partialToday).toBe(false);
    expect(campaignSeriesRangeNotes(campaignSeriesRange('7d', noTimestamp, NOW)))
      .not.toContain('Today is still in progress, so its figures are partial.');
  });

  it('counts a day withheld on BOTH lines once, not twice', () => {
    /*
      `withheld` used to be a per-line count summed across the two lines. A quiet
      day is normally withheld on both, so a seven-day chart carried the sentence
      "14 days are left out" above seven columns — falsifiable by counting the
      bars, which is the worst possible property for the one caveat the honesty
      of this chart rests on.

      Every day here is below the threshold on connect AND on conversion.
    */
    const trend = rateTrend(series([
      bucket({ bucket_start: '2026-08-20', attempts: 10, connected: 3, successes: 1 }),
      bucket({ bucket_start: '2026-08-21', attempts: 12, connected: 4, successes: 1 }),
      bucket({ bucket_start: '2026-08-22', attempts: 8, connected: 2, successes: 0 }),
    ]));

    const connect = trend.lines.find((line) => line.key === 'connect')!;
    const conversion = trend.lines.find((line) => line.key === 'conversion')!;
    expect(connect.withheldIndices).toEqual([0, 1, 2]);
    expect(conversion.withheldIndices).toEqual([0, 1, 2]);

    // Three days, withheld twice over — and the note must say three.
    expect(trend.withheldNote).toContain('3 days');
    expect(trend.withheldNote).not.toContain('6 days');
  });

  it('does not claim no day was publishable when one was', () => {
    /*
      A range holding one 400-dial day and one 4-dial day is not a quiet range —
      it is a SHORT one, and the next action is to widen it, not to give up and
      read the lifetime figures. The old copy said "No day in this range had 25
      calls behind it" directly above a day that had 400.
    */
    const trend = rateTrend(series([
      bucket({ bucket_start: '2026-08-25', attempts: 400, connected: 240, successes: 60 }),
      bucket({ bucket_start: '2026-08-26', attempts: 4, connected: 1, successes: 0 }),
    ]));

    expect(trend.drawable).toBe(false);
    // The good day really is measured — this is what makes the old copy false.
    expect(trend.lines.find((line) => line.key === 'connect')!.values[0]).toBeCloseTo(60);
    expect(trend.reason).not.toContain(`No day in this range had ${RATE_MIN_ATTEMPTS}`);
    expect(trend.reason).toContain('Pick a wider range');
  });

  it('still says nothing was publishable when nothing was', () => {
    // The other side of the guard above: a genuinely quiet range keeps its own
    // sentence, which sends the reader to the lifetime figures rather than to a
    // wider range that will be just as quiet.
    const trend = rateTrend(series([
      bucket({ bucket_start: '2026-08-25', attempts: 6, connected: 2, successes: 1 }),
      bucket({ bucket_start: '2026-08-26', attempts: 4, connected: 1, successes: 0 }),
    ]));

    expect(trend.drawable).toBe(false);
    expect(trend.reason).toContain(`No day in this range had ${RATE_MIN_ATTEMPTS}`);
  });
});

describe('the zone note says whose day the bars are cut in', () => {
  /*
    The suite runs pinned to `TZ=UTC`, so the reader's zone here is UTC and the
    campaign's is not — which is the case the extra sentence exists for.
  */
  it('names the campaign zone, and warns the edges are partial when they differ', () => {
    const note = campaignSeriesZoneNote(series([], { timezone: 'Asia/Kolkata' }));
    expect(note).toContain('Asia/Kolkata');
    expect(note).toContain('part of a day');
  });

  it('says nothing extra when the reader is in the campaign\'s own zone', () => {
    // No edge problem to warn about, and a sentence about one would be noise.
    const note = campaignSeriesZoneNote(series([], { timezone: 'UTC' }));
    expect(note).toContain('UTC');
    expect(note).not.toContain('part of a day');
  });

  it('says nothing at all when master sent no zone', () => {
    // "Days are counted in the campaign's time zone" without naming it tells a
    // reader nothing they can check.
    expect(campaignSeriesZoneNote(series([], { timezone: null }))).toBeNull();
    expect(campaignSeriesZoneNote(null)).toBeNull();
  });
});

describe('the withheld note agrees with itself in number', () => {
  // The first attempt read "1 day is left out … Those day show as gaps … They
  // were dialed" — three disagreements in one sentence.
  const withheldDays = (count: number) =>
    rateTrend(series(
      Array.from({ length: count }, (_, i) =>
        bucket({ bucket_start: `2026-08-${String(10 + i).padStart(2, '0')}`, attempts: 5, connected: 2, successes: 1 })),
    )).withheldNote ?? '';

  it('is singular for one day', () => {
    const note = withheldDays(1);
    expect(note).toContain('One day is left out');
    expect(note).toContain('It shows as a gap');
    expect(note).toContain('It was dialed');
    expect(note).not.toContain('Those');
    expect(note).not.toContain('gaps');
  });

  it('is plural for more than one', () => {
    const note = withheldDays(3);
    expect(note).toContain('3 days are left out');
    expect(note).toContain('They show as gaps');
    expect(note).toContain('They were dialed');
  });
});

describe('a finished campaign whose end we were never told', () => {
  const NOW = new Date('2026-08-27T15:30:00.000Z');

  it('covers the campaign from its start, not the 92 days before today', () => {
    /*
      `lastDay` falls back to today when there is no `ended_at`, so a `life`
      window walked 92 days BACK from now: a campaign that started in March and
      completed in April charted August's structural zeros, dropped the months it
      actually ran, and was captioned "ran longer than 92 days. Showing the most
      recent 92" — a truncation of a run that never happened.
    */
    const range = campaignSeriesRange(
      'life',
      lifespan({ finished: true, started_at: '2026-03-01T09:00:00.000Z', ended_at: null }),
      NOW,
    );

    expect(range.endUnknown).toBe(true);
    // Counts FORWARD from the start — the only end of the window we know.
    expect(range.from).toBe(new Date(2026, 2, 1).toISOString());
    expect(range.days).toBe(CAMPAIGN_SERIES_MAX_DAYS);
    // And it must not claim to be showing the most recent stretch of a long run.
    expect(range.clamped).toBe(false);
    const notes = campaignSeriesRangeNotes(range);
    expect(notes.join(' ')).toContain('don’t have an end date');
    expect(notes.join(' ')).not.toContain('most recent');
  });

  it('still says "most recent" for a genuinely long LIVE campaign', () => {
    // The other side of the guard: a running campaign really is being shown its
    // most recent 92 days, and that truncation must still be declared.
    const range = campaignSeriesRange(
      'life',
      lifespan({ finished: false, started_at: '2025-01-01T00:00:00.000Z' }),
      NOW,
    );
    expect(range.clamped).toBe(true);
    expect(range.endUnknown).toBe(false);
    expect(campaignSeriesRangeNotes(range).join(' ')).toContain('most recent');
  });

  it('does not fire for a finished campaign that DID tell us when', () => {
    const range = campaignSeriesRange(
      'life',
      ended({ started_at: '2026-03-01T09:00:00.000Z', ended_at: '2026-04-10T09:00:00.000Z' }),
      NOW,
    );
    expect(range.endUnknown).toBe(false);
    expect(campaignSeriesRangeNotes(range)).toEqual([]);
  });
});

describe('an empty chart never advises widening a range that is already widest', () => {
  /*
    Both "there is no chart" notes ended "Pick a wider range", and both pickers
    DEFAULT to the widest option on a terminal campaign — which is the primary
    case for this whole section. Measured on production: a campaign that ran for
    twenty minutes showed "Whole campaign" selected directly above "Pick a wider
    range to see one", on the Overview and the Performance chart both.

    The existing comment on `noTrendReason` records half of this fix already
    ("a supervisor widened the range, got the same message back, and concluded
    the control was broken") — that pass corrected the wording of the bar and
    left the advice unconditional.
  */
  const series = (rows: Partial<AgencyAgentStatsBucket>[]): AgencyCampaignSeries => ({
    campaign_id: 'c',
    bucket: 'day',
    buckets: rows.map((row, index) => ({
      bucket_start: `2026-08-${String(index + 1).padStart(2, '0')}`,
      attempts: 0,
      connected: 0,
      successes: 0,
      talk_seconds: 0,
      ...row,
    })) as AgencyAgentStatsBucket[],
  });

  // No `as` cast: every field is spelled out so a rename in
  // `CampaignSeriesRange` reds this fixture instead of being absorbed by it.
  const range = (over: Partial<CampaignSeriesRange> = {}): CampaignSeriesRange => ({
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-29T00:00:00.000Z',
    days: 28,
    clamped: false,
    endUnknown: false,
    partialToday: false,
    ...over,
  });

  describe('campaignSeriesReach', () => {
    it('is narrower while a wider option is on offer', () => {
      expect(campaignSeriesReach('30d', CAMPAIGN_SERIES_WINDOWS, range())).toBe('narrower');
      expect(campaignSeriesReach('7d', CAMPAIGN_SERIES_WINDOWS, range())).toBe('narrower');
    });

    it('is the campaign only for an unclamped "life"', () => {
      expect(campaignSeriesReach('life', CAMPAIGN_SERIES_WINDOWS, range())).toBe('campaign');
    });

    it('stops short of the campaign when "life" was withheld', () => {
      /*
        The bug a single `atWidest` boolean bought. `life` is withheld from a
        campaign with no known start, so `30d` is the widest on offer — and the
        two facts the old flag conflated come apart exactly here. There is
        nothing to widen to, so the advice must go; but the campaign may have
        dialed on any number of days before that window, so no sentence may
        speak for the campaign either.
      */
      expect(campaignSeriesReach('30d', ['7d', '14d', '30d'], range())).toBe('widest');
    });

    it('stops short of the campaign when "life" itself was clamped', () => {
      // A campaign that ran longer than the 92-day cap keeps only its most
      // recent 92 days, which `campaignSeriesRangeNote` says in words a few
      // pixels under the sentence that would otherwise claim to cover all of it.
      expect(
        campaignSeriesReach('life', CAMPAIGN_SERIES_WINDOWS, range({ clamped: true })),
      ).toBe('widest');
    });

    it('does not take the campaign-wide reading off an absent range', () => {
      // `'campaign'` is the strongest of the three, and this module does not
      // make the strongest reading from a missing field.
      expect(campaignSeriesReach('life', CAMPAIGN_SERIES_WINDOWS, null)).toBe('widest');
    });

    it('claims nothing when no window is on offer', () => {
      expect(campaignSeriesReach('7d', [], range())).toBe('narrower');
    });
  });

  describe('the single-day note', () => {
    it('advises widening while there is room to widen', () => {
      expect(campaignSingleBucketNote('narrower')).toContain('Pick a wider range');
    });

    it('states the fact instead, once there is not', () => {
      const note = campaignSingleBucketNote('campaign');
      expect(note).not.toMatch(/wider|widen/i);
      expect(note).toContain('one day');
      // And points at the figures that DO cover it, rather than dead-ending.
      expect(note).toMatch(/figures above/);
    });

    it('scopes the claim to the range when the widest is not the campaign', () => {
      const note = campaignSingleBucketNote('widest');
      // Still no dead-end advice — there is nothing wider to press.
      expect(note).not.toMatch(/pick a wider/i);
      // But it may not generalise from this range to the campaign's whole life.
      expect(note).not.toMatch(/this campaign has dialed/i);
      expect(note).not.toMatch(/cover all of it/i);
      expect(note).toMatch(/in this range/);
    });
  });

  describe('the no-trend reason', () => {
    /*
      ONE publishable day and one thin one. Two thin days would hit the earlier
      `!anyMeasured` branch, which is a different sentence and already declines
      to advise widening — the bar named here is reachable only when a day DID
      clear the threshold and a second did not.
    */
    const oneGoodDay = series([
      { attempts: 60, connected: 30, successes: 10 },
      { attempts: 4, connected: 2, successes: 1 },
    ]);

    it('advises widening while there is room to widen', () => {
      const trend = rateTrend(oneGoodDay, 'narrower');
      expect(trend.drawable).toBe(false);
      expect(trend.reason).toContain('Pick a wider range');
    });

    it('states the fact instead, once there is not', () => {
      const trend = rateTrend(oneGoodDay, 'campaign');
      expect(trend.drawable).toBe(false);
      expect(trend.reason).not.toMatch(/wider|widen/i);
      // The bar itself is still named — that half of the copy was already right.
      expect(trend.reason).toContain(String(RATE_MIN_ATTEMPTS));
      expect(trend.reason).toMatch(/whole of it/);
    });

    it('scopes the claim to the range when the widest is not the campaign', () => {
      const trend = rateTrend(oneGoodDay, 'widest');
      expect(trend.reason).not.toMatch(/pick a wider/i);
      // The sentence that was wrong: a campaign whose `life` window is withheld
      // may have dialed plenty on days outside this range.
      expect(trend.reason).not.toMatch(/this campaign has not dialed/i);
      expect(trend.reason).not.toMatch(/whole of it/i);
      expect(trend.reason).toMatch(/in this range/);
      expect(trend.reason).toContain(String(RATE_MIN_ATTEMPTS));
    });

    it('leaves the two range-independent reasons alone at any reach', () => {
      // "no days in this range" and "nothing was dialed" are not about width and
      // must not grow a widening suggestion or lose their own wording.
      for (const reach of ['narrower', 'widest', 'campaign'] as const) {
        expect(rateTrend(series([]), reach).reason).toBe('There are no days in this range.');
        expect(
          rateTrend(series([{ attempts: 0 }, { attempts: 0 }]), reach).reason,
        ).toBe('Nothing was dialed in this range.');
      }
    });

    it('defaults to the weakest reading when the caller does not say', () => {
      // `reach` is optional and absent means `'narrower'` — the wording every
      // existing call site already produced, and the one reading that publishes
      // no claim about the campaign.
      expect(rateTrend(oneGoodDay).reason).toContain('Pick a wider range');
    });
  });
});
