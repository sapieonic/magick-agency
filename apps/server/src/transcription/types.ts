import type { DialerSpeakerRole, DialerTranscriptEntry } from '@magick-agency/db/models/agency-call.model';

/**
 * The transcription seam. A dialer call has no live STT — the
 * recording is transcribed after the fact into `DialerTranscriptEntry[]`, which
 * the (unchanged, call-type-agnostic) `PostCallAnalysisService` then analyses.
 *
 * The interface is deliberately provider-agnostic so `DIALER_TRANSCRIBER` can be
 * flipped between Gemini (default) and Sarvam (Indian-hosted alternative) without
 * touching any downstream code.
 */
export interface TranscriptionRequest {
  audio: Buffer;
  mimeType: string;
  /** BCP-47 hint; per-call override wins over the profile's. undefined = auto-detect. */
  languageHint?: string;
  /**
   * Set when the audio is multi-channel with a known leg per channel. When present
   * the transcriber MUST use it and skip diarization entirely. Forward-looking:
   * today's carrier recording is likely a single mixed (mono) track, so in practice
   * the LLM-diarization path is primary and this is the deterministic fast path for
   * when a dual-channel recording becomes available.
   */
  channelRoles?: Record<number, DialerSpeakerRole>;
  /** Total call duration from the DB — a sanity check on the audio (runner cross-check). */
  expectedDurationSeconds?: number;
}

export interface TranscriptionResult {
  entries: DialerTranscriptEntry[];
  detectedLanguage: string;
  durationSeconds: number;
  model: string;
  diarizationFailed: boolean;
}

/**
 * Awaited after each transcription window so the runner can heartbeat. A
 * 45-minute call is several sequential windows; heartbeating per window keeps a
 * healthy long job from tripping the stale-heartbeat recovery sweep mid-run.
 * `secondsDone` is the window end. Optional — Sarvam (single-shot) ignores it.
 */
export type TranscribeProgress = (secondsDone: number) => Promise<void> | void;

export interface Transcriber {
  readonly provider: 'gemini' | 'sarvam';
  transcribe(req: TranscriptionRequest, onProgress?: TranscribeProgress): Promise<TranscriptionResult>;
}

export type TranscriptionErrorCode =
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_TOO_SHORT'
  | 'UNSUPPORTED_AUDIO'
  | 'TRANSCRIPTION_FAILED'
  | 'TRANSCRIPTION_EMPTY'
  | 'TIMEOUT'
  /**
   * 429 / RESOURCE_EXHAUSTED. Retried with longer jittered backoff and does NOT
   * consume an attempt — we were never given a chance to succeed.
   */
  | 'RATE_LIMITED';

export class TranscriptionError extends Error {
  constructor(
    public readonly code: TranscriptionErrorCode,
    message: string,
    /** False for permanent failures — the runner must not burn retries. */
    public readonly retryable = true,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}
