// trackTtsClipCacheSweep lives in @magick-agency/observability/metrics/voice.
// There is no latch reset: safeEmit is private to voice.ts and exports none; the
// latch only de-duplicates the error LOG, which no case asserts.
import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The on-disk clip cache's metrics.
 *
 * The resource that overflows is the PER-NODE cache across many requests, and
 * before these existed the only evidence of it was log archaeology — which is
 * how the original incident was found. The one that has to work is
 * `tts_clip_cache_liveness_failures_total`: a failed liveness lookup skips clip
 * eviction for the whole cycle, so a query that times out every cycle turns
 * `cacheMaxBytes` into no cap at all.
 */

const otel = vi.hoisted(() => ({
  counters: new Map<string, { add: ReturnType<typeof vi.fn> }>(),
  gaugeCallbacks: new Map<string, (result: { observe: (v: number) => void }) => void>(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: (name: string) => {
        const c = { add: vi.fn() };
        otel.counters.set(name, c);
        return c;
      },
      createUpDownCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
      createObservableGauge: (name: string) => ({
        addCallback: (cb: (result: { observe: (v: number) => void }) => void) => {
          otel.gaugeCallbacks.set(name, cb);
        },
      }),
    }),
  },
}));

const { trackTtsClipCacheSweep } = await import('@magick-agency/observability/metrics/voice');

const otelRetained = () => otel.counters.get('tts_clip_cache_retained_total')!;
const otelFailures = () => otel.counters.get('tts_clip_cache_liveness_failures_total')!;

/** Drive the observable gauge's callback and report what it observed. */
function observeOtelBytes(): number[] {
  const seen: number[] = [];
  otel.gaugeCallbacks.get('tts_clip_cache_bytes')!({ observe: (v: number) => seen.push(v) });
  return seen;
}

describe('trackTtsClipCacheSweep', () => {
  beforeEach(() => {
    otelRetained().add.mockReset();
    otelFailures().add.mockReset();
  });

  it('reports nothing for the gauge before the first sweep — "not measured yet" is not "empty"', () => {
    expect(observeOtelBytes()).toEqual([]);
  });

  it('publishes the sweep measurements', () => {
    trackTtsClipCacheSweep({ cacheBytes: 12_345, retained: 3, livenessFailed: false });

    expect(otelRetained().add.mock.calls).toEqual([[3]]);
    expect(observeOtelBytes()).toEqual([12_345]);
  });

  it('counts a liveness failure once', () => {
    trackTtsClipCacheSweep({ cacheBytes: 100, retained: 2, livenessFailed: true });

    expect(otelFailures().add.mock.calls).toEqual([[1]]);
  });

  // Counters take per-sweep DELTAS. A healthy sweep must not emit a zero
  // increment — `rate()` over a series that ticks every hour with 0 is
  // indistinguishable from one that never ticks, and it wastes a sample.
  it('does not increment the counters on a clean sweep', () => {
    trackTtsClipCacheSweep({ cacheBytes: 999, retained: 0, livenessFailed: false });

    expect(observeOtelBytes()).toEqual([999]);
    expect(otelRetained().add).not.toHaveBeenCalled();
    expect(otelFailures().add).not.toHaveBeenCalled();
  });

  it('reports an empty cache as 0 rather than skipping the gauge', () => {
    trackTtsClipCacheSweep({ cacheBytes: 0, retained: 0, livenessFailed: false });

    expect(observeOtelBytes()).toEqual([0]);
  });

  // One guard per counter: `tts_clip_cache_liveness_failures_total` is the one to
  // alert on, so a fault on the retained counter must not cost it — and nothing
  // may throw into the sweeper.
  it('still counts the liveness failure when the retained counter throws, and never throws', () => {
    otelRetained().add.mockImplementationOnce(() => { throw new Error('otel down'); });

    expect(() => trackTtsClipCacheSweep({ cacheBytes: 777, retained: 1, livenessFailed: true }))
      .not.toThrow();

    expect(otelFailures().add).toHaveBeenCalledWith(1);
    expect(observeOtelBytes()).toEqual([777]);
  });

  it('still counts retained clips when the liveness counter throws', () => {
    otelFailures().add.mockImplementationOnce(() => { throw new Error('otel down'); });

    expect(() => trackTtsClipCacheSweep({ cacheBytes: 5, retained: 1, livenessFailed: true }))
      .not.toThrow();
    expect(otelRetained().add).toHaveBeenCalledWith(1);
    expect(observeOtelBytes()).toEqual([5]);
  });
});
