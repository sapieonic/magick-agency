// There is no settlement step: the job record carries no settlement status or
// `settlement_*` fields, and the baseline has no such columns.

// ─── Dialer Analysis Jobs ───────────────────────────────────────────────
//
// The durable job that carries a dialer call from "recording will arrive later"
// through transcription + analysis. Unlike AI-call analysis
// (the transcript is in hand at call end), this depends on an external artifact —
// the recording — that lands asynchronously via a webhook, so the work needs a
// claim/heartbeat lifecycle, a recovery sweep, terminal-failure states.

import type { AnalyticsDimension } from './prompt.model.js';

/** Analysis lifecycle states. Terminal for analysis: completed, skipped, expired, failed. */
export type DialerAnalysisJobStatus =
  | 'awaiting_recording'
  | 'queued'
  | 'transcribing'
  | 'analyzing'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'expired';

/**
 * The resolved profile, snapshotted at enqueue (M1). The job never re-reads a
 * live profile — a copy-on-write PUT (which deactivates the old row) or a DELETE
 * mid-flight can neither change nor break what this job measures, and a retry
 * months later still analyses against the profile as it was at call time.
 */
export interface DialerAnalysisProfileSnapshot {
  context?: string | null;
  custom_dimensions: AnalyticsDimension[];
  language_hint?: string | null;
}

export interface DialerAnalysisJobRecord {
  id: string;
  call_id: string;
  tenant_id: string;
  account_id: string;
  /** Provenance only — may reference a deactivated/deleted profile. */
  profile_id: string | null;
  profile_snapshot: DialerAnalysisProfileSnapshot | null;
  /** Snapshotted transcription language hint (per-call override wins over profile). */
  analysis_language: string | null;
  status: DialerAnalysisJobStatus;
  /** Provider calls actually spent (infra churn does not increment this). */
  attempts: number;
  /** Lifetime cap incl. manual retries — never reset. */
  attempts_total: number;
  /** Claim fence: a recovered job gets a new generation; stale writes are rejected. */
  claim_generation: number;
  claimed_at: Date | null;
  heartbeat_at: Date | null;
  next_attempt_at: Date | null;
  analysis_audio_seconds: number | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Enqueue input. The status is NOT chosen by the caller — it is derived in-SQL
 * from whether `agency_calls.recording_url` is already present (queued) or not
 * (awaiting_recording), read from the DB so a lost session-state wake can't hide
 * an already-delivered recording (B1).
 */
export interface EnqueueDialerAnalysisJobInput {
  call_id: string;
  profile_id?: string | null;
  profile_snapshot?: DialerAnalysisProfileSnapshot | null;
  analysis_language?: string | null;
}

/** Terminal failure/skip reasons carried in `error_code`. */
export type DialerAnalysisErrorCode =
  | 'RECORDING_NEVER_ARRIVED'
  | 'SYSTEM_REBOOTED'
  | 'TRANSCRIPTION_EMPTY'
  | 'TRANSCRIPTION_FAILED'
  | string;
