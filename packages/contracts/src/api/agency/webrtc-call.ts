/**
 * Types for the WebRTC browser dialer (human → PSTN softphone).
 *
 * The WebRTC human-calling feature (served through the public API layer's
 * `/proxy/webrtc-call/*`). Some response shapes are not fully pinned, so the API
 * layer normalizes defensively — see `src/api/webrtc-call.ts`.
 */

// The dialer's summary payload is the SAME `CallAnalysisResult` an AI call
// produces (the dialer runtime reuses the type unchanged), so the detail page can hand it to
// the shared `AnalysisSection` with no adaptation.
// `CallAnalysisResult` lives in `./shared`.
import type { CallAnalysisResult } from './shared';

// Only the parts an agency campaign call shows are declared here — the persisted
// call record, its analysis lifecycle, transcript and recording outcome, as served
// inside `AgencyAttemptCallDetail` (`./attempt-call`). The softphone surface does
// not exist: the live-dialer lifecycle (`WebRtcCallStatus`, `TERMINAL_WEBRTC_STATUSES`,
// `KNOWN_WEBRTC_STATUSES`), carrier choice (`WebRtcTelephonyProvider`,
// `WEBRTC_TELEPHONY_PROVIDERS` — VoBiz is out, VoiceLink is the only carrier),
// the caller-ID picker (`WebRtcCallerId`, incl. BYOC `is_byoc` — BYOC is out of scope too, and
// the agency caller-ID list, `GET /phone-numbers`, carries no `is_byoc`), call start
// (`WebRtcCallStartInput` / `WebRtcCallStartResponse`) and the softphone call
// history list (`WebRtcCallsListResponse`, `WebRtcCallListFilters`) are not declared.

/**
 * Persisted/historical status of a WebRTC call record (call history), as stored
 * on the `webrtc_calls` row by the dialer runtime. This is a DIFFERENT concept from the live
 * dialer's `WebRtcCallStatus` lifecycle above — these are the terminal/durable
 * states the record settles into.
 *
 * Sourced from the CHECK constraint `ck_webrtc_status` in the dialer runtime migration
 * `047_webrtc_calls.sql`:
 *   initiating | ringing | in_progress | completed | failed | no_answer | busy | canceled
 *
 * The trailing `(string & {})` keeps the literal autocomplete while tolerating
 * any future status the dialer runtime may add without a type break.
 */
export type WebRtcCallRecordStatus =
  | 'initiating'
  | 'ringing'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'no_answer'
  | 'busy'
  | 'canceled'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/**
 * Lifecycle of the post-call summary for a dialer call. Distinct from the AI
 * call's `analysis_status` in two states that only a human↔human call can hit:
 * `awaiting_recording` (the carrier hasn't delivered the file yet) and `expired`
 * (it never did). `deleted` is the DSAR erasure terminal state.
 *
 * Mirrors the dialer runtime's `DialerAnalysisStatus` (`webrtc-call.model.ts`).
 */
export type DialerAnalysisStatus =
  | 'awaiting_recording'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'expired'
  | 'deleted';

/**
 * The overall-sentiment vocabulary the dialer runtime emits. Scalar form of the sentiment
 * `label` buried in the `call_analysis` blob — surfaced flat on the LIST row as
 * `analysis_sentiment_label` (see below) so the list can render sentiment
 * without the detail-only blob it deliberately excludes.
 */
export type SentimentLabel = 'positive' | 'negative' | 'mixed' | 'neutral';

/** Human↔human speaker roles. NOT the AI call's `assistant`/`user`. */
export type DialerSpeakerRole = 'agent' | 'customer' | 'unknown';

/** One transcribed turn of a dialer call. */
export interface DialerTranscriptEntry {
  role: DialerSpeakerRole;
  content: string;
  /**
   * Seconds from the START OF THE RECORDING — exactly what an <audio> element
   * reports — which is what makes transcript↔playback sync a direct comparison
   * here (the AI page has to infer offsets from wall-clock timestamps).
   *
   * Best-effort: these come from an LLM and can drift or go non-monotonic across
   * transcription-window seams, so consumers must tolerate bad values.
   */
  start_seconds?: number;
  end_seconds?: number;
  language?: string;
  confidence?: number;
}

/**
 * The result of asking for a recording, and *why* when there is nothing to play.
 *
 * One `null` for every failure was the previous shape, and it collapsed four
 * different sentences into "Recording not available." — an entitlement refusal, a
 * call that aged out, a call that was never recorded, and a carrier we could not
 * reach. The public API layer goes to specific trouble to forward the dialer runtime's `call_purged`,
 * `call_never_placed` and `no_recording` codes unmasked (four allow-list entries
 * in its `error-mask.middleware.ts`) precisely so this distinction can be made,
 * and the central claim is that *"the call is no longer available" must be
 * distinguishable from an error.* This union is that work's consumer.
 */
export type RecordingOutcome =
  | { status: 'ready'; url: string; mimeType: string | null }
  /** The call aged out of retention — the dialer runtime's `call_purged` / `call_never_placed`. */
  | { status: 'purged' }
  /** The call is there and simply carries no recording — the dialer runtime's `no_recording`. */
  | { status: 'not_recorded' }
  /** The tenant may not hear it — the public API layer 403s the media route on its capability. */
  | { status: 'forbidden' }
  /** We could not reach the carrier that stores it — a 5xx from either tier. */
  | { status: 'unreachable' };

/** Provenance of the transcription pass that produced `conversation_log`. */
export interface TranscriptMeta {
  provider: 'gemini' | 'sarvam';
  model: string;
  detected_language: string;
  duration_seconds: number;
  turn_count: number;
  latency_ms: number;
  transcribed_at: string;
  /**
   * True when diarization was unavailable and every turn is `unknown`. The UI
   * renders turns UNATTRIBUTED in that case — a column of "Unknown" is worse
   * than no labels at all.
   */
  diarization_failed?: boolean;
  source_url?: string;
}

/**
 * A persisted WebRTC call record as returned by
 * `GET /proxy/webrtc-call` (list) and `GET /proxy/webrtc-call/:id` (detail).
 * Mirrors the dialer runtime's `webrtc_calls` row shape exactly (see migration 047/048).
 *
 * NOTE the list/detail split: the LIST endpoint returns `analysis_status` only —
 * the three JSONB blobs (`call_analysis`, `conversation_log`, `transcript_meta`)
 * are excluded from `WEBRTC_LIST_COLUMNS` to keep the list query light. They are
 * therefore optional here and present only on the detail response.
 */
export interface WebRtcCallRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  caller_id: string;
  destination_phone: string;
  provider: string;
  provider_call_id: string | null;
  /** Persisted record status — see `WebRtcCallRecordStatus`. */
  status: WebRtcCallRecordStatus;
  outcome: string | null;
  error_code: string | null;
  error_message: string | null;
  initiated_by: string | null;
  metadata: Record<string, unknown> | null;
  recording_requested: boolean;
  /** Already a proxy path (never the raw VoBiz URL); null when no recording. */
  recording_url: string | null;
  recording_duration_seconds: number | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  /** Answer-anchored talk time (what billing rounds to minutes); 0 if unanswered. */
  talk_time_seconds: number | null;
  // ── Post-call summary (dialer call analysis) ──
  /** Which profile this call was summarized with; null when none applied. */
  analysis_profile_id?: string | null;
  /** Summary lifecycle. Absent/null on calls placed before the feature existed. */
  analysis_status?: DialerAnalysisStatus | null;
  /**
   * List-safe scalar sentiment. The dialer runtime extracts the overall-sentiment `label` out
   * of the detail-only `call_analysis` JSONB server-side and returns it flat on
   * the LIST response, so the calls list can render sentiment WITHOUT the blob
   * (which `WEBRTC_LIST_COLUMNS` excludes). Null until the summary completes /
   * when no sentiment applies.
   */
  analysis_sentiment_label?: SentimentLabel | null;
  /** Detail-only. Same `CallAnalysisResult` shape AI calls use. */
  call_analysis?: CallAnalysisResult | null;
  /** Detail-only. The diarized transcript. */
  conversation_log?: DialerTranscriptEntry[] | null;
  /** Detail-only. Transcription provenance. */
  transcript_meta?: TranscriptMeta | null;
  created_at: string;
  updated_at: string;
}
