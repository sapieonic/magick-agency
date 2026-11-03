import { describe, expect, it, vi } from 'vitest';

/*
 * `agy-cluster-child-crash` reads `increase(cluster_child_exits_total{expected="false"}[10m])`
 * (docs/scaling.md §7). `increase()` over a series whose first sample is the crash is empty,
 * so a series created by its first crash hides that crash. The supervisor records both of
 * its role's series at zero when it is built; this pins that the real OTel SDK exports that
 * zero point (cumulative), before any exit, and counts the first crash on top of it.
 *
 * The SDK is installed as the global meter provider before `metrics/voice.ts` creates its
 * instruments (the metrics API binds `getMeter` at call time, with no proxy).
 */
const { reader } = await vi.hoisted(async () => {
  const { metrics } = await import('@opentelemetry/api');
  const { MeterProvider, MetricReader } = await import('@opentelemetry/sdk-metrics');
  const { buildMetricViews } = await import('../../../src/utils/otel-sdk-config.js');
  class CollectingReader extends MetricReader {
    protected async onShutdown(): Promise<void> {}
    protected async onForceFlush(): Promise<void> {}
  }
  const reader = new CollectingReader();
  metrics.setGlobalMeterProvider(new MeterProvider({ views: buildMetricViews(), readers: [reader] }));
  return { reader };
});
import { trackChildExit } from '@magick-agency/observability/metrics/voice';
import { ChildSupervisor } from '../../../src/cluster/child-supervisor.js';

async function childExitPoints(): Promise<Array<{ role: unknown; expected: unknown; value: number }>> {
  const { resourceMetrics } = await reader.collect();
  const out: Array<{ role: unknown; expected: unknown; value: number }> = [];
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const m of scope.metrics) {
      if (m.descriptor.name !== 'cluster_child_exits_total') continue;
      for (const p of m.dataPoints) out.push({ role: p.attributes['role'], expected: p.attributes['expected'], value: p.value as number });
    }
  }
  return out.sort((a, b) => `${a.role}${a.expected}`.localeCompare(`${b.role}${b.expected}`));
}

describe('cluster_child_exits_total', () => {
  it('a supervisor exports its role\'s exit series at zero before any exit, so the first crash is an increase', async () => {
    expect(await childExitPoints()).toEqual([]);
    // Built, not started: nothing is forked, and nothing has exited.
    new ChildSupervisor({ role: 'media', count: 1, fork: () => { throw new Error('not forked here'); } });
    expect(await childExitPoints()).toEqual([
      { role: 'media', expected: 'false', value: 0 },
      { role: 'media', expected: 'true', value: 0 },
    ]);
    trackChildExit('media', false);
    expect(await childExitPoints()).toEqual([
      { role: 'media', expected: 'false', value: 1 },
      { role: 'media', expected: 'true', value: 0 },
    ]);
  });
});
