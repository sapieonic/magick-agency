/**
 * Pins the two things that stand between the release path and a working alert.
 *
 * The metric reaches Prometheus/OTLP through a registration seam
 * (`setTelephonyReleaseObserver`) wired in `src/index.ts`, not through an import
 * in `telephony-release.ts` — see that file for why. That makes the flagship
 * `telephony_lease_release_total{outcome=~"failure|partial"}` alert depend on ONE line of
 * startup code that nothing else executes: the smoke test builds its own Fastify
 * instance rather than running `main()`. Delete that line and every suite stays
 * green while the alert silently never fires again.
 *
 * A metric registered on one exporter only is the same shape of failure: the
 * flagship alert could never have fired.
 *
 * - Case 1 audits the boot wiring in `src/bootstrap/voice.ts` (`startVoice`),
 *   with the import specifier it uses.
 * - Case 2 asserts the observer signature accepts the real counter and that
 *   forwarding emits the labelled `telephony_lease_release_total` series, through
 *   a global meter provider installed before the metric module creates its
 *   instruments (there is no OTel SDK dependency to read it back with).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A recording meter provider, installed before `metrics/voice.ts` creates its
// instruments (the OTel metrics API binds `getMeter` at call time, no proxy).
const { recorded } = await vi.hoisted(async () => {
  const { metrics } = await import('@opentelemetry/api');
  const recorded = new Map<string, Array<{ value: number; attributes: unknown }>>();
  const instrument = (name: string) => {
    const points: Array<{ value: number; attributes: unknown }> = [];
    recorded.set(name, points);
    return {
      add: (value: number, attributes?: unknown) => { points.push({ value, attributes }); },
      record: (value: number, attributes?: unknown) => { points.push({ value, attributes }); },
      addCallback: () => {},
    };
  };
  const meter = {
    createCounter: instrument,
    createUpDownCounter: instrument,
    createHistogram: instrument,
    createGauge: instrument,
    createObservableGauge: instrument,
    createObservableCounter: instrument,
    createObservableUpDownCounter: instrument,
    addBatchObservableCallback: () => {},
    removeBatchObservableCallback: () => {},
  };
  metrics.setGlobalMeterProvider({ getMeter: () => meter } as never);
  return { recorded };
});
import { trackTelephonyLeaseRelease } from '@magick-agency/observability/metrics/voice';
import { setTelephonyReleaseObserver } from '../../../src/core/telephony-release.js';

describe('telephony lease-release metric wiring', () => {
  it('src/bootstrap/voice.ts registers the real counter as the release observer', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/bootstrap/voice.ts'), 'utf8');

    expect(src).toContain("from '../core/telephony-release.js'");
    expect(src).toMatch(/setTelephonyReleaseObserver\(\s*trackTelephonyLeaseRelease\s*\)/);
  });

  it('the seam accepts the real counter and forwarding it emits a labelled series', async () => {
    // Proves the observer signature and the counter agree, and that the counter
    // actually produces the series the alert queries. No test called the real
    // emitter before this one.
    setTelephonyReleaseObserver(trackTelephonyLeaseRelease);
    try {
      trackTelephonyLeaseRelease('failure', 'session_end');
      trackTelephonyLeaseRelease('composite', 'webhook_static_status');

      const points = recorded.get('telephony_lease_release_total');
      expect(points).toBeDefined();
      expect(points).toContainEqual({ value: 1, attributes: { outcome: 'failure', source: 'session_end' } });
      expect(points).toContainEqual({ value: 1, attributes: { outcome: 'composite', source: 'webhook_static_status' } });
    } finally {
      setTelephonyReleaseObserver(null);
    }
  });
});
