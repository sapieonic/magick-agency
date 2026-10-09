import { describe, expect, it } from 'vitest';
import {
  BUCKET_TIMEZONE_NOTE,
  agentCount,
  agentDurationLong,
  agentSeconds,
  windowRangeReadout,
  bucketSeries,
  campaignLabel,
  campaignNameMap,
  conversionRateReadout,
  handleTimeReadout,
  headlineTrio,
  isEmptyRange,
  occupancyBreakdown,
  occupancySegmentText,
  AGENT_STATS_WINDOWS,
  AGENT_STATS_WINDOW_LABELS,
  periodRange,
  ratePct,
  windowRange,
  rowConnectRate,
  staffingSummary,
  wrapupReadout,
} from '../../utils/agencyAgentPerformance';
import type {
  AgencyAgentStats,
  AgencyAgentStatsTotals,
  AgencyStaffingHistoryEntry,
} from '../../types/agency-stats';

/**
 * The agent performance surface's derivations.
 *
 * Almost everything below is one proposition in several forms: **`undefined`,
 * `null` and a real `0` are three different sentences**, and the whole value of
 * these readouts is that the person being measured can tell which one they are
 * reading. `0.0%` on somebody's first morning is the product telling them they
 * failed at something they have not yet had the chance to do — the same defect
 * `abandonment_rate_24h_pct` documents, aimed at a person rather than at a
 * campaign.
 *
 * The tests are written as those cases rather than as happy paths, because the
 * happy path was never the thing at risk.
 */

function totals(over: Partial<AgencyAgentStatsTotals> = {}): AgencyAgentStatsTotals {
  return {
    attempts: 42,
    connected: 17,
    connect_rate_pct: 40.5,
    successes: 4,
    success_rate_pct: 23.5,
    talk_seconds: 1800,
    wrapup_seconds: 240,
    aht_seconds: 105,
    campaigns: 2,
    ...over,
  };
}

describe('periodRange', () => {
  it('anchors "today" on the reader’s own midnight', () => {
    const now = new Date('2026-08-20T14:30:00.000Z');
    const range = periodRange('today', now);
    expect(range.to).toBe(now.toISOString());
    // Local midnight, whatever the runner's zone: the assertion is on the
    // property rather than on a literal, because a literal would only hold in UTC.
    expect(new Date(range.from).getHours()).toBe(0);
    expect(new Date(range.from).getDate()).toBe(now.getDate());
  });

  it('starts the week on MONDAY, not on date-fns’ Sunday default', () => {
    /**
     * The defect this pins. An agency week is a working week: an agent opening
     * "this week" on a Monday morning wants the shift they are in, and a
     * Sunday-anchored week hands them yesterday's numbers as this week's. The
     * value is passed explicitly so a future locale-aware default cannot move
     * somebody's week under them.
     */
    // A Wednesday.
    const now = new Date(2026, 7, 19, 9, 0, 0);
    const from = new Date(periodRange('week', now).from);
    expect(from.getDay()).toBe(1);
    expect(from.getDate()).toBe(17);
  });

  it('starts the month on the 1st, at midnight', () => {
    const now = new Date(2026, 7, 19, 9, 0, 0);
    const from = new Date(periodRange('month', now).from);
    expect(from.getDate()).toBe(1);
    expect(from.getHours()).toBe(0);
  });

  it('gives "today" and "this week" the same start on a MONDAY, deliberately', () => {
    /**
     * Asserted as intended behaviour rather than tolerated as an edge case,
     * because the tempting "fix" is to offset one anchor so the three ranges are
     * always distinct — which would hand an agent last week's numbers under a
     * "This week" heading. On Monday morning their week IS their morning.
     *
     * This is also the day the `AgentPerformancePage` assertion counted distinct
     * `from` timestamps and went red: a period is identified by its NAME, never
     * by its range.
     */
    const monday = new Date(2026, 7, 24, 9, 0, 0);
    expect(monday.getDay()).toBe(1);
    expect(periodRange('today', monday).from).toBe(periodRange('week', monday).from);
  });

  it('collapses all three when the 1st of a month falls on a Monday', () => {
    // 1 June 2026. The same rule at its extreme: one instant, three true
    // periods. Anything keyed on the range sees one period where there are three.
    const firstMonday = new Date(2026, 5, 1, 9, 0, 0);
    expect(firstMonday.getDay()).toBe(1);
    const froms = (['today', 'week', 'month'] as const).map((p) => periodRange(p, firstMonday).from);
    expect(new Set(froms).size).toBe(1);
  });

  it('gives all three periods the same "to", so nothing falls between them', () => {
    // A call landing between two `to` values would appear in one period and not
    // the other, which is a discrepancy nobody can explain from the screen.
    const now = new Date('2026-08-20T14:30:00.000Z');
    const ends = (['today', 'week', 'month'] as const).map((p) => periodRange(p, now).to);
    expect(new Set(ends).size).toBe(1);
  });
});

describe('windowRange — the roster’s two COMPLETED windows', () => {
  /**
   * Every {@link periodRange} window ends at `now`, and on a roster that is a hole
   * rather than a rounding. A supervisor's weekly review happens on a Monday
   * morning: at 09:30 "this week" is ninety minutes of dials, so every row sits
   * under the rating threshold, every rate reads "not enough calls",
   * `agents_rated` is 0 and every band reads "no median yet". The screen is
   * useless at exactly the moment it is opened.
   */
  it('offers a settled last week and last month alongside the to-date three', () => {
    expect(AGENT_STATS_WINDOWS).toEqual(['today', 'week', 'last_week', 'month', 'last_month']);
    expect(AGENT_STATS_WINDOW_LABELS.last_week).toBe('Last week');
    expect(AGENT_STATS_WINDOW_LABELS.last_month).toBe('Last month');
  });

  it('delegates the three to-date windows to periodRange, byte for byte', () => {
    // One definition of "this week" for the roster and for the panel a supervisor
    // drills into, or the same Monday is two ranges one click apart.
    const now = new Date('2026-08-20T14:30:00.000Z');
    for (const period of ['today', 'week', 'month'] as const) {
      expect(windowRange(period, now)).toEqual(periodRange(period, now));
    }
  });

  it('ends last week exactly where this week starts, with no gap and no overlap', () => {
    /**
     * Half-open `[from, to)`, and `to` is taken from the CURRENT period's start
     * rather than from an `endOfWeek`. `endOfWeek` is the last millisecond of
     * Sunday, and a half-open range ending at 23:59:59.999 silently drops any dial
     * in that final millisecond.
     */
    const now = new Date('2026-08-20T14:30:00.000Z'); // a Thursday
    const last = windowRange('last_week', now);
    expect(last.from).toBe('2026-08-10T00:00:00.000Z');
    expect(last.to).toBe(periodRange('week', now).from);
    expect(new Date(last.to).getTime()).toBeGreaterThan(new Date(last.from).getTime());
  });

  it('ends last month exactly where this month starts', () => {
    const now = new Date('2026-08-20T14:30:00.000Z');
    const last = windowRange('last_month', now);
    expect(last.from).toBe('2026-07-01T00:00:00.000Z');
    expect(last.to).toBe(periodRange('month', now).from);
  });

  /**
   * Core has TWO window caps and this list is read by surfaces governed by both,
   * so one assertion against one number cannot protect it. The previous version
   * of this test asserted `days < 35` under a title naming a 92-day cap — three
   * numbers, none of them either real bound, and it would have passed for a
   * window set that violated the tighter one. It is also the assertion that
   * should have caught the 92-vs-366 mix-up and could not.
   *
   * Mirrored from `magic-voice-core/src/agency/agent-record.ts`. They are
   * literals because master is not a dependency of this repo and core is not
   * either — the transcription is the thing a reviewer checks.
   */
  const AGENT_STATS_MAX_WINDOW_DAYS = 366; // the per-agent read
  const ROSTER_MAX_WINDOW_DAYS = 92; // the roster + grouped reads

  it('keeps every window inside the roster cap, the TIGHTER of core’s two', () => {
    /*
     * The tighter bound is the binding one for this list, because
     * `AGENT_STATS_WINDOWS` is rendered as the option list on `AgentAnalyticsSection`,
     * `BestHours` and `CampaignContribution` as well as the panel — and those three
     * read roster-capped routes. A member that cleared 366 but not 92 would work on
     * the agent's own page and hard-400 all three. Asserted at a leap-February so
     * the widest calendar month in the calendar is the one under test.
     */
    const now = new Date('2028-02-15T09:00:00.000Z');
    for (const window of AGENT_STATS_WINDOWS) {
      const { from, to } = windowRange(window, now);
      const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
      expect(days, window).toBeLessThanOrEqual(ROSTER_MAX_WINDOW_DAYS);
      expect(days, window).toBeLessThanOrEqual(AGENT_STATS_MAX_WINDOW_DAYS);
    }
  });

  it('leaves the per-agent read most of its year unused, which is the headroom a wider tile would spend', () => {
    /*
     * Not a bound — a statement of the gap, so the next person reads the two caps
     * as different on purpose. The panel's endpoint accepts a full year; the
     * widest thing this vocabulary produces is a calendar month. That headroom is
     * real and spendable, but only through the panel's `windows` prop, never by
     * appending to this shared list.
     */
    const now = new Date('2026-03-15T09:00:00.000Z');
    const widest = Math.max(
      ...AGENT_STATS_WINDOWS.map((window) => {
        const { from, to } = windowRange(window, now);
        return (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
      }),
    );
    expect(widest).toBeLessThan(AGENT_STATS_MAX_WINDOW_DAYS / 4);
  });

  it('gives every window its own range — a completed one never resolves to its to-date sibling', () => {
    /**
     * There used to be a `windowPeriod` here folding `last_week` onto `week` and
     * `last_month` onto `month`, because the panel had only the three to-date
     * tiles. It was lossy in the one direction that mattered: a supervisor who
     * ranked the floor over LAST week and opened a low row was shown THIS week's
     * figures for that person, under the roster's heading, one click apart — and
     * the two numbers disagreeing read as the console being wrong about one of
     * them. A `windowPeriodShiftNote` disclosed the fold in words, which was the
     * best that could be done while the fold existed.
     *
     * Both are gone because the fold is: the panel renders all five windows, so
     * the drill-down opens on the range the list was ranked by.
     *
     * The title used to claim this carried each window "through to the panel",
     * which it never checked — it is a pure-function test and can see no panel.
     * What it can see, and what a reintroduced fold would break, is that each
     * completed window resolves to a range of its OWN. That is asserted below;
     * the rendering half is `AgentAnalyticsSection.test.tsx`, which opens a
     * drill-down from a `last_week` roster and reads the selected tile back.
     */
    const now = new Date('2026-08-12T11:00:00.000Z');
    for (const window of AGENT_STATS_WINDOWS) {
      const range = windowRange(window, now);
      expect(new Date(range.from).getTime()).toBeLessThan(new Date(range.to).getTime());
      expect(AGENT_STATS_WINDOW_LABELS[window]).toBeTruthy();
    }

    // The fold's signature was a completed window answering with its to-date
    // sibling's range. Distinct `from` AND `to` is what says it is not happening.
    for (const [completed, toDate] of [
      ['last_week', 'week'],
      ['last_month', 'month'],
    ] as const) {
      const a = windowRange(completed, now);
      const b = windowRange(toDate, now);
      expect(a.from, completed).not.toBe(b.from);
      expect(a.to, completed).not.toBe(b.to);
      // And they tile: the completed one ends exactly where its sibling begins.
      expect(a.to, completed).toBe(b.from);
    }
  });
});

describe('headlineTrio', () => {
  it('always returns dials, connect rate and conversations, in that order', () => {
    /**
     * The decided product rule, asserted as a rule rather than as a layout.
     * "Calls" is ambiguous in exactly the way that matters to somebody being
     * measured on it: an agent reading one number cannot tell whether they are
     * being credited for dialling or for talking. The rate sits BETWEEN its own
     * denominator and numerator so it cannot be read as a fourth figure.
     */
    expect(headlineTrio(totals()).map((f) => f.key)).toEqual([
      'attempts',
      'connect_rate',
      'connected',
    ]);
  });

  it('labels the two counts so they cannot be confused', () => {
    const [dials, , conversations] = headlineTrio(totals());
    expect(dials?.label).toBe('Dials');
    expect(dials?.value).toBe('42');
    expect(conversations?.label).toBe('Conversations');
    expect(conversations?.value).toBe('17');
  });

  it('never renders a null connect rate as 0%', () => {
    const [, rate] = headlineTrio(totals({ connect_rate_pct: null }));
    expect(rate?.value).toBe('Not measured yet');
    expect(rate?.known).toBe(false);
    expect(rate?.value).not.toContain('0');
  });

  it('distinguishes "didn’t load" from "not measured yet"', () => {
    const [, rate] = headlineTrio(totals({ connect_rate_pct: undefined }));
    expect(rate?.value).toBe('—');
    expect(rate?.known).toBe(false);
  });

  it('renders a real zero dial count as 0, because that one is true', () => {
    const [dials] = headlineTrio(totals({ attempts: 0 }));
    expect(dials?.value).toBe('0');
    expect(dials?.known).toBe(true);
  });

  it('survives a payload with no totals at all', () => {
    // The first render, before any response has landed.
    expect(headlineTrio(undefined).every((f) => f.known === false)).toBe(true);
  });
});

describe('conversionRateReadout', () => {
  it('never renders a null rate as 0%', () => {
    const readout = conversionRateReadout(totals({ success_rate_pct: null }));
    expect(readout.value).toBe('Not measured yet');
    expect(readout.value).not.toContain('0');
    expect(readout.known).toBe(false);
  });

  it('names CONVERSATIONS as the denominator, not dials', () => {
    // A conversion rate over dials means something entirely different and is a
    // far smaller number. The label carries the denominator so the reader cannot
    // supply the wrong one.
    const readout = conversionRateReadout(totals());
    expect(readout.detail).toContain('spoke to someone');
    expect(readout.detail).toContain('not out of every dial');
  });

  it('keeps the success count on screen when the rate could not be read', () => {
    const readout = conversionRateReadout(totals({ success_rate_pct: undefined, successes: 4 }));
    expect(readout.known).toBe(false);
    expect(readout.secondary).toBe('4 counted');
  });
});

describe('handleTimeReadout and wrapupReadout', () => {
  it('reads a null average as "no call has finished", never as a fast shift', () => {
    const readout = handleTimeReadout(totals({ aht_seconds: null }));
    expect(readout.value).toBe('Not measured yet');
    expect(readout.known).toBe(false);
  });

  it('renders a measured average as m:ss with the total beside it', () => {
    const readout = handleTimeReadout(totals());
    expect(readout.value).toBe('1:45');
    expect(readout.secondary).toBe('30:00 on calls in total');
  });

  it('renders a real zero wrap-up as 0:00 rather than as absent', () => {
    // Nobody wrote anything up, which is a fact about the shift — and a
    // different one from "we could not read the wrap-up time".
    const readout = wrapupReadout(totals({ wrapup_seconds: 0 }));
    expect(readout.value).toBe('0:00');
    expect(readout.known).toBe(true);
  });

  it('reads an absent wrap-up as a failed load', () => {
    const readout = wrapupReadout(totals({ wrapup_seconds: undefined as unknown as number }));
    expect(readout.value).toBe('—');
    expect(readout.known).toBe(false);
  });
});

describe('occupancyBreakdown', () => {
  it('treats an ALL-ZERO breakdown as unmeasured, not as a shift of nothing', () => {
    /**
     * The defect this exists to stop. Core computes occupancy from an event log
     * that shipped after the dialer, and a session predating it emits no events —
     * so master answers with zeros rather than nulls. A bar built from those
     * zeros is a confident claim that somebody spent a shift doing nothing at
     * all: the null-not-zero rule in a different costume, aimed at the same
     * person.
     */
    const breakdown = occupancyBreakdown({
      shift_seconds: 28800,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
    expect(breakdown.measured).toBe(false);
    expect(breakdown.segments).toEqual([]);
  });

  it('is unmeasured when the payload carried no occupancy at all', () => {
    expect(occupancyBreakdown(undefined).measured).toBe(false);
    expect(occupancyBreakdown(null).measured).toBe(false);
  });

  it('is measured when the STATES have seconds, even with shift_seconds at zero', () => {
    // The other half of the asymmetry: a gappy log is not an absence, and
    // suppressing it would discard measurements we actually have.
    const breakdown = occupancyBreakdown({
      shift_seconds: 0,
      by_state: { available: 600, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 0 },
    });
    expect(breakdown.measured).toBe(true);
    expect(breakdown.segments).toHaveLength(1);
  });

  it('orders the states busiest-first and drops the ones with no time in them', () => {
    const breakdown = occupancyBreakdown({
      shift_seconds: 1000,
      by_state: { available: 300, reserved: 0, on_call: 500, wrapup: 100, break: 100, offline: 0 },
    });
    expect(breakdown.segments.map((s) => s.state)).toEqual([
      'on_call',
      'wrapup',
      'available',
      'break',
    ]);
  });

  it('takes shares of what was RECORDED, and reports the rest separately', () => {
    /**
     * The states can sum to less than `shift_seconds` — a browser closed
     * mid-state, a session the reaper closed. Dividing by `shift_seconds` would
     * produce shares that quietly refuse to reach 100%, which reads as a rounding
     * bug rather than as a gap in the record.
     */
    const breakdown = occupancyBreakdown({
      shift_seconds: 1200,
      by_state: { available: 500, reserved: 0, on_call: 500, wrapup: 0, break: 0, offline: 0 },
    });
    expect(breakdown.recordedSeconds).toBe(1000);
    expect(breakdown.unaccountedSeconds).toBe(200);
    expect(breakdown.segments.map((s) => s.sharePct)).toEqual([50, 50]);
  });

  it('leaves signed-out time out of the denominator and out of the bar', () => {
    /**
     * Core defines `shift_seconds` as the sum of the states EXCLUDING `offline`
     * (`foldOccupancy`), because an agent who logged out at 17:00 was not on
     * shift at 18:00. Summing all six here diluted every share by signed-out
     * time: 30 of 90 worked minutes on calls read as 6.7% instead of 33% for
     * somebody whose shift was one part of a long day.
     */
    const breakdown = occupancyBreakdown({
      shift_seconds: 5400,
      by_state: {
        available: 3600, reserved: 0, on_call: 1800, wrapup: 0, break: 0,
        // Six hours signed out, on the payload and out of the shift.
        offline: 21600,
      },
    });

    expect(breakdown.recordedSeconds).toBe(5400);
    expect(breakdown.segments.map((s) => s.state)).toEqual(['on_call', 'available']);
    expect(breakdown.segments.map((s) => s.sharePct)).toEqual([
      (1800 / 5400) * 100,
      (3600 / 5400) * 100,
    ]);
    expect(occupancySegmentText(breakdown.segments[0]!)).toBe('30:00 · 33.3%');
  });

  it('is unmeasured when the only thing recorded is being signed out', () => {
    /**
     * The third state, and it is neither of the other two. There is no failed
     * read and no missing field — there is simply no shift to break down, which
     * is the same answer core gives by reporting `shift_seconds: 0`. A bar of
     * one full-width `offline` segment would claim the opposite.
     */
    const breakdown = occupancyBreakdown({
      shift_seconds: 0,
      by_state: { available: 0, reserved: 0, on_call: 0, wrapup: 0, break: 0, offline: 21600 },
    });
    expect(breakdown.measured).toBe(false);
    expect(breakdown.segments).toEqual([]);
    expect(breakdown.unaccountedSeconds).toBe(0);
  });

  it('reports no gap when the shift and the states agree', () => {
    /**
     * The middle case, and the one that decides whether the caller's gap note
     * renders. It must be exactly zero rather than "small": the note says a
     * station closed without signing out, which is a claim about the record and
     * not a rounding remark.
     */
    const breakdown = occupancyBreakdown({
      shift_seconds: 1000,
      by_state: { available: 400, reserved: 0, on_call: 600, wrapup: 0, break: 0, offline: 7200 },
    });
    expect(breakdown.recordedSeconds).toBe(1000);
    expect(breakdown.unaccountedSeconds).toBe(0);
  });

  it('reports a real gap when the shift is longer than the states account for', () => {
    /**
     * A browser closed mid-state, or a session the reaper closed:
     * `AgencyOccupancy.shift_seconds` documents that the states can sum to less.
     * This was structurally unreachable while `offline` was in the denominator —
     * the recorded sum could then only ever be ≥ a shift that excludes it — so
     * the sentence the panel renders from it was dead code that could never fire.
     */
    const breakdown = occupancyBreakdown({
      shift_seconds: 3600,
      by_state: { available: 600, reserved: 0, on_call: 1800, wrapup: 0, break: 0, offline: 900 },
    });
    expect(breakdown.recordedSeconds).toBe(2400);
    expect(breakdown.unaccountedSeconds).toBe(1200);
    // Still shares of what was RECORDED, so they reach 100% rather than quietly
    // refusing to, which would read as a rounding bug.
    expect(breakdown.segments.map((s) => s.sharePct)).toEqual([75, 25]);
  });

  it('formats a row as duration then share', () => {
    const breakdown = occupancyBreakdown({
      shift_seconds: 600,
      by_state: { available: 0, reserved: 0, on_call: 600, wrapup: 0, break: 0, offline: 0 },
    });
    expect(occupancySegmentText(breakdown.segments[0]!)).toBe('10:00 · 100%');
  });
});

describe('bucketSeries', () => {
  function bucket(start: string, attempts: number, connected: number) {
    return {
      bucket_start: start,
      attempts,
      connected,
      successes: 0,
      talk_seconds: 0,
      wrapup_seconds: 0,
    };
  }

  it('refuses to draw a single bucket', () => {
    // A one-column bar chart is a stat tile wearing axes, and the period tiles
    // above already do that job properly.
    expect(bucketSeries([bucket('2026-08-20', 5, 2)]).drawable).toBe(false);
  });

  it('refuses to draw an empty range, without throwing', () => {
    expect(bucketSeries([]).drawable).toBe(false);
    expect(bucketSeries(undefined).drawable).toBe(false);
  });

  it('keeps the server’s order rather than re-sorting', () => {
    // Re-deriving the sequence here would give the screen a second opinion about
    // an order master already fixed.
    const series = bucketSeries([
      bucket('2026-08-21', 1, 0),
      bucket('2026-08-20', 9, 4),
    ]);
    expect(series.points.map((p) => p.attempts)).toEqual([1, 9]);
  });

  it('takes the axis top from the tallest of EITHER series', () => {
    const series = bucketSeries([bucket('2026-08-20', 3, 7), bucket('2026-08-21', 5, 1)]);
    expect(series.max).toBe(7);
  });

  it('never returns a max of 0, so nothing divides by it', () => {
    const series = bucketSeries([bucket('2026-08-20', 0, 0), bucket('2026-08-21', 0, 0)]);
    expect(series.max).toBe(1);
  });

  it('labels a bucket with the day the server named', () => {
    /**
     * `bucket_start` is `YYYY-MM-DD` — a calendar day with no time and no offset
     * on it, because core formats it in SQL precisely so none attaches. The day
     * on the axis has to be that day. The zone-varying half of this property
     * lives in `agencyBucketTimezone.test.ts`, because under this suite's UTC pin
     * a wrongly-framed parse reads correctly anyway.
     */
    const series = bucketSeries([bucket('2026-08-19', 20, 8), bucket('2026-08-20', 22, 9)]);
    expect(series.points.map((p) => p.label)).toEqual(['19', '20']);
    expect(series.points.map((p) => p.title)).toEqual(['Aug 19', 'Aug 20']);
    // The key is the server's own string, untouched — it is what the chart's
    // test ids and React keys are built from.
    expect(series.points.map((p) => p.start)).toEqual(['2026-08-19', '2026-08-20']);
  });

  it('keeps a bucket whose timestamp will not parse, labelled with its raw value', () => {
    /**
     * Dropping it would break the one property this chart can be checked
     * against — that the bars sum to the totals — and would do it silently.
     */
    const series = bucketSeries([bucket('not-a-date', 4, 1), bucket('2026-08-21', 2, 1)]);
    expect(series.points).toHaveLength(2);
    expect(series.points[0]?.label).toBe('not-a-date');
  });
});

describe('BUCKET_TIMEZONE_NOTE', () => {
  it('says the day belongs to the campaign, in the product’s words', () => {
    /**
     * Buckets are cut in each campaign's own timezone, because that is the
     * timezone the calling window is enforced in. Every attempt lands in exactly
     * one bucket, so the totals are exact — but for somebody working two
     * timezones a "day" is not one contiguous 24 hours, and left unsaid that is a
     * reader filing a bug against a number that is correct.
     *
     * The note is pinned for its CONTENT, not its wording: it must promise the
     * totals and it must not do so in implementation vocabulary.
     */
    expect(BUCKET_TIMEZONE_NOTE).toContain('own campaign’s local time');
    expect(BUCKET_TIMEZONE_NOTE).toContain('totals are still exact');
    expect(BUCKET_TIMEZONE_NOTE).not.toMatch(/bucket|timezone|UTC|tz\b/i);
  });
});

describe('rowConnectRate', () => {
  it('returns an em dash for a campaign with no dials, never 0%', () => {
    // The same lie by arithmetic that a null rate would be by wire.
    expect(rowConnectRate({ attempts: 0, connected: 0 })).toBe('—');
  });

  it('divides connected by attempts, one decimal, trailing zero trimmed', () => {
    expect(rowConnectRate({ attempts: 40, connected: 10 })).toBe('25%');
    expect(rowConnectRate({ attempts: 3, connected: 1 })).toBe('33.3%');
  });
});

describe('campaignLabel and campaignNameMap', () => {
  it('falls back to a shortened id rather than inventing a name', () => {
    // `by_campaign[]` carries ids and no names. A stand-in name would be this
    // client asserting a fact the server declined to.
    const names = campaignNameMap([{ campaign_id: 'other', campaign_name: 'Renewals' }]);
    expect(campaignLabel('abcdef1234567890', names)).toBe('Campaign abcdef12');
  });

  it('reads either shape of campaign list', () => {
    // The agent's staffing history is `{campaign_id, campaign_name}`; the
    // supervisor's campaign list is `{id, name}`. One resolver, both surfaces.
    const names = campaignNameMap([
      { campaign_id: 'a', campaign_name: 'Renewals' },
      { id: 'b', name: 'Collections' },
    ]);
    expect(campaignLabel('a', names)).toBe('Renewals');
    expect(campaignLabel('b', names)).toBe('Collections');
  });

  it('treats a null name as unresolved rather than as blank', () => {
    const names = campaignNameMap([{ campaign_id: 'a', campaign_name: null }]);
    expect(campaignLabel('a', names)).toBe('Campaign a');
  });
});

describe('staffingSummary', () => {
  function entry(over: Partial<AgencyStaffingHistoryEntry> = {}): AgencyStaffingHistoryEntry {
    return {
      campaign_id: 'camp-1',
      campaign_name: 'Renewals',
      campaign_status: 'running',
      assigned_at: '2026-08-01T09:00:00.000Z',
      unassigned_at: null,
      active: true,
      ...over,
    };
  }

  it('counts current assignments from master’s own flag', () => {
    // Not from `unassigned_at === null`: master owns the staffing table and may
    // end an assignment in ways this client has no business modelling.
    const summary = staffingSummary([
      entry(),
      entry({ campaign_id: 'c2', active: false, unassigned_at: '2026-08-10T00:00:00.000Z' }),
    ]);
    expect(summary.campaigns).toBe(2);
    expect(summary.active).toBe(1);
  });

  it('counts CAMPAIGNS once however many times the agent was staffed on one', () => {
    /**
     * A staffing history repeats campaigns by construction — master's own
     * docstring for `/my-campaigns`: *"staffed in March, unstaffed in April,
     * staffed again in June is three rows and one campaign"*. `entries.length`
     * under a heading reading "Campaigns you've worked" therefore told an agent
     * they had worked three when they had worked one, and did it hardest to the
     * people with the longest history.
     */
    const summary = staffingSummary([
      entry({ assigned_at: '2026-03-01T00:00:00.000Z', active: false, unassigned_at: '2026-04-01T00:00:00.000Z' }),
      entry({ assigned_at: '2026-06-01T00:00:00.000Z' }),
    ]);
    expect(summary.campaigns).toBe(1);
    // And `active` is NOT deduplicated: it counts live assignment ROWS, which is
    // what master's flag is per.
    expect(summary.active).toBe(1);
  });

  it('does not count one campaign’s status twice because of two stints on it', () => {
    // The same defect one level down: a paused campaign an agent was staffed on
    // twice was two "waiting" campaigns.
    const summary = staffingSummary([
      entry({ campaign_status: 'paused', active: false, unassigned_at: '2026-04-01T00:00:00.000Z' }),
      entry({ campaign_status: 'paused' }),
      entry({ campaign_id: 'c2', campaign_status: 'stopped', active: false }),
      entry({ campaign_id: 'c2', campaign_status: 'stopped', active: false }),
    ]);
    expect(summary.campaigns).toBe(2);
    expect(summary.waiting).toBe(1);
    expect(summary.finished).toBe(1);
  });

  it('keeps the two axes from summing to more campaigns than exist', () => {
    /**
     * The arithmetic incoherence the caller's chain used to invite. `active` is
     * assignment-level and `waiting`/`finished` are campaign-level, so one paused
     * campaign an agent is still staffed on is counted by BOTH. Neither count is
     * wrong; adding them is — which is why the two are no longer printed in one
     * middot chain.
     */
    const summary = staffingSummary([entry({ campaign_status: 'paused' })]);
    expect(summary.campaigns).toBe(1);
    expect(summary.active).toBe(1);
    expect(summary.waiting).toBe(1);
    // 1 + 1 + 1 = 3, over a history of exactly one campaign.
    expect(summary.active + summary.waiting + summary.finished)
      .toBeGreaterThan(summary.campaigns);
  });

  it('reads "finished" through assignmentEntry, not a second status list', () => {
    /**
     * `assignmentEntry` already owns which statuses are terminal, and its shape
     * is an allow-list of BLOCKS — so a lifecycle state core adds is treated as
     * ordinary rather than as finished. A second mapping here is the copy that
     * goes stale.
     */
    const summary = staffingSummary([
      entry({ campaign_status: 'stopped' }),
      entry({ campaign_id: 'c2', campaign_status: 'completed' }),
      entry({ campaign_id: 'c3', campaign_status: 'paused' }),
      entry({ campaign_id: 'c4', campaign_status: 'running' }),
    ]);
    expect(summary.finished).toBe(2);
    expect(summary.waiting).toBe(1);
  });

  it('does not call an unrecognised status finished', () => {
    // Core owns the lifecycle and master forwards it verbatim, so a status can
    // arrive before this build knows the word.
    const summary = staffingSummary([entry({ campaign_status: 'quiesced' })]);
    expect(summary.finished).toBe(0);
  });
});

describe('agentCount and isEmptyRange', () => {
  it('renders a real zero as 0, unlike format.ts’ number helper', () => {
    expect(agentCount(0)).toBe('0');
    expect(agentCount(undefined)).toBe('—');
  });

  it('recognises a range in which nothing happened', () => {
    const stats: AgencyAgentStats = {
      agent_user_id: 'u1',
      bucket: 'day',
      from: '2026-08-20T00:00:00.000Z',
      to: '2026-08-20T12:00:00.000Z',
      totals: totals({ attempts: 0 }),
      buckets: [],
      by_campaign: [],
    };
    expect(isEmptyRange(stats)).toBe(true);
    expect(isEmptyRange(null)).toBe(false);
  });
});

describe('ratePct — the one division helper', () => {
  /**
   * Almost every rate on these surfaces is SERVED, deliberately: two places
   * dividing is two answers that round differently. The exceptions are the figures
   * no payload carries — the floor's pooled utilisation and one agent's share of a
   * campaign's conversions — and both go through here rather than a hand-rolled
   * `n / d * 100`.
   */
  it('is null on a zero denominator, never 0 and never NaN', () => {
    // `0 / 0` is `NaN`, `NaN.toFixed(1)` is `"NaN"`, and `NaN` serialises to
    // `null` — so a hand-rolled rate is wrong in a way that is invisible on the
    // wire and legible only as a broken cell on screen.
    expect(ratePct(0, 0)).toBeNull();
    expect(ratePct(5, 0)).toBeNull();
    expect(ratePct(5, -1)).toBeNull();
  });

  it('keeps a real 0 numerator as a real 0', () => {
    // Measured-and-zero is a finding. Softening it into "not measured" would be the
    // same dishonesty in the other direction.
    expect(ratePct(0, 80)).toBe(0);
  });

  it('divides', () => {
    expect(ratePct(24, 80)).toBe(30);
    expect(ratePct(60_400, 151_000)).toBe(40);
  });

  it('refuses a figure it cannot vouch for', () => {
    expect(ratePct(Number.NaN, 10)).toBeNull();
    expect(ratePct(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('agentDurationLong — the same duration, in a sentence', () => {
  /**
   * Two formats from one module, and which belongs where is the whole point.
   *
   * {@link agentSeconds} is a stopwatch, and it is right in a numeric CELL: the
   * column is right-aligned and tabular, every value has the same shape, and a
   * reader scanning it compares lengths rather than reading quantities. It fails in
   * PROSE, and it failed worst on the figures that matter most — pooled over a
   * 200-agent floor the utilisation basis read `4800:00:00 handled of 8000:00:00 on
   * shift`, a stopwatch expressing five-figure hours on the line a test elsewhere
   * calls "the figure most likely to be quoted in a pay review".
   */
  it('names its units, so a magnitude cannot be misread as another', () => {
    expect(agentDurationLong(45)).toBe('45s');
    expect(agentDurationLong(74)).toBe('1m 14s');
    expect(agentDurationLong(8_100)).toBe('2h 15m');
  });

  it('is unmistakable at the scale that broke the stopwatch form', () => {
    // 200 agents on 40-hour weeks. `8000:00:00` is not a number a reader parses;
    // `8000h` is. Neither has more information than the other — one is legible.
    expect(agentSeconds(28_800_000)).toBe('8000:00:00');
    expect(agentDurationLong(28_800_000)).toBe('8000h');
    // And twenty-two minutes stays distinguishable from twenty-two hours without
    // counting colons, which is what `median 22:00` asked of a reader.
    expect(agentDurationLong(1_320)).toBe('22m');
    expect(agentDurationLong(79_200)).toBe('22h');
  });

  it('omits a zero component rather than padding it', () => {
    // The reader is being told a magnitude, not read a clock: `2h` rather than
    // `2h 0m`, and seconds are dropped entirely once there is an hour — a pooled
    // shift quoted to the second is precision nobody asked for.
    expect(agentDurationLong(7_200)).toBe('2h');
    expect(agentDurationLong(1_800)).toBe('30m');
    expect(agentDurationLong(3_661)).toBe('1h 1m');
  });

  it('renders a real zero as a duration rather than an em dash', () => {
    // It is a formatter, not a cell: the decision about whether a zero is
    // meaningful belongs to the caller, and `utilisationBasis` already omits a break
    // nobody took rather than printing this.
    expect(agentDurationLong(0)).toBe('0s');
  });

  it('never emits a negative, which no duration on this surface is', () => {
    // A clock skew between two timestamps is the one way core could serve one, and
    // `-5s handled of 6h on shift` is a sentence about a bug rather than a shift.
    expect(agentDurationLong(-5)).toBe('0s');
  });
});

describe('windowRangeReadout — which DAYS, and in whose zone', () => {
  /**
   * The unit suite is pinned to UTC (see `vite.config.ts`), so the zone in these
   * strings is deterministic — and it is on them for the reason the grouped route
   * refuses a time dimension it cannot resolve a zone for: the day a dial lands in
   * is a statement about a timezone.
   *
   * "This week" is the name of a control, not a range. A supervisor quoting a
   * conversion rate in a pay conversation, or a dealer disputing a booking count,
   * needs the days that were counted.
   */
  it('reads the last day as the one before the EXCLUSIVE bound', () => {
    // `to` is exclusive on every one of these reads, so a week ending at midnight on
    // the 26th does NOT include the 26th — labelling it as though it did is the
    // off-by-one the half-open bound exists to avoid.
    expect(windowRangeReadout('2026-08-24T00:00:00.000Z', '2026-08-26T00:00:00.000Z')).toBe(
      '24 Aug – 25 Aug 2026 · UTC',
    );
  });

  it('collapses a single day rather than repeating it', () => {
    expect(windowRangeReadout('2026-08-26T00:00:00.000Z', '2026-08-27T00:00:00.000Z')).toBe(
      '26 Aug 2026 · UTC',
    );
    // A to-date window that has run for nine hours is still one day.
    expect(windowRangeReadout('2026-08-26T00:00:00.000Z', '2026-08-26T09:00:00.000Z')).toBe(
      '26 Aug 2026 · UTC',
    );
  });

  it('states both years only when the range straddles one', () => {
    // The one case where a single year is not enough, and the only case where the
    // extra four characters earn their place.
    expect(windowRangeReadout('2025-12-29T00:00:00.000Z', '2026-01-05T00:00:00.000Z')).toBe(
      '29 Dec 2025 – 4 Jan 2026 · UTC',
    );
  });

  it('renders nothing rather than `Invalid Date`', () => {
    // It is a caption. A caption is the last place to print a parse failure, and an
    // empty one is a fact the reader can act on ("no range shown") where `Invalid
    // Date` is a bug report.
    expect(windowRangeReadout('not-a-date', '2026-08-26T00:00:00.000Z')).toBeNull();
    expect(windowRangeReadout('2026-08-24T00:00:00.000Z', 'nope')).toBeNull();
    // And an inverted or empty window has no days to name.
    expect(windowRangeReadout('2026-08-26T00:00:00.000Z', '2026-08-24T00:00:00.000Z')).toBeNull();
    expect(windowRangeReadout('2026-08-26T00:00:00.000Z', '2026-08-26T00:00:00.000Z')).toBeNull();
  });
});
