// ─── WebRTC Human Calls ─────────────────────────────────────────────
//
// A browser→PSTN human bridge call.
// No AI pipeline; the browser leg and the VoBiz leg are relayed directly.
//
// The table is `agency_calls` (the baseline's rename of `webrtc_calls`); the
// WebRtc* type names are kept so the bridge and the runtime import them
// (docs/seams.md). `telephony_credential_id` (BYOC) and `sip_connection_id`
// (SIP) are dropped from the record and the create input, as the baseline
// dropped the columns.

import type { CallAnalysisResult } from './call.model.js';

export type WebRtcCallStatus =
  | 'initiating'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'busy'
  | 'canceled';

/** Statuses a call may still be live in (used by the stale-call sweep). */
export const WEBRTC_NON_TERMINAL_STATUSES: readonly WebRtcCallStatus[] = [
  'initiating',
  'ringing',
  'in_progress',
];

// ─── Dialer post-call analysis ──────────────────────────────────────────
//
// The dialer call is transcribed from its recording, then analysed by the same
// (call-type-agnostic) post-call analysis service AI calls use. These types are
// the persisted, human↔human-flavoured shapes; the durable job that produces
// them lives in dialer-analysis-job.model.ts.

/**
 * Read-convenience mirror of the job status, collapsed to the vocabulary the console
 * already knows plus dialer-specific states. `deleted` is the DSAR erasure state
 * — the transcript/analysis have been nulled on a data-subject request.
 */
export type DialerAnalysisStatus =
  | 'awaiting_recording'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'expired'
  | 'deleted';

/** Human↔human roles. NOT the AI call's assistant/user. */
export type DialerSpeakerRole = 'agent' | 'customer' | 'unknown';

export interface DialerTranscriptEntry {
  role: DialerSpeakerRole;
  content: string;
  /** Seconds from recording start — enables transcript↔playback sync. */
  start_seconds?: number;
  end_seconds?: number;
  language?: string;
  confidence?: number;
}

export interface TranscriptMeta {
  provider: 'gemini' | 'sarvam';
  model: string;
  detected_language: string;
  duration_seconds: number;
  turn_count: number;
  latency_ms: number;
  transcribed_at: string;
  /** The recording URL the job actually consumed (M16) — diagnoses a mid-run swap. */
  source_url?: string;
  /** True when diarization was unavailable and all turns are 'unknown'. */
  diarization_failed?: boolean;
}

export interface WebRtcCallRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  /** The allocated DID used as the outbound caller ID (from). */
  caller_id: string;
  /** The dialed PSTN number (to), E.164. */
  destination_phone: string;
  provider: string;
  provider_call_id: string | null;
  status: WebRtcCallStatus;
  outcome: string | null;
  error_code: string | null;
  error_message: string | null;
  initiated_by: string | null;
  metadata: Record<string, unknown>;
  /** Whether recording was requested at dial time (the per-call `record` opt-in). */
  recording_requested: boolean;
  /** Finalized recording URL, persisted from the VoBiz recording callback. */
  recording_url: string | null;
  recording_duration_seconds: number | null;
  answered_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  /** Answer-anchored talk time — what billing rounds to minutes. */
  talk_time_seconds: number | null;
  // ── Post-call analysis (migration 059) ──
  /** Provenance of the analysis dimensions used (immutable after insert). */
  analysis_profile_id: string | null;
  /** Per-call transcription language override (immutable after insert). */
  analysis_language: string | null;
  analysis_status: DialerAnalysisStatus | null;
  /** Same type as AI calls — the analysis service is call-type-agnostic. */
  call_analysis: CallAnalysisResult | null;
  conversation_log: DialerTranscriptEntry[] | null;
  transcript_meta: TranscriptMeta | null;
  /**
   * List-only projected scalar: the overall sentiment label extracted in SQL from
   * `call_analysis` (WEBRTC_LIST_COLUMNS) so the list Sentiment column renders
   * without the blob. Absent on the detail path (which returns the full blob).
   */
  analysis_sentiment_label?: string | null;
  /** Durable consent record (immutable after insert). */
  analysis_consent: boolean | null;
  analysis_consent_at: Date | null;
  // ── Agency dialer back-references (migration 076) ──
  /**
   * The agency campaign this media leg was placed for; NULL for an ordinary
   * browser dialer call. Correlation only — no FK, and its *presence* is what
   * selects the agency billing rate over the per-minute `webrtc_call` one.
   */
  campaign_id: string | null;
  /** The `agency_call_attempts.id` this leg belongs to. Correlation only, no FK. */
  agency_attempt_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateWebRtcCallInput {
  tenant_id: string;
  account_id: string;
  caller_id: string;
  destination_phone: string;
  provider?: string;
  initiated_by?: string | null;
  metadata?: Record<string, unknown>;
  recording_requested?: boolean;
  // ── Immutable analysis fields, set at intake ──
  analysis_profile_id?: string | null;
  analysis_language?: string | null;
  analysis_consent?: boolean | null;
  analysis_consent_at?: Date | null;
  // ── Agency dialer back-references, set at intake and immutable after ──
  campaign_id?: string | null;
  agency_attempt_id?: string | null;
}

export interface UpdateWebRtcCallInput {
  provider_call_id?: string | null;
  status?: WebRtcCallStatus;
  outcome?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  recording_url?: string | null;
  recording_duration_seconds?: number | null;
  answered_at?: Date | null;
  ended_at?: Date | null;
  duration_seconds?: number | null;
  talk_time_seconds?: number | null;
  // ── Mutable analysis columns (the runner writes these; blobs are JSON-serialized) ──
  analysis_status?: DialerAnalysisStatus | null;
  call_analysis?: CallAnalysisResult | null;
  conversation_log?: DialerTranscriptEntry[] | null;
  transcript_meta?: TranscriptMeta | null;
}
