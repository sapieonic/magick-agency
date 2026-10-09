/**
 * Metric declarations owned by the dialer call analysis.
 *
 * `dialer_analysis_settlement_pending_age_seconds` and its setter are deliberately
 * absent — there is no settlement step.
 */
import { meter } from '../meter.js';
import { counter, gauge, histogram } from '../metric-instruments.js';

// ── Dialer call analysis metrics (transcription + analysis of dialer calls) ──
// The runner/worker import these; the gauge is fed via a module-level setter so a
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
