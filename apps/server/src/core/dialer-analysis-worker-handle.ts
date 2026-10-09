/**
 * Indirection to the dialer-analysis worker without a hard import dependency.
 *
 * The worker itself (`src/core/dialer-analysis-worker.ts`) is built in a separate
 * task. Call sites that want to nudge it (the retry route, the recording webhook)
 * reach it through {@link getDialerAnalysisWorker} so they compile and run today,
 * before the worker module exists: it returns `null` until the worker task calls
 * {@link setDialerAnalysisWorker} at startup. A `null` return simply means "no
 * worker to wake right now" — the worker's own poll loop still picks the job up.
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
