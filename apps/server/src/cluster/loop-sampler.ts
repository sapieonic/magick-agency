/**
 * Event-loop utilisation and p99 delay since the previous sample, for a child's
 * `health.ping` answer and the primary's `/readyz?detail=1`: how busy each process's loop
 * is, which is the number the media split exists to keep down (`docs/scaling.md` §0).
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface LoopSample {
  elu: number;
  loopDelayP99Ms: number;
}

export function createLoopSampler(): () => LoopSample {
  let last = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  return () => {
    const elu = performance.eventLoopUtilization(last);
    last = performance.eventLoopUtilization();
    const p99 = delay.count > 0 ? delay.percentile(99) / 1e6 : 0;
    delay.reset();
    return {
      elu: Math.min(1, Math.max(0, Number(elu.utilization.toFixed(4)) || 0)),
      loopDelayP99Ms: Number.isFinite(p99) ? Number(p99.toFixed(2)) : 0,
    };
  };
}
