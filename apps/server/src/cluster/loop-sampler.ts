/**
 * Event-loop utilisation and p99 delay over a fixed window, for a child's `health.ping`
 * answer and the primary's `/readyz?detail=1`: how busy each process's loop is, which is
 * the number the media split exists to keep down (`docs/scaling.md` §0).
 *
 * The window is closed by the sampler's own timer, never by a reader: `latest()` returns the
 * last completed window and changes nothing, so two probers (the ALB, an uptime check, an
 * operator, the load script) read the same numbers, and a stall stays visible for a whole
 * window whoever asks and however often. Before the first window closes, `latest()` reads
 * the partial window since start, also without resetting it.
 *
 * The exported gauges (`nodejs_eventloop_utilization_ratio`, `nodejs_eventloop_delay_p99_seconds`,
 * one series per process) come from the OTel runtime instrumentation, which keeps its own
 * histogram and baseline per export interval; this sampler does not feed or disturb them.
 */
import { monitorEventLoopDelay, performance, type EventLoopUtilization } from 'node:perf_hooks';

export interface LoopSample {
  elu: number;
  loopDelayP99Ms: number;
}

export interface LoopSampler {
  /** The last completed window (the partial one before the first closes). Never resets anything. */
  latest(): LoopSample;
  /** Stops the window timer and the delay histogram. Idempotent. */
  stop(): void;
}

/** The window every process samples its loop over. */
export const LOOP_SAMPLE_WINDOW_MS = 5_000;

export function createLoopSampler(opts: { windowMs?: number } = {}): LoopSampler {
  const windowMs = opts.windowMs ?? LOOP_SAMPLE_WINDOW_MS;
  // 1 ms: a coarser resolution adds itself to every sample (10 ms read ~12 ms p99 at idle).
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  let windowStart: EventLoopUtilization = performance.eventLoopUtilization();
  let completed: LoopSample | null = null;
  let stopped = false;

  const read = (): LoopSample => {
    const elu = performance.eventLoopUtilization(windowStart);
    const p99 = delay.count > 0 ? delay.percentile(99) / 1e6 : 0;
    return {
      elu: Math.min(1, Math.max(0, Number(elu.utilization.toFixed(4)) || 0)),
      loopDelayP99Ms: Number.isFinite(p99) ? Number(p99.toFixed(2)) : 0,
    };
  };

  const timer = setInterval(() => {
    completed = read();
    windowStart = performance.eventLoopUtilization();
    delay.reset();
  }, windowMs);
  // A sampler never keeps a process (or a test run) alive.
  timer.unref();

  return {
    latest: () => completed ?? read(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      delay.disable();
      // A read after stop() answers the last completed window, or the partial one as it stood.
      if (completed === null) completed = read();
    },
  };
}
