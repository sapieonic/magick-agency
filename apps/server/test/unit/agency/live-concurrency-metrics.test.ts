import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// The dialer's live-concurrency signal (2026-09-08 pilot, finding 4).
//
// `calls_active_current` is set from `CallManager`'s AI `activeSessions` map, and
// an agency leg is a WebRTC bridge session that never enters it — so the pilot ran
// its whole shift with the platform's only live-concurrency number pinned at zero.
// This file asserts the replacement family behaves like a *live* signal on both
// views of it — the OTLP export and the `:9090` scrape, which read the same OTel
// meter — and that is three separable properties:
//
//   1. **Both views carry it.** Grafana Cloud is OTLP-fed, so a metric missing
//      from OTLP is invisible from the one place an operator looks — the
//      `gemini_backend_breaker_open` trap. Every value assertion below is against
//      what a collection would actually emit, never against "an object exists".
//   2. **Absence is reachable.** A campaign that goes quiet must LEAVE both views,
//      and a snapshot that has gone stale must export nothing rather than the last
//      good numbers. The reassuring direction is the dangerous one: a stalled
//      dialer still claiming 40 calls up looks healthier than one claiming none.
//   3. **The dialer's own vocabulary survives the export.** `dialing`/`ringing`
//      (dials in flight) and `bridged` (conversations in progress) must land on
//      different series. The pilot's "33 bridged / 32% bridge rate" was an
//      overstatement in both directions precisely because those were conflated,
//      and a future over-dial factor is applied to the first quantity, not the
//      second.
//
// Harness: a REAL OTel meter provider, installed before `metrics.ts` loads, with
// the production scrape reader. `collectOtel` reads what a collection (an OTLP
// export) carries; `collectProm` renders the `:9090` Prometheus text and parses
// it back, so both views are asserted end to end.
//
// Magick Agency has no OTLP exporter and no `:9090` scrape at runtime. So:
//   - the reader is `test/helpers/otel-metric-reader.ts`, over a real `@opentelemetry/sdk-metrics` provider (devDependency; `ScrapeMetricReader` is inlined because there is no exporter wiring in the app);
//   - `collectProm` reads that same collection and returns it in the scrape's
//     `{ value, labels }` shape. Every case that asserted "both views" therefore
//     asserts the one view that exists, twice; the property each case names about
//     the series itself (presence, values, label keys and order, absence, expiry,
//     separation by state, folding) is still asserted against a real collection.
//   - DELETED: "a collection-time fault elsewhere cannot fail the whole /metrics
//     response" — its subject is `renderPrometheusScrape`'s error comment and the
//     `/metrics` response, neither of which exists here.
// Mock specifiers follow the path rule (logger → `@magick-agency/observability`,
// `db/connection` → `@magick-agency/db`).
// ---------------------------------------------------------------------------

const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const {
  publishLiveConcurrency, refreshLiveConcurrency, resetLiveConcurrencyMetricsState,
  UNKNOWN_ATTEMPT_STATE,
} = await import('../../../src/agency/live-concurrency-metrics.js');
const { collectMetric } = await import('../../helpers/otel-metric-reader.js');
const { metrics } = await import('@opentelemetry/api');
type AgencyLiveAttemptStateRow =
  import('../../../src/db/repositories/agency.repository.js').AgencyLiveAttemptStateRow;

const SERIES = 'agency_live_attempts_current';

/** A repository row, typed so a field the publisher starts reading cannot arrive undefined. */
function row(over: Partial<AgencyLiveAttemptStateRow> = {}): AgencyLiveAttemptStateRow {
  return { tenant_id: 't1', campaign_id: 'camp-1', state: 'dialing', live: 3, ...over };
}

/** Drive one collection — what an OTLP export would carry — and return this series. */
async function collectOtel(): Promise<Array<{ value: number; attrs: Record<string, string> }>> {
  return (await collectMetric(reader, SERIES))
    .map((p) => ({ value: p.value, attrs: p.attributes as Record<string, string> }));
}

/** Render the `:9090` scrape and parse this series back out of the text. */
// There is no `:9090` scrape in Magick Agency (see the header). This reads
// the same collection `collectOtel` does, in the scrape's `{ value, labels }` shape.
async function collectProm(): Promise<Array<{ value: number; labels: Record<string, string> }>> {
  return (await collectMetric(reader, SERIES))
    .map((p) => ({ value: p.value, labels: p.attributes as Record<string, string> }));
}

/** The `state` → count shape both views should agree on, keyed for comparison. */
function byState(samples: Array<{ value: number; labels?: Record<string, string>; attrs?: Record<string, string> }>) {
  return Object.fromEntries(samples.map((s) => [(s.labels ?? s.attrs)!['state'], s.value]));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetLiveConcurrencyMetricsState();
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 1 — one snapshot, both pipelines.
// ═══════════════════════════════════════════════════════════════════════════

// There is ONE view here (no exporter, no scrape — see the header), so no name claims two.
describe('live concurrency · a snapshot reaches the metric collection', () => {
  it('serves the series in the SDK collection', async () => {
    // Not a re-assertion of `metrics.test.ts` (which stubs the meter to pin
    // names): this renders what `/metrics` serves and what an export collects,
    // from the real meter, under the SAME name.
    publishLiveConcurrency([row()]);
    expect(await collectProm(), `${SERIES} is not on the scrape`).toHaveLength(1);
    expect(await (await collectOtel()), `${SERIES} is not in the OTLP collection`).toHaveLength(1);
  });

  it('reports the published values, from one publish', async () => {
    publishLiveConcurrency([
      row({ state: 'dialing', live: 4 }),
      row({ state: 'bridged', live: 2 }),
    ]);

    const prom = byState(await collectProm());
    const otel = byState((await collectOtel()));
    expect(prom).toEqual({ dialing: 4, bridged: 2 });
    // Asserted as equality between the two views rather than twice against a
    // literal: what breaks in practice is one pipeline being fed and the other
    // being forgotten, and that is invisible when each is checked alone.
    expect(otel).toEqual(prom);
  });

  it('labels every sample tenant, campaign AND state, in that order', async () => {
    // `campaign_id` is admissible here for the reason it is on the abandonment
    // gauges and refused on the hourly billing counters: this is a gauge re-derived
    // from a fresh SQL read each pass, so a finished campaign leaves the export
    // rather than accreting a permanent series.
    publishLiveConcurrency([row()]);

    const [promSample] = await collectProm();
    expect(Object.keys(promSample!.labels)).toEqual(['tenant_id', 'campaign_id', 'state']);
    const [otelSample] = (await collectOtel());
    expect(Object.keys(otelSample!.attrs)).toEqual(['tenant_id', 'campaign_id', 'state']);
  });

  it('re-reports the whole snapshot on every collection, with no collection-time consumption', async () => {
    // Both views are pull-based and a gauge is a statement about *now*, so a
    // campaign that stopped changing must still be reported. The load-bearing half
    // is the SECOND and THIRD collections: the observable callback must be
    // side-effect free, or a collection would consume the snapshot.
    publishLiveConcurrency([row(), row({ campaign_id: 'camp-2', live: 1 })]);

    const first = await collectOtel();
    expect((await collectOtel())).toEqual(first);
    expect((await collectOtel())).toEqual(first);

    const firstProm = await collectProm();
    expect(await collectProm()).toEqual(firstProm);
    expect(firstProm).toHaveLength(2);
  });

  it('wires the repository read through to the publish', async () => {
    // The one assertion that the timer's callback actually joins the two halves.
    // Everything else in this file drives `publishLiveConcurrency` directly.
    pool.query.mockResolvedValue({
      rows: [{ tenant_id: 't1', campaign_id: 'camp-1', state: 'bridged', live: '6' }],
    });

    await refreshLiveConcurrency();

    expect(byState((await collectOtel()))).toEqual({ bridged: 6 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 2 — absence has to be reachable, on both views.
// ═══════════════════════════════════════════════════════════════════════════

describe('live concurrency · a campaign that leaves the snapshot leaves the export', () => {
  it('drops it from the scrape and from the OTLP collection', async () => {
    // A `.set`-only gauge is a one-way door: a campaign that finished its roster
    // hours ago would keep reporting calls in flight for the life of the replica.
    // Two things make this pass: the callback observes only the current snapshot,
    // and the meter exports gauges with delta temporality, so an unobserved label
    // set is absent rather than re-exported at its last value.
    publishLiveConcurrency([row(), row({ campaign_id: 'camp-2', live: 1 })]);
    expect(await collectProm()).toHaveLength(2);
    expect((await collectOtel())).toHaveLength(2);

    publishLiveConcurrency([row()]);

    const promCampaigns = (await collectProm()).map((s) => s.labels['campaign_id']);
    expect(promCampaigns, 'camp-2 outlived its own calls on the scrape').toEqual(['camp-1']);
    expect((await collectOtel()).map((s) => s.attrs['campaign_id'])).toEqual(['camp-1']);
  });

  it('exports nothing at all when the whole floor goes quiet', async () => {
    // The widest prune case, and the one where a merge-instead-of-replace bug is
    // most visible: N campaigns to zero. An idle dialer must be distinguishable
    // from a broken one, and "no series" is that distinction.
    publishLiveConcurrency([row(), row({ campaign_id: 'camp-2' })]);
    expect((await collectOtel())).toHaveLength(2);

    publishLiveConcurrency([]);

    expect(await collectProm()).toEqual([]);
    expect((await collectOtel())).toEqual([]);
  });

  it('drops a single state that emptied while the campaign stayed busy', async () => {
    // The per-state form of the same prune, and the one that matters to pacing: a
    // campaign whose dials all connected has ZERO in flight, and a `dialing` series
    // frozen at its last value would make the floor look permanently committed to
    // calls that have long since been answered or given up.
    publishLiveConcurrency([row({ state: 'dialing', live: 3 }), row({ state: 'bridged', live: 1 })]);
    expect(byState(await collectProm())).toEqual({ dialing: 3, bridged: 1 });

    publishLiveConcurrency([row({ state: 'bridged', live: 4 })]);

    expect(byState(await collectProm())).toEqual({ bridged: 4 });
    expect(byState((await collectOtel()))).toEqual({ bridged: 4 });
  });

  it('STOPS exporting once the snapshot goes stale, rather than asserting a busy floor', async () => {
    // The failure this guards is the reassuring one. `publishLiveConcurrency` is
    // only reached after `liveByState()` succeeds, so if that query starts failing
    // — a permission change, a timeout, a degraded replica — the refresh loop logs
    // and returns. Without an expiry both views would go on exporting the last good
    // snapshot indefinitely: a dialer that stalled at 40 calls in flight keeps
    // reporting 40, and nothing distinguishes it from a busy healthy one.
    //
    // Applied at COLLECTION, so both the export and the scrape stop at once.
    // The fake clock starts in the PAST. A gauge sample is stamped with
    // `Date.now()` and the SDK keeps the sample with the LATER stamp, so a clock
    // advanced beyond real time and then restored would pin this case's stale
    // value into the cases that follow.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 10 * 60_000);
    try {
      publishLiveConcurrency([row()]);
      expect((await collectOtel())).toHaveLength(1);

      // Well inside the TTL: an ordinary blip must not blank a live signal.
      vi.advanceTimersByTime(60_000);
      expect((await collectOtel()), 'a few missed refreshes should not drop the snapshot').toHaveLength(1);
      expect(await collectProm()).toHaveLength(1);

      // Now past it — 90s, six missed refreshes at the 15s cadence.
      vi.advanceTimersByTime(31_000);
      expect((await collectOtel()), 'the OTLP view kept exporting a stale floor').toEqual([]);
      expect(await collectProm(), 'the scrape kept serving a stale floor').toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh publish revives a snapshot that had gone stale', async () => {
    // The expiry must not latch: a recovered query has to bring the series back
    // without a restart, or the guard trades one silence for another.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 10 * 60_000); // in the past — see the case above
    try {
      publishLiveConcurrency([row()]);
      vi.advanceTimersByTime(120_000);
      expect((await collectOtel())).toEqual([]);

      publishLiveConcurrency([row()]);

      expect((await collectOtel())).toHaveLength(1);
      expect(await collectProm()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('exports nothing before the first publish', async () => {
    // A booting replica must not report an empty floor as a real reading of zero.
    // Absent and zero are different answers; the timestamp-zero branch is what
    // keeps them apart.
    expect((await collectOtel())).toEqual([]);
    expect(await collectProm()).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 3 — the dialer's vocabulary, which is the reason for the `state` label.
// ═══════════════════════════════════════════════════════════════════════════

describe('live concurrency · dials in flight vs conversations in progress', () => {
  it('resolves them to DIFFERENT series', async () => {
    // The whole point of the `state` dimension. `dialing`/`ringing` is capacity
    // committed to phones that may never be answered — the quantity any future
    // over-dial factor multiplies — while `bridged` is capacity actually earning.
    // A flat occupancy gauge cannot tell a floor of 5 ringing phones from a floor
    // of 5 live conversations, and the pilot's bridge-rate figure was wrong in both
    // directions for exactly that reason.
    publishLiveConcurrency([
      row({ state: 'dialing', live: 5 }),
      row({ state: 'ringing', live: 2 }),
      row({ state: 'bridged', live: 1 }),
    ]);

    const prom = byState(await collectProm());
    expect(prom).toEqual({ dialing: 5, ringing: 2, bridged: 1 });
    expect(byState((await collectOtel()))).toEqual(prom);

    // Stated the way an operator would ask it, so a regression that merged the
    // states reads as a failure of the question rather than of an array shape.
    const dialsInFlight = prom['dialing']! + prom['ringing']!;
    const conversations = prom['bridged']!;
    expect(dialsInFlight).toBe(7);
    expect(conversations).toBe(1);
    expect(dialsInFlight).not.toBe(conversations);
  });

  it('keeps every live state separable, and none of them is `ended`', async () => {
    // All five at once: a `queued` backlog, dials out, and calls up are three
    // different operator actions (raise the cadence, wait, do nothing) and the
    // series has to support telling them apart. `ended` is excluded by the SQL, so
    // its absence here is the export-side half of that guarantee.
    publishLiveConcurrency([
      row({ state: 'queued', live: 9 }),
      row({ state: 'dialing', live: 4 }),
      row({ state: 'ringing', live: 3 }),
      row({ state: 'answered', live: 2 }),
      row({ state: 'bridged', live: 1 }),
    ]);

    const states = (await collectProm()).map((s) => s.labels['state']).sort();
    expect(states).toEqual(['answered', 'bridged', 'dialing', 'queued', 'ringing']);
    expect(states).not.toContain('ended');
  });

  it('keeps the same state on different campaigns as separate series', async () => {
    // The negative control on the key: a publisher that keyed only on `state` would
    // pass every assertion above and silently sum two tenants' floors together.
    publishLiveConcurrency([
      row({ campaign_id: 'camp-1', state: 'bridged', live: 2 }),
      row({ campaign_id: 'camp-2', state: 'bridged', live: 5 }),
      row({ tenant_id: 't2', campaign_id: 'camp-2', state: 'bridged', live: 8 }),
    ]);

    const samples = await collectProm();
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.value).sort((a, b) => a - b)).toEqual([2, 5, 8]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The label-vocabulary guard, and the scrape-fault guard.
// ═══════════════════════════════════════════════════════════════════════════

describe('live concurrency · a label value is owned by code, never by the column', () => {
  it('folds a state outside AGENCY_ATTEMPT_LIVE_STATES into one `unknown` bucket', async () => {
    // Unreachable on today's schema — `ck_agency_attempt_state`
    // constrains the column to the six known values. What makes it reachable is one
    // line in a future migration, in a commit that touches no TypeScript, and
    // without this fold that commit would mint a permanent Prometheus series per
    // new string. The rule is that a label vocabulary is owned by source code, and
    // a CHECK constraint in another file is not source code in that sense.
    publishLiveConcurrency([
      row({ state: 'dialing', live: 2 }),
      row({ state: 'transferring', live: 1 }),
    ]);

    expect(byState(await collectProm())).toEqual({ dialing: 2, [UNKNOWN_ATTEMPT_STATE]: 1 });
  });

  it('SUMS distinct unknown states rather than letting one overwrite the other', async () => {
    // The fold can collide where the SQL's own grouping cannot, and a duplicated
    // label set would give the gauge two observations for one attribute set in a
    // single collection, so a count vanishes — and the sum must stay reconcilable
    // with the tick's `occupied`, which counted both rows.
    publishLiveConcurrency([
      row({ state: 'transferring', live: 3 }),
      row({ state: 'parked', live: 4 }),
    ]);

    expect(byState(await collectProm())).toEqual({ [UNKNOWN_ATTEMPT_STATE]: 7 });
    expect((await collectOtel())).toHaveLength(1);
  });

  it('folds without dropping, so the total still reconciles with `occupied`', async () => {
    // Dropping the row would be the quiet failure: `sum(agency_live_attempts_current)`
    // would come out below the concurrency the pacing tick computed from the same
    // predicate, and an operator comparing the two would find a discrepancy with no
    // series to explain it.
    publishLiveConcurrency([
      row({ state: 'bridged', live: 6 }),
      row({ state: 'nonsense', live: 4 }),
    ]);

    const total = (await collectProm()).reduce((sum, s) => sum + s.value, 0);
    expect(total).toBe(10);
  });

  it('does not alias the caller\'s array', async () => {
    // `readonly` constrains our view, not the caller's handle, and `metrics.ts` is
    // the most widely imported module in the repo — a future caller retaining and
    // mutating its array would corrupt the exported floor with nothing failing.
    const mutable = [row()];
    publishLiveConcurrency(mutable);
    mutable.push(row({ campaign_id: 'INJECTED' }));

    expect((await collectProm()).map((s) => s.labels['campaign_id'])).toEqual(['camp-1']);
  });
});
