import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The compliance abandonment metric.
//
// **The meter is NOT mocked here**, unlike `test/unit/utils/metrics.test.ts`.
// That file's job is to pin instrument names and label sets; this file's job is
// to read the values back, which a stand-in meter cannot do. Every case runs on
// a real OTel meter provider (`startProcess`), so every assertion below is
// against the numbers an export would see.
//
// The centrepiece is `INDEPENDENCE LOCK` (do not prune). The cross-check between the counter and the table number is
// only evidence if they are derived from DIFFERENT
// sources — two numbers tracing back to the same
// wrong write once agreed perfectly while a metric returned 0 for months. A comment
// asserting independence is worthless, so it is asserted as a
// behavioural difference instead: **the two must respond differently to a
// restart**, and re-pointing either side at the other's source breaks it.
//
// The metric reader is `test/helpers/otel-metric-reader.ts`, over a real
// `@opentelemetry/sdk-metrics` provider (devDependency; `ScrapeMetricReader` inlined).
// There is no HTTP scrape endpoint: the series are asserted against one collection
// of the meter.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

// The metric reader comes from the test helper.
import type { ScrapeMetricReader } from '../../helpers/otel-metric-reader.js';
import { collectMetric, metricValue } from '../../helpers/otel-metric-reader.js';

const LABELS = { tenant_id: 't1', campaign_id: 'camp-1' };

let reader: ScrapeMetricReader;
let metrics: typeof import('@magick-agency/observability/metrics/agency');
let abandonment: typeof import('../../../src/agency/abandonment-metrics.js');

/**
 * A new process: fresh modules on a fresh meter provider — exactly what a
 * restart gives the counters (nothing) and the SQL-derived window (a re-read).
 */
async function startProcess(): Promise<void> {
  vi.resetModules();
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  reader = installMetricReader();
  metrics = await import('@magick-agency/observability/metrics/agency');
  abandonment = await import('../../../src/agency/abandonment-metrics.js');
}

const refreshAbandonmentWindow = () => abandonment.refreshAbandonmentWindow();

/** The live value of a metric series, or undefined when the series is absent. */
async function seriesValue(name: string, labels: Record<string, string>): Promise<number | undefined> {
  return (await metricValue(reader, name, labels)) ?? undefined;
}

/** A window row as the SQL returns it — counts are text, per `::text` casts. */
function dbRow(over: Record<string, unknown> = {}) {
  return {
    tenant_id: 't1', campaign_id: 'camp-1', answered: '100', abandoned: '3', ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // A fresh process per case: counters start at zero and the published window
  // is empty, so no case can read the previous one's campaigns.
  await startProcess();
  pool.query.mockResolvedValue({ rows: [dbRow()] });
});

// ═══════════════════════════════════════════════════════════════════════════
// Staleness. `set`-only publishing is a one-way door.
// ═══════════════════════════════════════════════════════════════════════════

describe('a campaign that leaves the window stops reporting', () => {
  /**
   * A gauge that is only ever `set` keeps serving its last value forever unless
   * something removes it. That is not cosmetic here: the auto-pause and the compliance alerts read
   * `agency_abandonment_rate_24h`, so a campaign that stopped dialing yesterday
   * can hold a guardrail down — or trip one — on a number describing a window it
   * is no longer in. "No data" has to be reachable, not just initial.
   */
  it('removes all three series once the campaign drops out of the 24h window', async () => {
    pool.query.mockResolvedValue({ rows: [dbRow()] });
    await refreshAbandonmentWindow();
    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBeDefined();
    expect(await seriesValue('agency_abandonment_window_answered_24h', LABELS)).toBeDefined();

    // The next refresh no longer sees this campaign at all.
    pool.query.mockResolvedValue({ rows: [] });
    await refreshAbandonmentWindow();

    expect(
      await seriesValue('agency_abandonment_rate_24h', LABELS),
      'the rate outlived its window — an alert reading this is acting on yesterday',
    ).toBeUndefined();
    expect(await seriesValue('agency_abandonment_window_answered_24h', LABELS)).toBeUndefined();
    expect(await seriesValue('agency_abandonment_window_abandoned_24h', LABELS)).toBeUndefined();
  });

  it('clears a published rate when the campaign goes back to having no answers', async () => {
    pool.query.mockResolvedValue({ rows: [dbRow()] });
    await refreshAbandonmentWindow();
    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBeDefined();

    // Still in the window, but the denominator is now 0 — `abandonmentRatePct`
    // returns null, which this file elsewhere pins as "absent, not 0".
    pool.query.mockResolvedValue({ rows: [dbRow({ answered: '0', abandoned: '0' })] });
    await refreshAbandonmentWindow();

    expect(
      await seriesValue('agency_abandonment_rate_24h', LABELS),
      'a null rate left the previous value in place, which is the 0-vs-no-data confusion one pass later',
    ).toBeUndefined();
    // The window counts themselves are still real and still published.
    expect(await seriesValue('agency_abandonment_window_answered_24h', LABELS)).toBe(0);
  });

  it('leaves a campaign that is still in the window alone', async () => {
    // The negative control: removal keyed on absence, not run on every refresh.
    pool.query.mockResolvedValue({ rows: [dbRow()] });
    await refreshAbandonmentWindow();
    await refreshAbandonmentWindow();
    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The lock the whole cross-check rests on.
// ═══════════════════════════════════════════════════════════════════════════

describe('INDEPENDENCE LOCK (do not prune)', () => {
  it('counters and the window respond DIFFERENTLY to a restart', async () => {
    // ── Before the restart: a shift's worth of calls, counted in process. ──
    for (let i = 0; i < 100; i++) metrics.agencyAnsweredTotal.inc(LABELS);
    for (let i = 0; i < 3; i++) metrics.agencyAbandonedTotal.inc(LABELS);
    await refreshAbandonmentWindow();

    expect(await seriesValue('agency_answered_total', LABELS)).toBe(100);
    expect(await seriesValue('agency_abandoned_total', LABELS)).toBe(3);
    expect(await seriesValue('agency_abandonment_window_abandoned_24h', LABELS)).toBe(3);
    // Both sides agree while the process is up. This is the counter-versus-table cross-check —
    // and on its own it proves nothing, which is why the restart follows.

    // ── The restart: fresh modules on a fresh meter provider. ──
    await startProcess();
    await refreshAbandonmentWindow();

    // The COUNTERS are gone. They are process-local and must be: a
    // counter that survived a restart would be lying about its own reset.
    expect(
      await seriesValue('agency_abandoned_total', LABELS),
      'the abandoned counter survived a restart — it is being read from the table, '
      + 'which makes the counter-versus-table cross-check circular',
    ).toBeUndefined();
    expect(await seriesValue('agency_answered_total', LABELS)).toBeUndefined();

    // The WINDOW is intact, because it was re-read from `agency_call_attempts`.
    expect(
      await seriesValue('agency_abandonment_window_abandoned_24h', LABELS),
      'the window went to zero across a restart — it is being derived from the '
      + 'counters, so acceptance (b) fails and the cross-check is circular',
    ).toBe(3);
    expect(await seriesValue('agency_abandonment_window_answered_24h', LABELS)).toBe(100);
    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBe(3);
  });

});

// ═══════════════════════════════════════════════════════════════════════════
// The rate itself, and the low-sample trap the guardrail will walk into.
// ═══════════════════════════════════════════════════════════════════════════

describe('the rate is null on no data, never 0 and never 100', () => {
  it('does NOT publish a rate series when the rate is null', async () => {
    pool.query.mockResolvedValue({ rows: [dbRow({ answered: '0', abandoned: '0' })] });
    await refreshAbandonmentWindow();

    // Absent, not zero. "No data" and "0%" are different answers and an alert rule
    // can only distinguish them if we decline to invent the second one.
    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBeUndefined();
    // The terms are still published — a supervisor needs to see the sample size.
    expect(await seriesValue('agency_abandonment_window_answered_24h', LABELS)).toBe(0);
  });

  it('exports the numerator and denominator, not just the ratio', async () => {
    // The `no_balance_row` lesson: 1-abandoned-of-1 and 30-of-3000 are both "1%
    // vs 100%" stories that a lone rate series cannot tell apart, and the
    // auto-pause guardrail would fire on the first call of the day.
    pool.query.mockResolvedValue({ rows: [dbRow({ answered: '1', abandoned: '1' })] });
    await refreshAbandonmentWindow();

    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBe(100);
    expect(await seriesValue('agency_abandonment_window_answered_24h', LABELS)).toBe(1);
    expect(await seriesValue('agency_abandonment_window_abandoned_24h', LABELS)).toBe(1);
  });

  it('publishes every campaign in the window, not just the first', async () => {
    pool.query.mockResolvedValue({
      rows: [dbRow(), dbRow({ campaign_id: 'camp-2', answered: '200', abandoned: '10' })],
    });
    await refreshAbandonmentWindow();

    expect(await seriesValue('agency_abandonment_rate_24h', LABELS)).toBe(3);
    expect(await seriesValue('agency_abandonment_rate_24h', { tenant_id: 't1', campaign_id: 'camp-2' })).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Acceptance (c): the series are on the meter the metrics port serves.
// ═══════════════════════════════════════════════════════════════════════════

describe('(c) · the series are registered', () => {
  it('serves all five series from the meter', async () => {
    // Not a re-assertion of `metrics.test.ts` (which stubs the meter and pins
    // names/labels): this renders what `/metrics` serves from the REAL meter
    // provider, which is what acceptance (c) actually claims.
    //
    // There is no HTTP scrape endpoint in Magick Agency. The claim — all five series
    // are on the meter, with this campaign's labels, after one publish — is asserted
    // against one collection.
    metrics.agencyAnsweredTotal.inc(LABELS);
    metrics.agencyAbandonedTotal.inc(LABELS);
    await refreshAbandonmentWindow();
    for (const name of [
      'agency_answered_total',
      'agency_abandoned_total',
      'agency_abandonment_rate_24h',
      'agency_abandonment_window_answered_24h',
      'agency_abandonment_window_abandoned_24h',
    ]) {
      expect(await seriesValue(name, LABELS), `${name} is not on the scrape`).toBeDefined();
    }
  });

  it('labels every series by tenant AND campaign', async () => {
    // `campaign_id` is not optional decoration — the abandonment predicate is per-campaign
    // and US TSR measures per campaign, so a series without it cannot be
    // cross-checked against the SQL or used by the guardrail.
    metrics.agencyAbandonedTotal.inc(LABELS);
    const [point] = await collectMetric(reader, 'agency_abandoned_total');
    expect(Object.keys(point!.attributes).sort()).toEqual(['campaign_id', 'tenant_id']);
  });
});
