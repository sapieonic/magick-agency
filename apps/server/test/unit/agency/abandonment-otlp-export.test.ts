import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Ticket 86d44par2 — the three compliance gauges had no OTel counterpart at all.
//
// `agency_abandonment_rate_24h` and its two terms are the numbers a regulator
// asks for and the numbers `AD-P4-C-02`'s auto-pause is judged by, and all three
// lived only on the prom-client registry served on :9090. Grafana Cloud is
// OTLP-fed, so from the place anyone actually looks they did not exist — the
// same defect this codebase already records for `gemini_backend_breaker_open`
// and for `agency_dnc_synced` (MAG-109).
//
// Worth being precise about what that did and did not break, because the two
// have very different compliance readings: `refreshAbandonmentWindow` hands the
// SAME rows to `enforceAbandonmentCeiling`, so the guardrail was reading the
// window directly and was NOT blinded by this. What was lost was the ability to
// see it working — which is why every assertion below is against the value an
// OTLP collection would export, never against "an OTel object was constructed".
//
// They are now one observable gauge each, feeding both the OTLP export and the
// `:9090` scrape, so the prom-client half — and the partial-publish hazard its
// `publishedLabels` memo had to guard against — no longer exists.
//
// The harness mirrors `dnc-synced-dual-emit.test.ts` deliberately: `@opentelemetry/api`
// is mocked to CAPTURE the observable callbacks, so each assertion is against what
// a collection would emit.
//
// PORT NOTE (magick-agency, Phase 6): core test/unit/agency/abandonment-otlp-export.test.ts
// @4850d1d9, verbatim. Only import/mock specifiers changed (path rule: metrics →
// `@magick-agency/observability/metrics/agency`, `db/connection` → `@magick-agency/db`,
// the predicate type → `@magick-agency/domain`). `dnc-synced-dual-emit.test.ts`, which
// the comment above names, is deleted by B8 (no DNC set, no `agency_dnc_synced`).
// ---------------------------------------------------------------------------

const { observableCallbacks, createdGauges } = vi.hoisted(() => ({
  observableCallbacks: new Map<string, (result: { observe: (v: number, a?: unknown) => void }) => void>(),
  createdGauges: [] as string[],
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
      createUpDownCounter: () => ({ add: vi.fn() }),
      createObservableGauge: (name: string) => {
        createdGauges.push(name);
        return {
          addCallback: (cb: (result: { observe: (v: number, a?: unknown) => void }) => void) => {
            observableCallbacks.set(name, cb);
          },
        };
      },
    }),
  },
}));

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { pool } = vi.hoisted(() => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('@magick-agency/db', () => ({ getPool: () => pool }));

const { publishAbandonmentMetrics, resetAbandonmentMetricsState } =
  await import('../../../src/agency/abandonment-metrics.js');
const { setAgencyAbandonmentWindow } = await import('@magick-agency/observability/metrics/agency');
type AgencyAbandonmentWindowRow =
  import('@magick-agency/domain/abandonment-predicate').AgencyAbandonmentWindowRow;

const RATE = 'agency_abandonment_rate_24h';
const ANSWERED = 'agency_abandonment_window_answered_24h';
const ABANDONED = 'agency_abandonment_window_abandoned_24h';

/** Drive one OTLP collection of `name` and return what it reported. */
function collect(name: string): Array<{ value: number; attrs: unknown }> {
  const cb = observableCallbacks.get(name);
  if (!cb) throw new Error(`${name} registered no observable callback`);
  const observed: Array<{ value: number; attrs: unknown }> = [];
  cb({ observe: (value, attrs) => { observed.push({ value, attrs }); } });
  return observed;
}

/** A window row as `window24h()` returns it, counts already parsed to numbers. */
function row(over: Partial<AgencyAbandonmentWindowRow> = {}): AgencyAbandonmentWindowRow {
  // Typed, not `as never`. The cast was assignable to everything, so a field
  // `publishAbandonmentMetrics` starts reading would silently arrive `undefined`
  // with no compile error — the fixture would lie and nothing would say so.
  return {
    tenant_id: 't1', campaign_id: 'camp-1', answered: 100, abandoned: 3,
    status: 'running', ceiling_pct: 3, ...over,
  } as AgencyAbandonmentWindowRow;
}

beforeEach(() => {
  resetAbandonmentMetricsState();
});

describe('86d44par2 · the compliance gauges reach the OTLP pipeline', () => {
  it('registers exactly one observable gauge under each name', () => {
    // One instrument per series feeds both pipelines, so one dashboard query works
    // against either and an existing :9090-based panel keeps meaning what it meant.
    for (const name of [RATE, ANSWERED, ABANDONED]) {
      expect(createdGauges.filter((n) => n === name), `${name} is not one OTel gauge`).toHaveLength(1);
    }
  });

  it('exports the rate and BOTH of its terms, not just the ratio', () => {
    // The three-series split is the point of `AD-P2-C-06`: a bare rate cannot
    // tell 1-abandoned-of-1 from 30-of-3000, and the auto-pause reads this.
    // Exporting only the ratio to OTLP would reintroduce that collapse on the
    // one pipeline the alerts are built on.
    publishAbandonmentMetrics([row()]);

    const attrs = { tenant_id: 't1', campaign_id: 'camp-1' };
    expect(collect(RATE)).toEqual([{ value: 3, attrs }]);
    expect(collect(ANSWERED)).toEqual([{ value: 100, attrs }]);
    expect(collect(ABANDONED)).toEqual([{ value: 3, attrs }]);
  });

  it('labels every sample by tenant AND campaign', () => {
    // The regulatory unit is the campaign. A sample without `campaign_id` cannot
    // be cross-checked against the per-campaign SQL or consumed by the guardrail.
    publishAbandonmentMetrics([row()]);
    for (const name of [RATE, ANSWERED, ABANDONED]) {
      const [sample] = collect(name);
      expect(Object.keys(sample!.attrs as object).sort()).toEqual(['campaign_id', 'tenant_id']);
    }
  });

  it('re-reports the whole window on every collection, with no collection-time mutation', () => {
    // OTel observables are pull-based and a gauge is a statement about *now*, so a
    // campaign that stopped changing must still be reported or its series goes
    // stale. The load-bearing half is the SECOND collection: unlike the DNC
    // callback, which prunes its own map as it observes, these callbacks must be
    // side-effect free, or the first scrape after a refresh would empty the
    // window and every subsequent one would report nothing.
    publishAbandonmentMetrics([row(), row({ campaign_id: 'camp-2', answered: 50, abandoned: 1 })]);

    const first = collect(RATE);
    const second = collect(RATE);
    const third = collect(RATE);
    expect(first).toHaveLength(2);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('exports nothing at all once every campaign leaves the window', () => {
    // The widest prune case, and the one where a merge-instead-of-replace bug is
    // most visible: N campaigns to zero.
    publishAbandonmentMetrics([row(), row({ campaign_id: 'camp-2' })]);
    expect(collect(RATE)).toHaveLength(2);

    publishAbandonmentMetrics([]);

    for (const name of [RATE, ANSWERED, ABANDONED]) {
      expect(collect(name), `${name} still reported a departed campaign`).toEqual([]);
    }
  });

  it('OMITS a campaign with no answered calls rather than exporting 0%', () => {
    // The distinction this whole feature turns on: "nothing answered yet" and
    // "0% abandoned" are different answers, and an alert rule can only tell them
    // apart if we decline to invent the second. An observable callback that
    // reported `0` here would be the more dangerous half of the pair, because
    // 0% is the *reassuring* value.
    publishAbandonmentMetrics([row({ answered: 0, abandoned: 0 })]);

    expect(collect(RATE)).toEqual([]);
    // The terms still export — they are the evidence that the rate is absent
    // because nothing was answered, not because the exporter is broken.
    expect(collect(ANSWERED)).toEqual([{ value: 0, attrs: { tenant_id: 't1', campaign_id: 'camp-1' } }]);
  });

  it('stops reporting a campaign that ages out of the 24h window', () => {
    // prom-client needed `publishedLabels` bookkeeping to achieve this because it
    // retained every label set forever. The gauges get it structurally from the
    // whole-array replace — this asserts the structure actually holds, since a
    // backing map that were merged rather than replaced would keep serving the
    // departed campaign's last rate for the life of the replica.
    publishAbandonmentMetrics([row(), row({ campaign_id: 'camp-2' })]);
    expect(collect(RATE)).toHaveLength(2);

    publishAbandonmentMetrics([row()]);

    expect(collect(RATE)).toEqual([{ value: 3, attrs: { tenant_id: 't1', campaign_id: 'camp-1' } }]);
    expect(collect(ANSWERED).map((s) => (s.attrs as { campaign_id: string }).campaign_id)).toEqual(['camp-1']);
  });

  it('clears a previously-published rate when the campaign falls back to no answers', () => {
    // The second-pass half of the absent-not-zero rule. Without it a campaign
    // whose rate was publishable and then became null keeps answering with the
    // old number — the same confusion, only harder to spot.
    publishAbandonmentMetrics([row()]);
    expect(collect(RATE)).toHaveLength(1);

    publishAbandonmentMetrics([row({ answered: 0, abandoned: 0 })]);

    expect(collect(RATE)).toEqual([]);
  });

  it('STOPS exporting once the window goes stale, rather than asserting old compliance', () => {
    // The failure this guards is the reassuring one, which is why it matters most.
    // `publishAbandonmentMetrics` is only reached after `window24h()` succeeds, so
    // if that query starts failing the refresh loop logs and returns — and without
    // an expiry these gauges would keep exporting the last good snapshot forever.
    // A campaign that has since climbed past its ceiling would go on reporting
    // 3%, the guardrail would be silent, and nothing would distinguish it from a
    // healthy quiet system. `no_data` is a state an alert can fire on.
    vi.useFakeTimers();
    try {
      publishAbandonmentMetrics([row()]);
      expect(collect(RATE)).toHaveLength(1);

      // Well inside the window: an ordinary blip must not blank the series.
      vi.advanceTimersByTime(10 * 60_000);
      expect(collect(RATE), 'a short refresh gap should not drop the window').toHaveLength(1);

      // Now past it.
      vi.advanceTimersByTime(15 * 60_000);
      for (const name of [RATE, ANSWERED, ABANDONED]) {
        expect(collect(name), `${name} kept exporting a stale window`).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('a fresh publish revives a window that had gone stale', () => {
    // The expiry must not latch: a recovered query has to bring the series back
    // without a restart, or the guard trades one silence for another.
    vi.useFakeTimers();
    try {
      publishAbandonmentMetrics([row()]);
      vi.advanceTimersByTime(25 * 60_000);
      expect(collect(RATE)).toEqual([]);

      publishAbandonmentMetrics([row()]);

      expect(collect(RATE)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not alias the caller\'s array', () => {
    // `readonly` constrains our view, not the caller's handle. This module is the
    // most widely imported in the repo, so a future caller that retains and
    // mutates its array would corrupt the exported compliance window silently.
    const mutable = [{ tenant_id: 't1', campaign_id: 'camp-1', answered: 100, abandoned: 3, ratePct: 3 }];
    setAgencyAbandonmentWindow(mutable);
    mutable.push({ tenant_id: 't1', campaign_id: 'INJECTED', answered: 1, abandoned: 1, ratePct: 100 });

    expect(collect(RATE).map((s) => (s.attrs as { campaign_id: string }).campaign_id)).toEqual(['camp-1']);
  });
});
