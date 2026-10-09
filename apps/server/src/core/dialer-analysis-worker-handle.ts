/**
 * Indirection to the dialer-analysis worker without a hard import dependency.
 *
 * Call sites that want to nudge the worker (the bridge's analysis hooks, on call
 * finalisation and on recording-ready) reach it through {@link getDialerAnalysisWorker}
 * instead of importing `src/core/dialer-analysis-worker.ts`. It returns `null` until
 * `initDialerAnalysisWorker` calls {@link setDialerAnalysisWorker} at startup, and
 * again after shutdown. A `null` return simply means "no worker to wake right now" —
 * the worker's own poll loop still picks the job up.
 */
export interface DialerAnalysisWorkerHandle {
  wake(): void;
}

let workerInstance: DialerAnalysisWorkerHandle | null = null;

/** Register the worker so wake-on-demand callers can reach it. Called once at startup. */
export function setDialerAnalysisWorker(worker: DialerAnalysisWorkerHandle | null): void {
  workerInstance = worker;
}

/** The registered worker, or null when it hasn't been wired up yet. */
export function getDialerAnalysisWorker(): DialerAnalysisWorkerHandle | null {
  return workerInstance;
}
