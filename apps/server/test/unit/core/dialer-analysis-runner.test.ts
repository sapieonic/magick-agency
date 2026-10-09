/**
 * DialerAnalysisRunner unit test.
 *
 * Constructs the runner directly with a mock transcriber + analysis service and
 * drives `run(job)`, asserting the job lifecycle:
 *  - happy path: fetch → transcribe → persistTranscript (BEFORE analyze) →
 *    markAnalyzing → analyze → completeWithAnalysis → metrics/posthog/audit.
 *  - transcript persisted before analysis (ordering).
 *  - RESUME: a populated conversation_log skips fetch/transcribe/persist.
 *  - analysis failure leaves the transcript intact (persist happened, no complete).
 *  - empty transcript ⇒ skipped, NOT failed (no charge, no retry).
 *  - role mapping agent→assistant, customer→user, unknown→user.
 *  - snapshot used, never a live profile lookup, even if the profile was deactivated (M1).
 *  - stale claim_generation write rejected: persist fence false ⇒ abandon (M9).
 *  - the runner NEVER throws.
 *
 * Mocking: vi.hoisted + vi.mock with ESM .js imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * The call fixture is an `agency_calls` row. One case pins that the fetch is handed
 * the VoiceLink recording-host allow-list (and an unconfigured runner hands it an
 * empty one, i.e. fails closed).
 */
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// ── Repositories ────────────────────────────────────────────────────────────
const { mockJobRepo, mockWebrtcRepo } = vi.hoisted(() => ({
  mockJobRepo: {
    markSkipped: vi.fn().mockResolvedValue(true),
    heartbeat: vi.fn().mockResolvedValue(true),
    markAnalyzing: vi.fn().mockResolvedValue(true),
    persistTranscript: vi.fn().mockResolvedValue(true),
    completeWithAnalysis: vi.fn().mockResolvedValue(true),
    requeueForRetry: vi.fn().mockResolvedValue(true),
    requeueRateLimited: vi.fn().mockResolvedValue(true),
    markFailed: vi.fn().mockResolvedValue(true),
  },
  mockWebrtcRepo: {
    findById: vi.fn(),
  },
}));
vi.mock('@magick-agency/db/repositories/dialer-analysis-job.repository', () => ({
  dialerAnalysisJobRepository: mockJobRepo,
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mockWebrtcRepo,
}));

// ── Recording fetcher ───────────────────────────────────────────────────────
const { mockFetchRecordingBytes } = vi.hoisted(() => ({
  mockFetchRecordingBytes: vi.fn().mockResolvedValue({ bytes: Buffer.from('audio'), mimeType: 'audio/wav' }),
}));
vi.mock('../../../src/transcription/recording-fetcher.js', () => ({
  fetchRecordingBytes: mockFetchRecordingBytes,
}));

// ── Metrics ─────────────────────────────────────────────────────────────────
vi.mock('@magick-agency/observability/metrics/analysis', () => ({
  dialerAnalysisTotal: { inc: vi.fn() },
  dialerAnalysisDurationSeconds: { observe: vi.fn() },
  dialerTranscriptionAudioSeconds: { observe: vi.fn() },
  setDialerAnalysisQueueDepth: vi.fn(),
}));

// ── Analytics ───────────────────────────────────────────────────────────────
const { mockTrackDialerCallAnalyzed, mockTrackDialerTranscription, mockTrackDialerLlmAnalysis } = vi.hoisted(() => ({
  mockTrackDialerCallAnalyzed: vi.fn(),
  mockTrackDialerTranscription: vi.fn(),
  mockTrackDialerLlmAnalysis: vi.fn(),
}));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackDialerCallAnalyzed: mockTrackDialerCallAnalyzed,
}));
vi.mock('../../../src/analytics/llm-observability.js', () => ({
  trackDialerTranscription: mockTrackDialerTranscription,
  trackDialerLlmAnalysis: mockTrackDialerLlmAnalysis,
}));

// ── Audit ───────────────────────────────────────────────────────────────────
const { mockAuditLogger } = vi.hoisted(() => ({ mockAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: mockAuditLogger }));

import { DialerAnalysisRunner, toAnalysisEntries, type DialerAnalysisConfig } from '../../../src/core/dialer-analysis-runner.js';
import { TranscriptionError } from '../../../src/transcription/types.js';
import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';
import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';

const CFG: DialerAnalysisConfig = {
  enabled: true,
  transcriber: 'gemini',
  geminiModel: 'gemini-2.5-flash',
  geminiApiKey: 'k',
  transcribeTimeoutMs: 180000,
  transcribeWindowSeconds: 600,
  maxRecordingBytes: 50 * 1024 * 1024,
  minTalkTimeSeconds: 10,
  recordingWaitMinutes: 30,
  maxAttempts: 3,
  maxAttemptsTotal: 8,
  concurrency: 2,
  pollIntervalMs: 60000,
  settleSeconds: 15,
} as DialerAnalysisConfig;

function makeJob(over: Partial<DialerAnalysisJobRecord> = {}): DialerAnalysisJobRecord {
  return {
    id: 'job-1',
    call_id: 'call-1',
    tenant_id: 'ten-1',
    account_id: 'acc-1',
    profile_id: 'prof-1',
    profile_snapshot: { context: 'debt collection', custom_dimensions: [{ key: 'promised_to_pay', description: 'x', type: 'boolean' }], language_hint: 'en-IN' },
    analysis_language: null,
    status: 'transcribing',
    attempts: 1,
    attempts_total: 1,
    claim_generation: 5,
    claimed_at: new Date(),
    heartbeat_at: new Date(),
    next_attempt_at: null,
    analysis_audio_seconds: null,
    error_code: null,
    error_message: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function makeCall(over: Partial<WebRtcCallRecord> = {}): WebRtcCallRecord {
  return {
    id: 'call-1',
    tenant_id: 'ten-1',
    account_id: 'acc-1',
    caller_id: '+1000',
    destination_phone: '+1999',
    provider: 'voicelink',
    provider_call_id: 'p1',
    status: 'completed',
    outcome: 'ended_by_user',
    error_code: null,
    error_message: null,
    initiated_by: 'user-1',
    metadata: {},
    recording_requested: true,
    recording_url: 'https://rec/call-1.wav',
    recording_duration_seconds: 100,
    answered_at: new Date(),
    ended_at: new Date(),
    duration_seconds: 110,
    talk_time_seconds: 100,
    analysis_profile_id: 'prof-1',
    analysis_language: null,
    analysis_status: 'awaiting_recording',
    call_analysis: null,
    conversation_log: null,
    transcript_meta: null,
    analysis_consent: null,
    analysis_consent_at: null,
    campaign_id: 'camp-1',
    agency_attempt_id: 'att-1',
    created_at: new Date(),
    updated_at: new Date(),
    ...over,
  };
}

function analysisResult(): CallAnalysisResult {
  return {
    common: {
      overall_sentiment: { label: 'positive', score: 0.7 },
      turn_sentiments: [],
      key_topics: ['payment'],
      conversation_quality: { coherence: 8, resolution_achieved: true, effectiveness_score: 7 },
      summary: 's',
    },
    custom: { promised_to_pay: true },
    _meta: { model: 'gpt-4o-mini', provider: 'openai', latency_ms: 100, prompt_tokens: 10, completion_tokens: 5, analyzed_at: new Date().toISOString() },
  };
}

function makeTranscriber(over: Record<string, unknown> = {}) {
  return {
    provider: 'gemini' as const,
    transcribe: vi.fn().mockResolvedValue({
      entries: [
        { role: 'agent', content: 'Hello', start_seconds: 0, end_seconds: 50 },
        { role: 'customer', content: 'Hi', start_seconds: 50, end_seconds: 95 },
      ],
      detectedLanguage: 'English',
      durationSeconds: 95,
      model: 'gemini-2.5-flash',
      diarizationFailed: false,
    }),
    ...over,
  };
}

function makeAnalysisService(result = analysisResult()) {
  return { analyze: vi.fn().mockResolvedValue(result) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWebrtcRepo.findById.mockResolvedValue(makeCall());
  mockJobRepo.markSkipped.mockResolvedValue(true);
  mockJobRepo.heartbeat.mockResolvedValue(true);
  mockJobRepo.markAnalyzing.mockResolvedValue(true);
  mockJobRepo.persistTranscript.mockResolvedValue(true);
  mockJobRepo.completeWithAnalysis.mockResolvedValue(true);
});

describe('DialerAnalysisRunner.run', () => {
  it('happy path: fetch → transcribe → persistTranscript → analyze → complete', async () => {
    const transcriber = makeTranscriber();
    const analysisService = makeAnalysisService();
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob());

    expect(mockFetchRecordingBytes).toHaveBeenCalledOnce();
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
    expect(mockJobRepo.persistTranscript).toHaveBeenCalledOnce();
    expect(mockJobRepo.markAnalyzing).toHaveBeenCalledWith('job-1', 5);
    expect(analysisService.analyze).toHaveBeenCalledOnce();
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
    // analysis_audio_seconds = min(recording 100, transcriber 95) = 95
    expect(mockJobRepo.completeWithAnalysis.mock.calls[0]![3].analysis_audio_seconds).toBe(95);
    expect(mockTrackDialerCallAnalyzed).toHaveBeenCalledOnce();
    expect(mockTrackDialerLlmAnalysis).toHaveBeenCalledOnce();
    expect(mockAuditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'dialer_call.analysis.completed' }));
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('hands the fetch the VoiceLink recording-host allow-list (empty = fail closed when unconfigured)', async () => {
    const hosts = ['recordings.voicelink.test'];
    await new DialerAnalysisRunner({
      transcriber: makeTranscriber() as never, analysisService: makeAnalysisService() as never, config: CFG, recordingHosts: hosts,
    }).run(makeJob());
    expect(mockFetchRecordingBytes).toHaveBeenLastCalledWith('https://rec/call-1.wav', expect.objectContaining({ allowedHosts: hosts }));
    // No credential id is passed any more.
    expect(mockFetchRecordingBytes.mock.calls[0]![1]).not.toHaveProperty('telephonyCredentialId');

    await new DialerAnalysisRunner({
      transcriber: makeTranscriber() as never, analysisService: makeAnalysisService() as never, config: CFG,
    }).run(makeJob());
    expect(mockFetchRecordingBytes).toHaveBeenLastCalledWith('https://rec/call-1.wav', expect.objectContaining({ allowedHosts: [] }));
  });

  it('persists the transcript BEFORE calling analyze', async () => {
    const order: string[] = [];
    mockJobRepo.persistTranscript.mockImplementation(async () => { order.push('persist'); return true; });
    const analysisService = { analyze: vi.fn().mockImplementation(async () => { order.push('analyze'); return analysisResult(); }) };
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob());

    expect(order).toEqual(['persist', 'analyze']);
  });

  it('abandons immediately when a transcription-progress heartbeat is fenced out', async () => {
    mockJobRepo.heartbeat
      .mockResolvedValueOnce(true)  // post-fetch heartbeat
      .mockResolvedValueOnce(false); // MAX_TOKENS/split progress heartbeat
    const transcribe = vi.fn().mockImplementation(async (_req, onProgress) => {
      await onProgress(0);
      throw new Error('should be replaced by the stale-claim signal');
    });
    const runner = new DialerAnalysisRunner({
      transcriber: makeTranscriber({ transcribe }) as never,
      analysisService: makeAnalysisService() as never,
      config: CFG,
    });

    await runner.run(makeJob());

    expect(mockJobRepo.persistTranscript).not.toHaveBeenCalled();
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('RESUME: a populated conversation_log skips fetch/transcribe/persist', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({
      conversation_log: [{ role: 'agent', content: 'prior' }],
      transcript_meta: { provider: 'gemini', model: 'gemini-2.5-flash', detected_language: 'English', duration_seconds: 90, turn_count: 1, latency_ms: 10, transcribed_at: new Date().toISOString() },
    }));
    const transcriber = makeTranscriber();
    const analysisService = makeAnalysisService();
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob());

    expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(mockJobRepo.persistTranscript).not.toHaveBeenCalled();
    expect(mockJobRepo.markAnalyzing).toHaveBeenCalledOnce();
    expect(analysisService.analyze).toHaveBeenCalledOnce();
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
  });

  it('analysis failure leaves the transcript intact (persist happened, no complete, requeue)', async () => {
    const analysisService = { analyze: vi.fn().mockRejectedValue(new Error('LLM down')) };
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob({ attempts: 1 }));

    expect(mockJobRepo.persistTranscript).toHaveBeenCalledOnce();
    expect(mockJobRepo.completeWithAnalysis).not.toHaveBeenCalled();
    // attempts (1) < maxAttempts (3) ⇒ retryable requeue, not markFailed.
    expect(mockJobRepo.requeueForRetry).toHaveBeenCalledOnce();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('empty transcript ⇒ skipped, NOT failed', async () => {
    const transcriber = makeTranscriber({
      transcribe: vi.fn().mockResolvedValue({ entries: [], detectedLanguage: 'unknown', durationSeconds: 0, model: 'gemini-2.5-flash', diarizationFailed: false }),
    });
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob());

    expect(mockJobRepo.markSkipped).toHaveBeenCalledWith('job-1', 'call-1', 5, 'TRANSCRIPTION_EMPTY', expect.any(String));
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
    expect(mockJobRepo.completeWithAnalysis).not.toHaveBeenCalled();
  });

  it('truncated fetch (duration shortfall) ⇒ retryable AUDIO_TOO_SHORT requeue', async () => {
    // recording_duration 100, transcript only covers ~40s (< 80%).
    const transcriber = makeTranscriber({
      transcribe: vi.fn().mockResolvedValue({
        entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 40 }],
        detectedLanguage: 'English', durationSeconds: 40, model: 'gemini-2.5-flash', diarizationFailed: false,
      }),
    });
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob({ attempts: 1 }));

    // Transcript persisted first? No — the cross-check throws before persist.
    expect(mockJobRepo.persistTranscript).not.toHaveBeenCalled();
    expect(mockJobRepo.requeueForRetry).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'AUDIO_TOO_SHORT', expect.any(String));
  });

  // ── pre-finalization race: in-attempt re-fetch ────────────────────────────
  // A carrier can serve `recording_url` a moment before the file is finalized, so
  // the first fetch returns truncated audio. These retries re-fetch WITHOUT burning
  // a job attempt (a late-finalizing carrier isn't a failure of the job).

  it('re-fetches a truncated recording in-attempt and succeeds on the retry', async () => {
    const cfg = { ...CFG, recordingFetchRetries: 2, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig;
    // First fetch is truncated (40s of 100s), second returns the full recording.
    const transcribe = vi.fn()
      .mockResolvedValueOnce({
        entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 40 }],
        detectedLanguage: 'English', durationSeconds: 40, model: 'gemini-2.5-flash', diarizationFailed: false,
      })
      .mockResolvedValueOnce({
        entries: [{ role: 'agent', content: 'full call', start_seconds: 0, end_seconds: 98 }],
        detectedLanguage: 'English', durationSeconds: 98, model: 'gemini-2.5-flash', diarizationFailed: false,
      });
    const runner = new DialerAnalysisRunner({
      transcriber: makeTranscriber({ transcribe }) as never,
      analysisService: makeAnalysisService() as never,
      config: cfg,
    });

    await runner.run(makeJob({ attempts: 1 }));

    expect(transcribe).toHaveBeenCalledTimes(2);
    // The retry is transparent: the job completes normally and never burns an attempt.
    expect(mockJobRepo.persistTranscript).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('gives up as retryable AUDIO_TOO_SHORT once the in-attempt re-fetches are exhausted', async () => {
    const cfg = { ...CFG, recordingFetchRetries: 2, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig;
    // Always truncated — the carrier never finalizes within the retry window.
    const transcribe = vi.fn().mockResolvedValue({
      entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 40 }],
      detectedLanguage: 'English', durationSeconds: 40, model: 'gemini-2.5-flash', diarizationFailed: false,
    });
    const runner = new DialerAnalysisRunner({
      transcriber: makeTranscriber({ transcribe }) as never,
      analysisService: makeAnalysisService() as never,
      config: cfg,
    });

    await runner.run(makeJob({ attempts: 1 }));

    expect(transcribe).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(mockJobRepo.persistTranscript).not.toHaveBeenCalled();
    // Still retryable — the job backs off and tries again later, not terminal.
    expect(mockJobRepo.requeueForRetry).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'AUDIO_TOO_SHORT', expect.any(String));
  });

  it('does not re-fetch an empty transcript (silent recording is not a truncation)', async () => {
    const cfg = { ...CFG, recordingFetchRetries: 2, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig;
    const transcribe = vi.fn().mockResolvedValue({
      entries: [], detectedLanguage: 'unknown', durationSeconds: 0, model: 'gemini-2.5-flash', diarizationFailed: false,
    });
    const runner = new DialerAnalysisRunner({
      transcriber: makeTranscriber({ transcribe }) as never,
      analysisService: makeAnalysisService() as never,
      config: cfg,
    });

    await runner.run(makeJob({ attempts: 1 }));

    expect(transcribe).toHaveBeenCalledTimes(1); // no pointless re-fetch
    expect(mockJobRepo.markSkipped).toHaveBeenCalledWith('job-1', 'call-1', 5, 'TRANSCRIPTION_EMPTY', expect.any(String));
  });

  it('uses the SNAPSHOT dimensions/context, never a live profile lookup (M1)', async () => {
    const analysisService = makeAnalysisService();
    const snapshot = { context: 'renewals', custom_dimensions: [{ key: 'renewed', description: 'd', type: 'boolean' as const }], language_hint: 'hi-IN' };
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob({ profile_snapshot: snapshot }));

    const [, entries, cfg, opts] = analysisService.analyze.mock.calls[0]!;
    expect(cfg).toEqual({ custom_dimensions: snapshot.custom_dimensions });
    expect(opts).toEqual({ context: 'renewals' });
    expect(entries.length).toBe(2);
  });

  it('language hint precedence: job.analysis_language wins over snapshot', async () => {
    const transcriber = makeTranscriber();
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob({ analysis_language: 'te-IN', profile_snapshot: { custom_dimensions: [], language_hint: 'en-IN' } }));

    expect(transcriber.transcribe.mock.calls[0]![0].languageHint).toBe('te-IN');
  });

  it('stale claim_generation: persist fence false ⇒ abandon (M9), no analyze/complete', async () => {
    mockJobRepo.persistTranscript.mockResolvedValue(false);
    const analysisService = makeAnalysisService();
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob());

    expect(analysisService.analyze).not.toHaveBeenCalled();
    expect(mockJobRepo.completeWithAnalysis).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('bails skipped when the call has no recording_url', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({ recording_url: null }));
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob());

    expect(mockJobRepo.markSkipped).toHaveBeenCalledWith('job-1', 'call-1', 5, 'NO_RECORDING', expect.any(String));
    expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
  });

  it('bails skipped when the call is already analysed', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({ analysis_status: 'completed' }));
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob());

    expect(mockJobRepo.markSkipped).toHaveBeenCalledWith('job-1', 'call-1', 5, 'ALREADY_ANALYSED', expect.any(String));
  });

  it('rate-limited ⇒ requeue without consuming an attempt (M4)', async () => {
    const transcriber = makeTranscriber({
      transcribe: vi.fn().mockRejectedValue(new TranscriptionError('RATE_LIMITED', '429')),
    });
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob());

    expect(mockJobRepo.requeueRateLimited).toHaveBeenCalledOnce();
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('non-retryable transcription error ⇒ failed immediately', async () => {
    const transcriber = makeTranscriber({
      transcribe: vi.fn().mockRejectedValue(new TranscriptionError('UNSUPPORTED_AUDIO', 'bad', false)),
    });
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob({ attempts: 1 }));

    expect(mockJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'call-1', 5, 'UNSUPPORTED_AUDIO', expect.any(String));
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
  });

  it('attempts exhausted ⇒ failed even when the error is retryable', async () => {
    const transcriber = makeTranscriber({ transcribe: vi.fn().mockRejectedValue(new Error('boom')) });
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob({ attempts: 3 })); // == maxAttempts

    expect(mockJobRepo.markFailed).toHaveBeenCalledOnce();
    expect(mockAuditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'dialer_call.analysis.failed' }));
  });

  it('NEVER throws even when completeWithAnalysis throws', async () => {
    mockJobRepo.completeWithAnalysis.mockRejectedValue(new Error('db down'));
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: makeAnalysisService() as never, config: CFG });

    await expect(runner.run(makeJob())).resolves.toBeUndefined();
  });
});

describe('toAnalysisEntries', () => {
  it('maps agent→assistant, customer→user, unknown→user', () => {
    const out = toAnalysisEntries([
      { role: 'agent', content: 'a' },
      { role: 'customer', content: 'c' },
      { role: 'unknown', content: 'u' },
    ]);
    expect(out.map((e) => e.role)).toEqual(['assistant', 'user', 'user']);
    expect(out.map((e) => e.content)).toEqual(['a', 'c', 'u']);
  });
});
