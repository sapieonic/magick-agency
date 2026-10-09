import { describe, it, expect } from 'vitest';
import {
  parseCampaignSeriesQuery,
} from '../../../src/agency/campaign-series.js';
import {
  AGENT_STATS_BUCKETS,
  AGENT_STATS_MAX_WINDOW_DAYS,
  ROSTER_MAX_WINDOW_DAYS,
} from '../../../src/agency/agent-record.js';

// ---------------------------------------------------------------------------
// `parseCampaignSeriesQuery` — the rules, without a Fastify instance.
//
// The route test (`campaign-stats-series-route.test.ts`) exercises these through
// HTTP and asserts the status codes and the bodies. This file asserts the two
// things that are properties of the MODULE rather than of the response, and that
// a status-code assertion cannot see:
//
//   * the cap and the vocabulary are the IMPORTED constants, not local copies
//     holding the same values today. A second `92` compiles, passes every HTTP
//     test, and diverges the first time somebody tunes one of them.
//   * the boundary arithmetic, at the exact millisecond either side of the cap.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const parse = (query: Record<string, unknown>) => parseCampaignSeriesQuery(query);
const issuesOf = (query: Record<string, unknown>): Array<{ param: string; message: string }> => {
  const result = parse(query);
  expect(result.ok, 'expected a refusal').toBe(false);
  return result.ok ? [] : result.issues;
};

describe('the window is required and half-open', () => {
  it('accepts a date-only pair as UTC midnights', () => {
    const result = parse({ from: '2026-08-11', to: '2026-08-14' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `parseFilterDate`'s rule, imported rather than re-implemented — a date-only
    // bound is `T00:00:00Z`. Worth pinning here because the consequence is visible
    // on the payload: on an `Asia/Kolkata` campaign this starts the series at 05:30
    // local, so the first bucket is a PARTIAL day. Reinterpreting the bound as local
    // midnight was the alternative and would make the same URL mean a different
    // window per campaign.
    expect(result.filters.from.toISOString()).toBe('2026-08-11T00:00:00.000Z');
    expect(result.filters.to.toISOString()).toBe('2026-08-14T00:00:00.000Z');
  });

  it('requires both bounds, and names each missing one', () => {
    expect(issuesOf({}).map((i) => i.param).sort()).toEqual(['from', 'to']);
    expect(issuesOf({ from: '2026-08-11' })[0]!.param).toBe('to');
    expect(issuesOf({ to: '2026-08-14' })[0]!.param).toBe('from');
  });

  it('refuses a window of zero width, not just an inverted one', () => {
    // A half-open window `[x, x)` contains no instants, so it has no buckets and no
    // honest answer. Emptying it silently would report "this campaign dialled
    // nobody".
    for (const to of ['2026-08-11', '2026-08-10']) {
      expect(issuesOf({ from: '2026-08-11', to })[0]!.message).toContain('half-open');
    }
  });

  it('rejects a shape `parseFilterDate` refuses, rather than coercing it', () => {
    // The date rules are imported, so a second opinion about what an ISO date is
    // cannot appear here. `2026-02-30` matches the pattern and `new Date` answers
    // March 2nd — a real result set for a window nobody asked for.
    expect(issuesOf({ from: '2026-02-30', to: '2026-03-05' })[0]!.param).toBe('from');
    expect(issuesOf({ from: '17 Aug 2026', to: '2026-08-20' })[0]!.param).toBe('from');
  });
});

describe('the cap is the ROSTER\'s 92, and it is the imported constant', () => {
  it('is not a local copy of the number', () => {
    // The assertion that bites if somebody declares a second `92` here: the refusal
    // message is built FROM the constant, so it moves when the constant does.
    const wide = issuesOf({
      from: iso(0),
      to: iso((ROSTER_MAX_WINDOW_DAYS + 1) * MS_PER_DAY),
    });
    expect(wide[0]!.param).toBe('from');
    expect(wide[0]!.message).toBe(
      `the window must be at most ${ROSTER_MAX_WINDOW_DAYS} days — request a narrower range`,
    );
  });

  it('is NOT the per-agent record\'s 366', () => {
    // Deliberately different, and the reason is specific to this read: the zero-fill
    // makes the row count the WINDOW WIDTH rather than the volume, so a year of daily
    // buckets is 366 rows of mostly zeros on a screen that shows a quarter at most.
    expect(ROSTER_MAX_WINDOW_DAYS).toBeLessThan(AGENT_STATS_MAX_WINDOW_DAYS);
    const yearWide = issuesOf({ from: iso(0), to: iso(200 * MS_PER_DAY) });
    expect(yearWide[0]!.message).toContain(`${ROSTER_MAX_WINDOW_DAYS} days`);
  });

  it('accepts exactly the cap and refuses one millisecond more', () => {
    const from = iso(0);
    expect(parse({ from, to: iso(ROSTER_MAX_WINDOW_DAYS * MS_PER_DAY) }).ok).toBe(true);
    expect(parse({ from, to: iso(ROSTER_MAX_WINDOW_DAYS * MS_PER_DAY + 1) }).ok).toBe(false);
  });
});

describe('the bucket vocabulary is the imported one', () => {
  it('defaults to day and accepts every declared unit', () => {
    const defaulted = parse({ from: '2026-08-11', to: '2026-08-14' });
    expect(defaulted.ok && defaulted.filters.bucket).toBe('day');
    for (const unit of AGENT_STATS_BUCKETS) {
      const result = parse({ from: '2026-08-11', to: '2026-08-14', bucket: unit });
      expect(result.ok, unit).toBe(true);
    }
  });

  it('refuses an unknown unit and ECHOES the declared set', () => {
    const issues = issuesOf({ from: '2026-08-11', to: '2026-08-14', bucket: 'hour' });
    expect(issues[0]!.param).toBe('bucket');
    // Built from the imported vocabulary, so a fourth unit added to
    // `AgencyStatsBucketUnit` appears in this message without anyone editing it —
    // and a local copy of the list would stop matching.
    expect(issues[0]!.message).toBe(
      `unknown bucket: hour — expected one of ${AGENT_STATS_BUCKETS.join(', ')}`,
    );
  });

  it('refuses the comma form rather than silently taking the first unit', () => {
    // `?bucket=day,week` arrives as the single string `'day,week'`, which no
    // vocabulary contains. Two groupings is not a request this route can honour and
    // the caller is told so.
    expect(issuesOf({ from: '2026-08-11', to: '2026-08-14', bucket: 'day,week' })[0]!.param)
      .toBe('bucket');
  });
});

describe('what the parser deliberately does not produce', () => {
  it('never yields a campaignId, however the query spells it', () => {
    const result = parse({
      from: '2026-08-11', to: '2026-08-14',
      campaign_id: '11111111-2222-3333-4444-555555555555',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The path fixes the campaign, so a query parameter for it can only agree with
    // `:id` or be wrong — the same reason the campaign-scoped attempt spine has no
    // `campaignId` while the agent-scoped one does. The public API layer's unknown-query-parameter
    // check is what turns it into a 400; the internal handlers simply have nowhere to put it.
    expect(Object.keys(result.filters).sort()).toEqual(['bucket', 'from', 'to']);
    expect(result.filters as unknown as Record<string, unknown>).not.toHaveProperty('campaignId');
  });

  it('never yields a timezone — there is no `tz` parameter', () => {
    const result = parse({ from: '2026-08-11', to: '2026-08-14', tz: 'America/New_York' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Buckets are cut in the CAMPAIGN's own zone, the same one its calling window is
    // enforced in, and the zone is echoed on the response. A `tz` would make every
    // bucket a function of a parameter the reader supplied, so the same call would
    // move between days depending on who is looking.
    expect(Object.keys(result.filters).sort()).toEqual(['bucket', 'from', 'to']);
  });

  it('reports EVERY problem in one pass rather than stopping at the first', () => {
    const issues = issuesOf({ from: '2026-08-14', to: '2026-08-11', bucket: 'hour' });
    // A caller with two mistakes should not go round the loop twice.
    expect(issues.map((i) => i.param).sort()).toEqual(['bucket', 'from']);
  });
});
