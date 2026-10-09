/**
 * PostHog LLM Analytics ($ai_generation) catalog.
 *
 * Emits one `$ai_generation` event per LLM call, keyed on `$ai_trace_id = call_id`
 * so every call renders in PostHog as a replayable trace of generations (model,
 * latency, tokens, cost). Cost is auto-computed by PostHog from `$ai_provider` +
 * `$ai_model` + token counts for recognized models.
 *
 * Sits on the shared transport in `./client.js` (same client, environment tag,
 * and identity model as the product-analytics catalog). Two independent gates:
 *  - `analytics.enabled` (POSTHOG_ENABLED) — constructs the client. Without it
 *    these emitters are no-ops.
 *  - `analytics.llmObservabilityEnabled` (POSTHOG_LLM_OBSERVABILITY_ENABLED) —
 *    sub-gate for emitting `$ai_generation` events specifically.
 *
 * Every emitter is best-effort fire-and-forget and never throws into the call path.
 */
import { config } from '../config/index.js';
import { capture, isPostHogEnabled } from './client.js';
import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';

/** PostHog LLM Analytics event name. */
const AI_GENERATION = '$ai_generation';

/** True when both the client and the LLM-observability sub-gate are enabled. */
function llmEnabled(): boolean {
  return isPostHogEnabled() && config.analytics.llmObservabilityEnabled;
}

/**
 * `$ai_generation` for the dialer **transcription** call, sharing the call's trace
 * (`$ai_trace_id = call_id`) under a `dialer_transcription` span. Always metrics-only
 * — the transcriber input is a word-for-word human conversation, so content is never
 * forwarded. Keyed on ids only.
 */
export function trackDialerTranscription(args: {
  callId: string;
  tenantId: string;
  accountId: string;
  provider: 'gemini' | 'sarvam';
  model: string;
  latencyMs?: number;
  audioSeconds?: number;
}): void {
  if (!llmEnabled()) return;
  capture(AI_GENERATION, args.tenantId, args.accountId, {
    $ai_trace_id: args.callId,
    $ai_span_id: `${args.callId}:transcription`,
    $ai_span_name: 'dialer_transcription',
    $ai_model: args.model,
    $ai_provider: args.provider,
    $ai_latency: args.latencyMs != null ? args.latencyMs / 1000 : undefined,
    $ai_is_error: false,
    // ── Business dimensions ──
    call_id: args.callId,
    call_type: 'webrtc_call',
    transcriber: args.provider,
    audio_seconds: args.audioSeconds,
  });
}

/**
 * `$ai_generation` for the dialer **post-call analysis** LLM call, on the same trace
 * (`$ai_trace_id = call_id`) under a `post_call_analysis` span. Always metrics-only.
 * Keyed on ids only.
 */
export function trackDialerLlmAnalysis(args: {
  callId: string;
  tenantId: string;
  accountId: string;
  analysis: CallAnalysisResult;
}): void {
  if (!llmEnabled()) return;
  const meta = args.analysis._meta;
  capture(AI_GENERATION, args.tenantId, args.accountId, {
    $ai_trace_id: args.callId,
    $ai_span_id: `${args.callId}:analysis`,
    $ai_span_name: 'post_call_analysis',
    $ai_model: meta.model,
    $ai_provider: meta.provider,
    $ai_latency: meta.latency_ms != null ? meta.latency_ms / 1000 : undefined,
    $ai_input_tokens: meta.prompt_tokens,
    $ai_output_tokens: meta.completion_tokens,
    $ai_is_error: false,
    // ── Business dimensions ──
    call_id: args.callId,
    call_type: 'webrtc_call',
  });
}
