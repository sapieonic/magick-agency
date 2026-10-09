// The lifecycle wrappers, the three WebRTC bridge trackers and
// `trackDialerCallAnalyzed`. There is no SIP egress, so `egress` is always
// `'pstn'` and no SIP connection id is sent; the rejection's default provider is
// `voicelink`.
/**
 * PostHog product/business analytics.
 *
 * Design rules (intentional):
 *  - **No PII leaves this process.** Only IDs, enums, counts, durations, costs,
 *    and model/sentiment metrics are forwarded. Phone numbers, names, recipient
 *    metadata, transcripts, summaries, and operator-defined custom analysis
 *    dimensions are deliberately excluded.
 *  - **Never throws into the call path.** Every public function is best-effort
 *    fire-and-forget; capture failures are logged and swallowed.
 *  - **No-op when disabled.** If `config.analytics.enabled` is false (or no API
 *    key is configured), the client is never constructed and every emitter is a
 *    cheap no-op.
 *  - **Identity model mirrors auth scoping.** `distinct_id = account_id`, and
 *    every event is associated with the `tenant` group (`group_key = tenant_id`).
 *    Both IDs are opaque, non-PII.
 */
import { initPostHogClient, shutdownPostHogClient, isPostHogEnabled, capture as track } from './client.js';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';
import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';

/**
 * Initializes PostHog analytics. Safe to call once at startup; no-op (and leaves
 * the module disabled) when analytics is off or no API key is present.
 */
export function initAnalytics(): void {
  initPostHogClient();
}

/** Flushes buffered events and shuts the client down. No-op when disabled. */
export async function shutdownAnalytics(): Promise<void> {
  await shutdownPostHogClient();
}

/** True when analytics is active. Exposed for tests/metadata. */
export function isAnalyticsEnabled(): boolean {
  return isPostHogEnabled();
}

/**
 * `webrtc_call_initiated` — a browser→PSTN bridge call was created and the
 * outbound leg placed. Emitted once per call from the bridge's single creation
 * point, so it is the reliable funnel denominator.
 */
export function trackWebrtcCallInitiated(record: WebRtcCallRecord): void {
  track('webrtc_call_initiated', record.tenant_id, record.account_id, {
    call_id: record.id,
    telephony_provider: record.provider,
    direction: 'outbound',
    has_metadata: Object.keys(record.metadata ?? {}).length > 0,
    // Always PSTN: there is no SIP egress.
    egress: 'pstn',
  });
}

/** Why a WebRTC bridge call was refused before the outbound leg was placed. */
export type WebrtcCallRejectionReason =
  | 'feature_disabled'
  | 'invalid_caller_id'
  | 'global_concurrency_limit'
  | 'account_concurrency_limit'
  | 'provider_concurrency_limit'
  | 'provider_concurrency_unavailable';

/**
 * `webrtc_call_rejected` — a bridge call was refused at a pre-flight check
 * (feature gate, caller-ID ownership, or capacity). Gives the acquisition funnel
 * a true denominator and makes capacity saturation (`*_concurrency_limit`)
 * visible per tenant/account. No `call_id` — the record doesn't exist yet.
 */
export function trackWebrtcCallRejected(args: {
  tenantId: string;
  accountId: string;
  reason: WebrtcCallRejectionReason;
  provider?: string;
}): void {
  track('webrtc_call_rejected', args.tenantId, args.accountId, {
    reason: args.reason,
    telephony_provider: args.provider ?? 'voicelink',
    direction: 'outbound',
  });
}

/** Which side ended a WebRTC bridge call. */
export type WebrtcCallEndedBy = 'user' | 'remote' | 'system' | 'error';

/**
 * `webrtc_call_completed` — terminal bridge-call event with outcome, timing, and
 * answer-anchored talk time. `connected` reflects whether the PSTN leg was ever
 * answered (talk-time anchored), so unanswered calls correctly count 0. Emitted
 * from `WebRtcBridgeManager.endCall` after the terminal row is persisted.
 */
export function trackWebrtcCallCompleted(args: {
  callId: string;
  tenantId: string;
  accountId: string;
  provider: string;
  status: string;
  outcome?: string;
  connected: boolean;
  durationSeconds?: number;
  talkTimeSeconds?: number;
  errorCode?: string;
  endedBy?: WebrtcCallEndedBy;
}): void {
  track('webrtc_call_completed', args.tenantId, args.accountId, {
    call_id: args.callId,
    telephony_provider: args.provider,
    direction: 'outbound',
    status: args.status,
    outcome: args.outcome,
    connected: args.connected,
    duration_seconds: args.durationSeconds,
    talk_time_seconds: args.talkTimeSeconds,
    error_code: args.errorCode,
    ended_by: args.endedBy,
    // Always PSTN: there is no SIP egress.
    egress: 'pstn',
  });
}

/**
 * `dialer_call_analyzed` — post-call analysis of a dialer (WebRTC human) call.
 * Same PII posture as every event here: NEVER forward the summary, transcript, or
 * operator-defined custom dimension values — only ids/enums/counts plus the
 * transcription-specific metrics. Emitted from the dialer-analysis runner.
 */
export function trackDialerCallAnalyzed(args: {
  callId: string;
  tenantId: string;
  accountId: string;
  transcriber: 'gemini' | 'sarvam';
  provider?: string;
  audioSeconds?: number;
  turnCount?: number;
  diarizationFailed?: boolean;
  analysisProfileId?: string | null;
  analysis: CallAnalysisResult;
}): void {
  const common = args.analysis.common;
  track('dialer_call_analyzed', args.tenantId, args.accountId, {
    call_id: args.callId,
    call_type: 'webrtc_call',
    provider: args.provider,
    transcriber: args.transcriber,
    audio_seconds: args.audioSeconds,
    turn_count: args.turnCount,
    diarization_failed: args.diarizationFailed,
    analysis_profile_id: args.analysisProfileId ?? undefined,
    sentiment_label: common.overall_sentiment.label,
    sentiment_score: common.overall_sentiment.score,
    resolution_achieved: common.conversation_quality.resolution_achieved,
    coherence: common.conversation_quality.coherence,
    effectiveness_score: common.conversation_quality.effectiveness_score,
    key_topics: common.key_topics,
    analysis_model: args.analysis._meta.model,
    analysis_provider: args.analysis._meta.provider,
    analysis_latency_ms: args.analysis._meta.latency_ms,
    prompt_tokens: args.analysis._meta.prompt_tokens,
    completion_tokens: args.analysis._meta.completion_tokens,
  });
}
