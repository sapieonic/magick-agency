import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';

/*
 * The dialer analytics emitters (`posthog.ts` / `llm-observability.ts`) run
 * through the real shared transport (`analytics/client.ts`) over a mocked `posthog-node`,
 * as `posthog.test.ts` does. Covers: the event name and properties, the PII
 * posture (no summary / transcript / custom dimension values), the LLM-observability
 * gate, and no-op-without-a-client.
 */

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  config: {
    analytics: {
      enabled: true,
      apiKey: 'phc_test_key',
      host: 'https://us.i.posthog.com',
      flushAt: 20,
      flushIntervalMs: 10000,
      requestTimeoutMs: 10000,
      llmObservabilityEnabled: true,
    },
    server: { env: 'test' },
  } as { analytics: Record<string, unknown>; server: { env: string } },
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture(...args: unknown[]) { return mocks.capture(...args); }
    groupIdentify() {}
    async shutdown() {}
  },
}));

vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));

vi.mock('@magick-agency/observability', () => ({
  logger: mocks.logMock,
  createChildLogger: () => mocks.logMock,
}));

import { initAnalytics, shutdownAnalytics, trackDialerCallAnalyzed } from '../../../src/analytics/posthog.js';
import { trackDialerTranscription, trackDialerLlmAnalysis } from '../../../src/analytics/llm-observability.js';

const analysis: CallAnalysisResult = {
  common: {
    overall_sentiment: { label: 'positive', score: 0.7 },
    turn_sentiments: [],
    key_topics: ['payment'],
    conversation_quality: { coherence: 8, resolution_achieved: true, effectiveness_score: 7 },
    summary: 'SECRET SUMMARY',
  },
  custom: { promised_to_pay: 'SECRET DIMENSION' },
  _meta: { model: 'gpt-4o-mini', provider: 'openai', latency_ms: 2000, prompt_tokens: 10, completion_tokens: 5, analyzed_at: 'now' },
};

/** The `client.capture` payload of the n-th sent event. */
function sent(n = 0): { distinctId: string; event: string; properties: Record<string, unknown>; groups: Record<string, string> } {
  return mocks.capture.mock.calls[n]![0];
}

beforeEach(async () => {
  mocks.capture.mockReset();
  mocks.config.analytics['enabled'] = true;
  mocks.config.analytics['llmObservabilityEnabled'] = true;
  await shutdownAnalytics();
  initAnalytics();
});

afterEach(async () => {
  await shutdownAnalytics();
});

describe('dialer analytics events', () => {
  it('dialer_call_analyzed carries ids, enums and counts and NEVER the summary or dimension values', () => {
    trackDialerCallAnalyzed({
      callId: 'c1', tenantId: 't1', accountId: 'a1', transcriber: 'gemini', provider: 'voicelink',
      audioSeconds: 95, turnCount: 2, diarizationFailed: false, analysisProfileId: 'p1', analysis,
    });
    expect(mocks.capture).toHaveBeenCalledOnce();
    const { event, distinctId, groups, properties } = sent();
    expect([event, distinctId, groups]).toEqual(['dialer_call_analyzed', 'a1', { tenant: 't1' }]);
    expect(properties).toMatchObject({
      call_id: 'c1', call_type: 'webrtc_call', provider: 'voicelink', transcriber: 'gemini', audio_seconds: 95,
      turn_count: 2, analysis_profile_id: 'p1', sentiment_label: 'positive', prompt_tokens: 10, completion_tokens: 5,
      tenant_id: 't1', account_id: 'a1',
    });
    expect(JSON.stringify(properties)).not.toContain('SECRET');
  });

  it('a missing analysis profile is omitted, not null', () => {
    trackDialerCallAnalyzed({ callId: 'c1', tenantId: 't1', accountId: 'a1', transcriber: 'sarvam', analysisProfileId: null, analysis });
    expect(sent().properties).not.toHaveProperty('analysis_profile_id');
  });

  it('transcription $ai_generation is keyed on the call trace, metrics only', () => {
    trackDialerTranscription({ callId: 'c1', tenantId: 't1', accountId: 'a1', provider: 'gemini', model: 'gemini-3.5-flash', latencyMs: 4000, audioSeconds: 95 });
    const { event, properties } = sent();
    expect(event).toBe('$ai_generation');
    expect(properties).toMatchObject({
      $ai_trace_id: 'c1', $ai_span_id: 'c1:transcription', $ai_span_name: 'dialer_transcription',
      $ai_model: 'gemini-3.5-flash', $ai_provider: 'gemini', $ai_latency: 4, $ai_is_error: false, audio_seconds: 95,
    });
    expect(properties).not.toHaveProperty('$ai_input');
    expect(properties).not.toHaveProperty('$ai_output');
  });

  it('analysis $ai_generation reports tokens and latency from the result meta', () => {
    trackDialerLlmAnalysis({ callId: 'c1', tenantId: 't1', accountId: 'a1', analysis });
    expect(sent().properties).toMatchObject({
      $ai_trace_id: 'c1', $ai_span_id: 'c1:analysis', $ai_span_name: 'post_call_analysis',
      $ai_model: 'gpt-4o-mini', $ai_provider: 'openai', $ai_latency: 2, $ai_input_tokens: 10, $ai_output_tokens: 5,
    });
    expect(JSON.stringify(sent().properties)).not.toContain('SECRET');
  });

  it('both $ai_generation emitters are off without the LLM-observability sub-gate', () => {
    mocks.config.analytics['llmObservabilityEnabled'] = false;
    trackDialerTranscription({ callId: 'c1', tenantId: 't1', accountId: 'a1', provider: 'gemini', model: 'm' });
    trackDialerLlmAnalysis({ callId: 'c1', tenantId: 't1', accountId: 'a1', analysis });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('and off when the client is not enabled', async () => {
    await shutdownAnalytics();
    mocks.config.analytics['enabled'] = false;
    initAnalytics();
    trackDialerTranscription({ callId: 'c1', tenantId: 't1', accountId: 'a1', provider: 'gemini', model: 'm' });
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('without a client every dialer emitter is a no-op that never throws (nothing sent)', async () => {
    await shutdownAnalytics();
    expect(() => trackDialerCallAnalyzed({ callId: 'c1', tenantId: 't1', accountId: 'a1', transcriber: 'gemini', analysis })).not.toThrow();
    expect(() => trackDialerTranscription({ callId: 'c1', tenantId: 't1', accountId: 'a1', provider: 'gemini', model: 'm' })).not.toThrow();
    expect(() => trackDialerLlmAnalysis({ callId: 'c1', tenantId: 't1', accountId: 'a1', analysis })).not.toThrow();
    expect(mocks.capture).not.toHaveBeenCalled();
  });
});
