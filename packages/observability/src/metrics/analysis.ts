/**
 * Metric declarations owned by the dialer call analysis.
 *
 * `dialer_analysis_settlement_pending_age_seconds` and its setter are deliberately
 * absent — there is no settlement step.
 */
import { meter } from '../meter.js';
import { counter, gauge, histogram } from '../metric-instruments.js';

// ── Dialer call analysis metrics (transcription + analysis of dialer calls) ──
// The runner/worker import these; the gauges are fed via module-level setters so a
// periodic sweep can publish the DB-derived value. (A
// `dialer_analysis_recording_wait_seconds` histogram used to sit here too; it was
// never observed anywhere and was removed — re-add it only with an emission site.)

export const dialerAnalysisTotal = counter<'tenant_id' | 'status' | 'transcriber'>(meter, 'dialer_analysis_total', {
  description: 'Total dialer-call analyses by terminal status',
});

export const dialerAnalysisDurationSeconds = histogram<
  'transcriber' | 'stage'
>(meter, 'dialer_analysis_duration_seconds', {
  description: 'Dialer analysis stage duration in seconds (fetch|transcribe|analyze)',
  unit: 's',
  buckets: [1, 5, 10, 30, 60, 120, 300],
});

export const dialerTranscriptionAudioSeconds = histogram<'transcriber'>(meter, 'dialer_transcription_audio_seconds', {
  description: 'Length of audio transcribed per dialer analysis (cost proxy)',
  unit: 's',
  buckets: [30, 60, 120, 300, 600, 1800, 3600],
});

// Queue depth per job status — a wedged-worker signal. Fed by a periodic sweep
// via setDialerAnalysisQueueDepth.
const dialerAnalysisQueueDepth = gauge<'status'>(meter, 'dialer_analysis_queue_depth', {
  description: 'Dialer analysis jobs by status (backlog visibility)',
});

/** Publish the current queue depth for one job status. */
export function setDialerAnalysisQueueDepth(status: string, value: number): void {
  dialerAnalysisQueueDepth.set({ status }, value);
}

// ── The worker's slot pool (this process) ──
// Fed by the worker on every job start and finish, so they move between OTLP exports.

const dialerAnalysisInFlight = gauge(meter, 'dialer_analysis_in_flight', {
  description: 'Dialer analysis jobs running in this process',
});

const dialerAnalysisSlotUtilization = gauge(meter, 'dialer_analysis_slot_utilization', {
  // No `unit: '1'`: the OTLP-to-Prometheus name would grow a `_ratio` suffix.
  description: 'Share of this process\'s analysis slots (DIALER_ANALYSIS_CONCURRENCY) in use, 0-1',
});

const dialerAnalysisMemoryReservedBytes = gauge(meter, 'dialer_analysis_memory_reserved_bytes', {
  description: 'Recording bytes reserved against DIALER_ANALYSIS_MEMORY_BUDGET_BYTES',
  unit: 'By',
});

/** Times a slot (or a recording re-fetch) had to wait for the recording byte budget. */
export const dialerAnalysisBudgetWaitsTotal = counter(meter, 'dialer_analysis_budget_waits_total', {
  description: 'Times an analysis slot waited for the recording byte budget',
});

/** Times the worker paused claiming because an AI vendor rate-limited it. */
export const dialerAnalysisRateLimitPausesTotal = counter(meter, 'dialer_analysis_rate_limit_pauses_total', {
  description: 'Times the analysis worker paused claiming after a vendor rate limit',
});

/** Publish the slot pool: jobs in flight out of `slots`. */
export function setDialerAnalysisSlots(inFlight: number, slots: number): void {
  dialerAnalysisInFlight.set(inFlight);
  dialerAnalysisSlotUtilization.set(slots > 0 ? inFlight / slots : 0);
}

/** Publish the recording bytes currently reserved. */
export function setDialerAnalysisMemoryReserved(bytes: number): void {
  dialerAnalysisMemoryReservedBytes.set(bytes);
}
