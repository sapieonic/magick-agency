import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'safe-emit' });

/**
 * Components that have already logged an emission failure, so a persistent
 * metrics problem is reported once per component per process rather than once
 * per call — which matters because these paths are hottest during exactly the
 * incident that would trigger the failure.
 */
const logged = new Set<string>();

/**
 * Runs an observability side effect so it can never fail the thing it observes.
 *
 * Emission points sit on hot paths — call setup, alert dispatch — where a throw
 * from the metrics layer (a label-set mismatch, a registry error) would fail the
 * real work. That is strictly worse than losing a counter, and it is the rule the
 * analytics emitters already follow: best-effort fire-and-forget, never throw
 * into the call path.
 *
 * @param component identifies the caller in the one-time failure log, and scopes
 *        the "already logged" latch so one noisy module can't mute another.
 */
export function safeEmit(component: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (!logged.has(component)) {
      logged.add(component);
      log.error({ err, component }, 'Metric emission failed — continuing without it');
    }
  }
}

/** Test-only: clears the one-time-log latches so failure logging can be asserted. */
export function resetSafeEmitLatches(): void {
  logged.clear();
}
