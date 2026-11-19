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
 *  - snapshot used, never a live profile lookup, even if the profile was deactivated.
 *  - stale claim_generation write rejected: persist fence false ⇒ abandon.
 *  - truncated recordings: re-fetched in-attempt; identical audio found short once is
 *    transcribed once more (a transcriber miss on a complete file is rescued), and once
 *    found short twice (in this attempt or earlier ones) is never transcribed again (TR1).
 *  - the runner NEVER throws.
 *
 * Mocking: vi.hoisted + vi.mock with ESM .js imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/*
 * The call fixture is an `agency_calls` row. One case pins that the fetch is handed
 * the VoiceLink recording-host allow-list (and an unconfigured runner hands it an
 * empty one, i.e. fails closed). The B21 suite runs a Plivo call through the real
 * carrier table: Basic auth to the exact media host, and a revoked credential ending
 * the analysis (on the first fetch and on a resumed run's audio re-fetch).
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

const { mockTrackRecordingFetchFailure } = vi.hoisted(() => ({ mockTrackRecordingFetchFailure: vi.fn() }));
vi.mock('@magick-agency/observability/metrics/voice', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  trackRecordingFetchFailure: mockTrackRecordingFetchFailure,
}));

// ── Audit ───────────────────────────────────────────────────────────────────
const { mockAuditLogger } = vi.hoisted(() => ({ mockAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: mockAuditLogger }));

import { createHash } from 'node:crypto';
import {
  DialerAnalysisRunner,
  formatTruncatedAudio,
  rateLimitCauseOf,
  toAnalysisEntries,
  truncatedAudioOf,
  type DialerAnalysisConfig,
} from '../../../src/core/dialer-analysis-runner.js';
import { TranscriptionError } from '../../../src/transcription/types.js';
import { RecordingByteBudget } from '../../../src/core/recording-byte-budget.js';
import { AiError } from '../../../src/ai/index.js';
import { createRecordingAccessResolver } from '../../../src/telephony/recording-access.js';
import { CredentialUnavailableError, type CredentialUnavailableKind } from '../../../src/telephony/credentials/credential-service.js';
import { Secret } from '../../../src/telephony/credentials/secret.js';
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
    vendor_refused_at: null,
    completed_at: null,
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
    provider_request_id: null,
    telephony_credential_id: null,
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
    origin: 'campaign',
    manual_call_id: null,
    inbound_call_id: null,
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

/** Successive fetches return these bodies in turn; the last one repeats. */
function fetchReturns(...bodies: string[]): void {
  let n = 0;
  mockFetchRecordingBytes.mockImplementation(async () => ({
    bytes: Buffer.from(bodies[Math.min(n++, bodies.length - 1)]!),
    mimeType: 'audio/wav',
  }));
}

/** The fingerprint the runner keeps of a fetched body. */
function fingerprint(body: string): { bytes: number; sha256: string } {
  const bytes = Buffer.from(body);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchRecordingBytes.mockReset();
  mockFetchRecordingBytes.mockResolvedValue({ bytes: Buffer.from('audio'), mimeType: 'audio/wav' });
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

  describe('a BYOC (Plivo) recording on the tenant credential (B21)', () => {
    const AUTH = `Basic ${Buffer.from('MAXXXXXXXXXXXXXXXXXX:tok_abcdefghijklmnop').toString('base64')}`;
    const plivoCall = (over: Partial<WebRtcCallRecord> = {}) => makeCall({
      provider: 'plivo', telephony_credential_id: 'cred-1',
      recording_url: 'https://media.plivo.com/v1/Account/MAXXXXXXXXXXXXXXXXXX/Recording/r.mp3', ...over,
    });
    function credentials(kind: CredentialUnavailableKind | null = null) {
      return {
        resolve: vi.fn(async (id: string) => {
          if (kind) throw new CredentialUnavailableError(id, kind, kind);
          return {
            id, tenantId: 'ten-1', provider: 'plivo', accountRef: 'MAXXXXXXXXXXXXXXXXXX', publicConfig: {},
            version: 1, secret: new Secret({ auth_token: 'tok_abcdefghijklmnop' }), previous: [],
          };
        }),
      };
    }
    const runner = (creds: ReturnType<typeof credentials>, analysisService: object = makeAnalysisService()) =>
      new DialerAnalysisRunner({
        transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG,
        resolveRecordingAccess: createRecordingAccessResolver({ voicelinkHosts: ['rec'], credentials: () => creds }),
      });

    it("fetches with Basic auth to Plivo's media hosts (media.plivo.com and its subdomains), the credential resolved for recording", async () => {
      mockWebrtcRepo.findById.mockResolvedValue(plivoCall());
      const creds = credentials();
      expect(await runner(creds).run(makeJob())).toBe('completed');
      expect(creds.resolve).toHaveBeenCalledWith('cred-1', 'recording');
      expect(mockFetchRecordingBytes.mock.calls[0]![1]).toEqual({
        // No `exactHosts`: exact-or-subdomain of media.plivo.com (PL6 as amended 2026-11-18).
        allowedHosts: ['media.plivo.com'], headers: { Authorization: AUTH },
        maxBytes: CFG.maxRecordingBytes, timeoutMs: CFG.transcribeTimeoutMs, provider: 'plivo',
      });
    });

    it('a revoked credential ends the analysis: failed at once, nothing fetched, no retry', async () => {
      mockWebrtcRepo.findById.mockResolvedValue(plivoCall());
      expect(await runner(credentials('status')).run(makeJob())).toBe('failed');
      expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
      expect(mockJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'call-1', 5, 'TRANSCRIPTION_FAILED', expect.stringContaining('credential_unavailable'));
      expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    });

    it('a credential revoked before the audio re-fetch of a resumed run ends it too', async () => {
      mockWebrtcRepo.findById.mockResolvedValue(plivoCall({
        conversation_log: [{ role: 'agent', content: 'prior' }],
        transcript_meta: { provider: 'gemini', model: 'm', detected_language: 'en', duration_seconds: 90, turn_count: 1, latency_ms: 1, transcribed_at: new Date().toISOString() },
      }));
      const analysisService = { ...makeAnalysisService(), needsAudio: true };
      expect(await runner(credentials('status'), analysisService).run(makeJob())).toBe('failed');
      expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
      expect(analysisService.analyze).not.toHaveBeenCalled();
    });

    it('a Plivo call with no pinned credential fails without asking the store (no fallback, B20)', async () => {
      mockWebrtcRepo.findById.mockResolvedValue(plivoCall({ telephony_credential_id: null }));
      const creds = credentials();
      expect(await runner(creds).run(makeJob())).toBe('failed');
      expect(creds.resolve).not.toHaveBeenCalled();
      expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
    });

    it('a refused access counts access_refused; an access that throws (not a refusal) counts access_error (RC3)', async () => {
      mockWebrtcRepo.findById.mockResolvedValue(plivoCall());
      mockTrackRecordingFetchFailure.mockClear();
      await runner(credentials('status')).run(makeJob());
      expect(mockTrackRecordingFetchFailure).toHaveBeenCalledWith('plivo', 'analysis', 'access_refused');

      mockTrackRecordingFetchFailure.mockClear();
      const broken = new DialerAnalysisRunner({
        transcriber: makeTranscriber() as never, analysisService: makeAnalysisService() as never, config: CFG,
        resolveRecordingAccess: vi.fn().mockRejectedValue(new Error('connection terminated unexpectedly')),
      });
      await broken.run(makeJob());
      expect(mockTrackRecordingFetchFailure).toHaveBeenCalledWith('plivo', 'analysis', 'access_error');
      expect(mockTrackRecordingFetchFailure).toHaveBeenCalledOnce();
      expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
    });

    it('a keyring fault (unopenable) is retried, not failed: an operator can fix it', async () => {
      mockWebrtcRepo.findById.mockResolvedValue(plivoCall());
      expect(await runner(credentials('unopenable')).run(makeJob())).toBe('retry');
      expect(mockJobRepo.requeueForRetry).toHaveBeenCalledOnce();
      expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
    });
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

  it('audio analysis: the recording fetched for transcription is handed to analyze, with no second fetch', async () => {
    const analysisService = { ...makeAnalysisService(), needsAudio: true };
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob());

    expect(mockFetchRecordingBytes).toHaveBeenCalledOnce();
    expect(analysisService.analyze.mock.calls[0]![3]).toMatchObject({
      audio: { bytes: Buffer.from('audio'), mimeType: 'audio/wav' },
    });
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
  });

  it('audio analysis on RESUME: fetches the recording again (same allow-list), still skips transcription', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({
      conversation_log: [{ role: 'agent', content: 'prior' }],
      transcript_meta: { provider: 'gemini', model: 'gemini-2.5-flash', detected_language: 'English', duration_seconds: 90, turn_count: 1, latency_ms: 10, transcribed_at: new Date().toISOString() },
    }));
    const transcriber = makeTranscriber();
    const analysisService = { ...makeAnalysisService(), needsAudio: true };
    const runner = new DialerAnalysisRunner({
      transcriber: transcriber as never, analysisService: analysisService as never, config: CFG, recordingHosts: ['rec'],
    });

    await runner.run(makeJob());

    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(mockFetchRecordingBytes).toHaveBeenCalledOnce();
    expect(mockFetchRecordingBytes.mock.calls[0]![0]).toBe('https://rec/call-1.wav');
    expect(mockFetchRecordingBytes.mock.calls[0]![1]).toEqual({
      allowedHosts: ['rec'], maxBytes: CFG.maxRecordingBytes, timeoutMs: CFG.transcribeTimeoutMs, provider: 'voicelink',
    });
    expect(analysisService.analyze.mock.calls[0]![3]).toHaveProperty('audio');
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
  });

  // The audio and the transcript must be the same file.
  it('audio analysis on RESUME: refetches the URL the transcript was made from', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({
      conversation_log: [{ role: 'agent', content: 'prior' }],
      transcript_meta: {
        provider: 'gemini', model: 'gemini-2.5-flash', detected_language: 'English', duration_seconds: 90,
        turn_count: 1, latency_ms: 10, transcribed_at: new Date().toISOString(), source_url: 'https://rec/first.wav',
      },
    }));
    const analysisService = { ...makeAnalysisService(), needsAudio: true };
    await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG }).run(makeJob());

    expect(mockFetchRecordingBytes.mock.calls[0]![0]).toBe('https://rec/first.wav');
  });

  it('audio analysis on RESUME: abandons when the claim is fenced out during the refetch', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({
      conversation_log: [{ role: 'agent', content: 'prior' }],
      transcript_meta: { provider: 'gemini', model: 'gemini-2.5-flash', detected_language: 'English', duration_seconds: 90, turn_count: 1, latency_ms: 10, transcribed_at: new Date().toISOString() },
    }));
    mockJobRepo.heartbeat
      .mockResolvedValueOnce(true)   // after markAnalyzing
      .mockResolvedValueOnce(false); // after the refetch
    const analysisService = { ...makeAnalysisService(), needsAudio: true };
    await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG }).run(makeJob());

    expect(mockFetchRecordingBytes).toHaveBeenCalledOnce();
    expect(analysisService.analyze).not.toHaveBeenCalled();
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('a slow analysis heartbeats the claim, and a fenced heartbeat abandons the run', async () => {
    const analysisService = {
      analyze: vi.fn().mockImplementation(async (_id, _log, _cfg, opts: { heartbeat: () => Promise<void> }) => {
        await opts.heartbeat();
        mockJobRepo.heartbeat.mockResolvedValueOnce(false);
        await opts.heartbeat();
        return analysisResult();
      }),
    };
    await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG }).run(makeJob());

    expect(mockJobRepo.heartbeat).toHaveBeenLastCalledWith('job-1', 5);
    expect(mockJobRepo.completeWithAnalysis).not.toHaveBeenCalled();
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('transcript analysis (the default) is never handed the recording', async () => {
    const analysisService = makeAnalysisService();
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob());

    expect(analysisService.analyze.mock.calls[0]![3]).not.toHaveProperty('audio');
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
    // First fetch is truncated (40s of 100s), second returns the full (longer) recording.
    fetchReturns('short audio', 'the whole recording');
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
    // The second transcription was of the re-fetched (different) audio.
    expect((transcribe.mock.calls[1]![0] as { audio: Buffer }).audio.toString()).toBe('the whole recording');
    // The retry is transparent: the job completes normally and never burns an attempt.
    expect(mockJobRepo.persistTranscript).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('re-transcribes IDENTICAL audio once when its first transcript came back short, and succeeds (a transcriber miss, TR1)', async () => {
    const cfg = { ...CFG, recordingFetchRetries: 2, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig;
    // The file is complete and every fetch returns the same bytes, but the first
    // transcript stops at 40 s of 100 s (an early stop, squeezed timestamps). The second
    // transcription of the very same bytes covers the call.
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

    expect(await runner.run(makeJob({ attempts: 1 }))).toBe('completed');

    expect(mockFetchRecordingBytes).toHaveBeenCalledTimes(2);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect((transcribe.mock.calls[0]![0] as { audio: Buffer }).audio.toString()).toBe('audio');
    expect((transcribe.mock.calls[1]![0] as { audio: Buffer }).audio.toString()).toBe('audio');
    expect(mockJobRepo.persistTranscript).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.persistTranscript.mock.calls[0]![3].conversation_log).toEqual([
      { role: 'agent', content: 'full call', start_seconds: 0, end_seconds: 98 },
    ]);
    expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledTimes(1);
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('gives up as retryable AUDIO_TOO_SHORT once the in-attempt re-fetches are exhausted', async () => {
    const cfg = { ...CFG, recordingFetchRetries: 2, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig;
    // Always truncated — the carrier is still writing (each fetch differs) but never
    // finishes within the retry window, so every fetch is new audio and transcribed.
    fetchReturns('audio 1', 'audio 12', 'audio 123');
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
    // Still retryable — the job backs off and tries again later, not terminal. The
    // message carries the last audio transcribed (found short once), for the next attempt.
    expect(mockJobRepo.requeueForRetry).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'AUDIO_TOO_SHORT', expect.any(String));
    expect(truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: mockJobRepo.requeueForRetry.mock.calls[0]![4] }))
      .toEqual({ ...fingerprint('audio 123'), coveredSeconds: 40, shortCount: 1 });
  });

  // ── identical audio: transcribed at most twice per job (TR1) ───────────────
  // A transcription is paid for. Identical audio found short once is transcribed once
  // more (the transcriber may have missed on a complete file); once found short twice
  // (in this attempt or the job's earlier ones) it is not transcribed again.

  describe('a re-fetch that returns audio already found truncated', () => {
    const SHORT = {
      entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 40 }],
      detectedLanguage: 'English', durationSeconds: 40, model: 'gemini-2.5-flash', diarizationFailed: false,
    };
    const FULL = {
      entries: [{ role: 'agent', content: 'full call', start_seconds: 0, end_seconds: 98 }],
      detectedLanguage: 'English', durationSeconds: 98, model: 'gemini-2.5-flash', diarizationFailed: false,
    };
    const retries = (n: number) => ({ ...CFG, recordingFetchRetries: n, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig);
    const runner = (transcribe: ReturnType<typeof vi.fn>, cfg: DialerAnalysisConfig) => new DialerAnalysisRunner({
      transcriber: makeTranscriber({ transcribe }) as never,
      analysisService: makeAnalysisService() as never,
      config: cfg,
    });
    /** The job as its previous attempt left it: requeued AUDIO_TOO_SHORT with that audio's fingerprint and count. */
    const requeuedShort = (body: string, shortCount: number, coveredSeconds = 40) => makeJob({
      attempts: 2,
      error_code: 'AUDIO_TOO_SHORT',
      error_message: `transcribed 40s of an expected 100s recording after 2 re-fetch(es) (likely a truncated fetch) ${formatTruncatedAudio({ ...fingerprint(body), coveredSeconds, shortCount })}`,
    });
    /** The tag the requeue just wrote, read back as the next attempt reads it. */
    const requeuedTag = () => truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: mockJobRepo.requeueForRetry.mock.calls[0]![4] });

    it('is transcribed twice, then not again: every later re-fetch skipped, still a retryable AUDIO_TOO_SHORT', async () => {
      // The default fetch returns the same bytes every time: the file is not changing.
      const transcribe = vi.fn().mockResolvedValue(SHORT);

      expect(await runner(transcribe, retries(3)).run(makeJob({ attempts: 1 }))).toBe('retry');

      expect(mockFetchRecordingBytes).toHaveBeenCalledTimes(4); // initial + 3 re-fetches
      expect(transcribe).toHaveBeenCalledTimes(2); // the 3rd and 4th fetches were skipped
      expect(mockJobRepo.persistTranscript).not.toHaveBeenCalled();
      expect(mockJobRepo.requeueForRetry).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'AUDIO_TOO_SHORT', expect.any(String));
      expect(requeuedTag()).toEqual({ ...fingerprint('audio'), coveredSeconds: 40, shortCount: 2 });
      expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
    });

    it('a re-fetch of longer audio after skipped identical ones is still transcribed, and succeeds', async () => {
      fetchReturns('short audio', 'short audio', 'short audio', 'the whole recording');
      const transcribe = vi.fn().mockResolvedValueOnce(SHORT).mockResolvedValueOnce(SHORT).mockResolvedValueOnce(FULL);

      expect(await runner(transcribe, retries(3)).run(makeJob({ attempts: 1 }))).toBe('completed');

      expect(mockFetchRecordingBytes).toHaveBeenCalledTimes(4);
      expect(transcribe).toHaveBeenCalledTimes(3); // the third identical fetch was skipped
      expect((transcribe.mock.calls[2]![0] as { audio: Buffer }).audio.toString()).toBe('the whole recording');
      expect(mockJobRepo.persistTranscript).toHaveBeenCalledOnce();
      expect(mockJobRepo.persistTranscript.mock.calls[0]![3].conversation_log).toEqual(FULL.entries);
      expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
      expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    });

    it('across attempts: the count rides in the requeue, so an unchanged file is transcribed twice per job, the final attempt included', async () => {
      // No in-attempt re-fetch: each attempt fetches once, and gets the same bytes.
      const transcribe = vi.fn().mockResolvedValue(SHORT);

      // Attempt 1: transcribed, short once.
      expect(await runner(transcribe, retries(0)).run(makeJob({ attempts: 1 }))).toBe('retry');
      const first = mockJobRepo.requeueForRetry.mock.calls[0]![4] as string;
      expect(requeuedTag()).toEqual({ ...fingerprint('audio'), coveredSeconds: 40, shortCount: 1 });

      // Attempt 2: the same bytes, found short once, are transcribed once more; short twice.
      vi.clearAllMocks();
      expect(await runner(transcribe, retries(0)).run(makeJob({ attempts: 2, error_code: 'AUDIO_TOO_SHORT', error_message: first }))).toBe('retry');
      expect(transcribe).toHaveBeenCalledOnce();
      const second = mockJobRepo.requeueForRetry.mock.calls[0]![4] as string;
      expect(requeuedTag()).toEqual({ ...fingerprint('audio'), coveredSeconds: 40, shortCount: 2 });

      // Attempt 3, the last: not transcribed; the job fails as before.
      vi.clearAllMocks();
      expect(await runner(transcribe, retries(0)).run(makeJob({ attempts: 3, error_code: 'AUDIO_TOO_SHORT', error_message: second }))).toBe('failed');
      expect(mockFetchRecordingBytes).toHaveBeenCalledOnce();
      expect(transcribe).not.toHaveBeenCalled();
      expect(mockJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'call-1', 5, 'AUDIO_TOO_SHORT', expect.any(String));
      expect(truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: mockJobRepo.markFailed.mock.calls[0]![4] }))
        .toEqual({ ...fingerprint('audio'), coveredSeconds: 40, shortCount: 2 });
    });

    it('across attempts: audio the previous attempt found short once is transcribed again, and a complete transcript completes the job', async () => {
      const transcribe = vi.fn().mockResolvedValue(FULL);

      expect(await runner(transcribe, retries(0)).run(requeuedShort('audio', 1))).toBe('completed');
      expect(transcribe).toHaveBeenCalledOnce();
      expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
    });

    it('the next attempt does not transcribe audio found short twice, on every re-fetch and on the last attempt', async () => {
      const transcribe = vi.fn().mockResolvedValue(FULL);

      // No in-attempt re-fetch: one fetch, the same bytes earlier attempts found short twice.
      expect(await runner(transcribe, retries(0)).run(requeuedShort('audio', 2))).toBe('retry');
      expect(transcribe).not.toHaveBeenCalled();
      // Requeued as before (an attempt used; rate limits are not involved), the fingerprint and count kept.
      expect(mockJobRepo.requeueForRetry).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'AUDIO_TOO_SHORT', expect.any(String));
      expect(requeuedTag()).toEqual({ ...fingerprint('audio'), coveredSeconds: 40, shortCount: 2 });

      // With re-fetches: every one is skipped while the file stays the same.
      vi.clearAllMocks();
      expect(await runner(transcribe, retries(2)).run(requeuedShort('audio', 2))).toBe('retry');
      expect(mockFetchRecordingBytes).toHaveBeenCalledTimes(3);
      expect(transcribe).not.toHaveBeenCalled();

      // The last attempt fails the job as before, still without a transcription.
      vi.clearAllMocks();
      expect(await runner(transcribe, retries(2)).run({ ...requeuedShort('audio', 2), attempts: 3 })).toBe('failed');
      expect(transcribe).not.toHaveBeenCalled();
      expect(mockJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'call-1', 5, 'AUDIO_TOO_SHORT', expect.any(String));
    });

    it('the next attempt transcribes audio that changed since, and completes', async () => {
      fetchReturns('the whole recording');
      const transcribe = vi.fn().mockResolvedValue(FULL);

      expect(await runner(transcribe, retries(2)).run(requeuedShort('short audio', 2))).toBe('completed');

      expect(mockFetchRecordingBytes).toHaveBeenCalledOnce();
      expect(transcribe).toHaveBeenCalledOnce();
      expect(mockJobRepo.completeWithAnalysis).toHaveBeenCalledOnce();
    });

    it('different audio found short starts its own count: transcribed twice before it is skipped', async () => {
      // The previous attempt found other bytes short twice; this attempt's file differs.
      const transcribe = vi.fn().mockResolvedValue(SHORT);

      expect(await runner(transcribe, retries(2)).run(requeuedShort('older audio', 2))).toBe('retry');
      expect(mockFetchRecordingBytes).toHaveBeenCalledTimes(3);
      expect(transcribe).toHaveBeenCalledTimes(2);
      expect(requeuedTag()).toEqual({ ...fingerprint('audio'), coveredSeconds: 40, shortCount: 2 });
    });

    it("the previous attempt's audio is transcribed again when the call's duration no longer finds it short", async () => {
      // 40 s covered: short of 100 s, not of 45 s (the carrier corrected the duration).
      mockWebrtcRepo.findById.mockResolvedValue(makeCall({ recording_duration_seconds: 45 }));
      const transcribe = vi.fn().mockResolvedValue(SHORT);

      expect(await runner(transcribe, retries(0)).run(requeuedShort('audio', 2))).toBe('completed');
      expect(transcribe).toHaveBeenCalledOnce();
    });

    it('a fingerprint under any other error code is not read: a rate limit or a manual retry since then transcribes', async () => {
      const transcribe = vi.fn().mockResolvedValue(FULL);
      const job = { ...requeuedShort('audio', 2), error_code: 'RATE_LIMITED' };

      expect(await runner(transcribe, retries(0)).run(job)).toBe('completed');
      expect(transcribe).toHaveBeenCalledOnce();
    });
  });

  describe('the AUDIO_TOO_SHORT tag (formatTruncatedAudio, truncatedAudioOf)', () => {
    const sha = 'a'.repeat(64);

    it('round-trips the fingerprint, coverage and count at the end of the message', () => {
      const t = { sha256: sha, bytes: 1234, coveredSeconds: 40.25, shortCount: 2 };
      const message = `transcribed 40s of an expected 100s recording ${formatTruncatedAudio(t)}`;
      expect(message.endsWith(`[recording sha256=${sha} bytes=1234 covered=40.3s shortCount=2]`)).toBe(true);
      expect(truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: message }))
        .toEqual({ sha256: sha, bytes: 1234, coveredSeconds: 40.3, shortCount: 2 });
    });

    it('reads a tag written before the count existed as one short transcription', () => {
      const message = `transcribed 40s of an expected 100s recording [recording sha256=${sha} bytes=1234 covered=40s]`;
      expect(truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: message }))
        .toEqual({ sha256: sha, bytes: 1234, coveredSeconds: 40, shortCount: 1 });
    });

    it('reads nothing under another error code, without a message, or without the tag at its end', () => {
      const tagged = `x [recording sha256=${sha} bytes=1 covered=1s shortCount=2]`;
      expect(truncatedAudioOf({ error_code: 'RATE_LIMITED', error_message: tagged })).toBeNull();
      expect(truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: null })).toBeNull();
      expect(truncatedAudioOf({ error_code: 'AUDIO_TOO_SHORT', error_message: `${tagged} trailing` })).toBeNull();
    });
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

  it('uses the SNAPSHOT dimensions/context, never a live profile lookup', async () => {
    const analysisService = makeAnalysisService();
    const snapshot = { context: 'renewals', custom_dimensions: [{ key: 'renewed', description: 'd', type: 'boolean' as const }], language_hint: 'hi-IN' };
    const runner = new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG });

    await runner.run(makeJob({ profile_snapshot: snapshot }));

    const [, entries, cfg, opts] = analysisService.analyze.mock.calls[0]!;
    expect(cfg).toEqual({ custom_dimensions: snapshot.custom_dimensions });
    expect(opts).toEqual({ context: 'renewals', heartbeat: expect.any(Function) });
    expect(entries.length).toBe(2);
  });

  it('language hint precedence: job.analysis_language wins over snapshot', async () => {
    const transcriber = makeTranscriber();
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob({ analysis_language: 'te-IN', profile_snapshot: { custom_dimensions: [], language_hint: 'en-IN' } }));

    expect(transcriber.transcribe.mock.calls[0]![0].languageHint).toBe('te-IN');
  });

  it('stale claim_generation: persist fence false ⇒ abandon, no analyze/complete', async () => {
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

  it('rate-limited ⇒ requeue without consuming an attempt', async () => {
    const transcriber = makeTranscriber({
      transcribe: vi.fn().mockRejectedValue(new TranscriptionError('RATE_LIMITED', '429')),
    });
    const runner = new DialerAnalysisRunner({ transcriber: transcriber as never, analysisService: makeAnalysisService() as never, config: CFG });

    await runner.run(makeJob());

    expect(mockJobRepo.requeueRateLimited).toHaveBeenCalledOnce();
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it('an AI-layer rate limit during analysis ⇒ requeue without consuming an attempt', async () => {
    const analysisService = { analyze: vi.fn().mockRejectedValue(new AiError('rate_limited', 'gemini', '429', 429)) };
    await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG }).run(makeJob());

    expect(mockJobRepo.requeueRateLimited).toHaveBeenCalledOnce();
    expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    expect(mockJobRepo.markFailed).not.toHaveBeenCalled();
  });

  it.each(['unsupported_input', 'unsupported_operation', 'invalid_config'] as const)(
    'an AI-layer %s error during analysis ⇒ failed immediately',
    async (kind) => {
      const analysisService = { analyze: vi.fn().mockRejectedValue(new AiError(kind, 'gemini', 'no')) };
      await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG }).run(makeJob({ attempts: 1 }));

      expect(mockJobRepo.markFailed).toHaveBeenCalledWith('job-1', 'call-1', 5, 'ANALYSIS_FAILED', 'no');
      expect(mockJobRepo.requeueForRetry).not.toHaveBeenCalled();
    },
  );

  it('an AI-layer request_failed during analysis is retried as usual', async () => {
    const analysisService = { analyze: vi.fn().mockRejectedValue(new AiError('request_failed', 'gemini', '500', 500)) };
    await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG }).run(makeJob({ attempts: 1 }));

    expect(mockJobRepo.requeueForRetry).toHaveBeenCalledOnce();
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

    // Never throws: it requeues and reports a retry.
    await expect(runner.run(makeJob())).resolves.toBe('retry');
  });
});

describe('DialerAnalysisRunner outcome, recording lease and rate-limit pause', () => {
  const runnerWith = (over: { transcriber?: unknown; analysisService?: unknown; config?: DialerAnalysisConfig } = {}) =>
    new DialerAnalysisRunner({
      transcriber: (over.transcriber ?? makeTranscriber()) as never,
      analysisService: (over.analysisService ?? makeAnalysisService()) as never,
      config: over.config ?? CFG,
    });

  it('reports how each run ended', async () => {
    expect(await runnerWith().run(makeJob())).toBe('completed');

    mockWebrtcRepo.findById.mockResolvedValueOnce(makeCall({ recording_url: null }));
    expect(await runnerWith().run(makeJob())).toBe('skipped');

    mockJobRepo.persistTranscript.mockResolvedValueOnce(false);
    expect(await runnerWith().run(makeJob())).toBe('abandoned');

    const failing = makeTranscriber({ transcribe: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await runnerWith({ transcriber: failing }).run(makeJob({ attempts: 1 }))).toBe('retry');
    expect(await runnerWith({ transcriber: failing }).run(makeJob({ attempts: 3 }))).toBe('failed');

    const limited = makeTranscriber({ transcribe: vi.fn().mockRejectedValue(new TranscriptionError('RATE_LIMITED', '429')) });
    expect(await runnerWith({ transcriber: limited }).run(makeJob())).toBe('rate_limited');
  });

  it('transcript analysis: the lease shrinks to the recording once fetched, and to zero once transcribed', async () => {
    const budget = new RecordingByteBudget(1000 * 1024 * 1024);
    const lease = budget.tryAcquire(CFG.maxRecordingBytes * 2)!;
    const seen: number[] = [];
    const transcriber = makeTranscriber();
    transcriber.transcribe.mockImplementationOnce(async (...args: unknown[]) => {
      seen.push(lease.bytes);
      return (makeTranscriber().transcribe as (...a: unknown[]) => unknown)(...args);
    });
    const analysisService = { analyze: vi.fn(async () => { seen.push(lease.bytes); return analysisResult(); }) };

    expect(await runnerWith({ transcriber, analysisService }).run(makeJob(), { lease })).toBe('completed');
    // 'audio' is 5 bytes: two copies while it is transcribed, nothing while the transcript is analysed.
    expect(seen).toEqual([10, 0]);
  });

  it('audio analysis: the lease keeps the recording until the analysis has it', async () => {
    const budget = new RecordingByteBudget(1000 * 1024 * 1024);
    const lease = budget.tryAcquire(CFG.maxRecordingBytes * 2)!;
    let atAnalyze = -1;
    const analysisService = { needsAudio: true, analyze: vi.fn(async () => { atAnalyze = lease.bytes; return analysisResult(); }) };
    await runnerWith({ analysisService }).run(makeJob(), { lease });
    expect(atAnalyze).toBe(10);
  });

  it('a transcript-only RESUME gives the whole reservation back at once', async () => {
    mockWebrtcRepo.findById.mockResolvedValue(makeCall({
      conversation_log: [{ role: 'agent', content: 'x', start_seconds: 0, end_seconds: 90 }],
      transcript_meta: { provider: 'gemini', model: 'm', detected_language: 'en', duration_seconds: 90, turn_count: 1, latency_ms: 1, transcribed_at: new Date().toISOString() },
    }));
    const budget = new RecordingByteBudget(1000 * 1024 * 1024);
    const lease = budget.tryAcquire(CFG.maxRecordingBytes * 2)!;
    let atAnalyze = -1;
    const analysisService = { analyze: vi.fn(async () => { atAnalyze = lease.bytes; return analysisResult(); }) };
    await runnerWith({ analysisService }).run(makeJob(), { lease });
    expect(atAnalyze).toBe(0);
    expect(mockFetchRecordingBytes).not.toHaveBeenCalled();
  });

  it('a truncated-recording re-fetch takes the worst case again before fetching', async () => {
    const cfg = { ...CFG, recordingFetchRetries: 1, recordingFetchRetryDelaySeconds: 0 } as DialerAnalysisConfig;
    const budget = new RecordingByteBudget(1000 * 1024 * 1024);
    const lease = budget.tryAcquire(cfg.maxRecordingBytes * 2)!;
    const atFetch: number[] = [];
    // The re-fetch returns the longer, finished file.
    const bodies = ['audio', 'audio, all of it'];
    mockFetchRecordingBytes.mockImplementation(async () => {
      atFetch.push(lease.bytes);
      return { bytes: Buffer.from(bodies[atFetch.length - 1]!), mimeType: 'audio/wav' };
    });
    const transcribe = vi.fn()
      .mockResolvedValueOnce({ entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 40 }], detectedLanguage: 'en', durationSeconds: 40, model: 'm', diarizationFailed: false })
      .mockResolvedValueOnce({ entries: [{ role: 'agent', content: 'all', start_seconds: 0, end_seconds: 98 }], detectedLanguage: 'en', durationSeconds: 98, model: 'm', diarizationFailed: false });
    try {
      expect(await runnerWith({ transcriber: makeTranscriber({ transcribe }), config: cfg }).run(makeJob(), { lease })).toBe('completed');
    } finally {
      mockFetchRecordingBytes.mockReset();
      mockFetchRecordingBytes.mockResolvedValue({ bytes: Buffer.from('audio'), mimeType: 'audio/wav' });
    }
    expect(atFetch).toEqual([cfg.maxRecordingBytes * 2, cfg.maxRecordingBytes * 2]);
  });

  it('a rate-limited job is requeued no earlier than the shared pause', async () => {
    const limited = makeTranscriber({ transcribe: vi.fn().mockRejectedValue(new TranscriptionError('RATE_LIMITED', '429')) });
    const onRateLimited = vi.fn(() => 900);
    await runnerWith({ transcriber: limited }).run(makeJob({ attempts: 1 }), { onRateLimited });
    expect(onRateLimited).toHaveBeenCalledOnce();
    // Its own backoff would be ~120 s (60 × 2^1); the pause wins.
    expect(mockJobRepo.requeueRateLimited).toHaveBeenCalledWith('job-1', 5, 900, 'rate-limited (transcribe): 429');
  });

  it('without a pause the job keeps its own rate-limit backoff', async () => {
    const limited = makeTranscriber({ transcribe: vi.fn().mockRejectedValue(new TranscriptionError('RATE_LIMITED', '429')) });
    await runnerWith({ transcriber: limited }).run(makeJob({ attempts: 1 }), { onRateLimited: () => 0 });
    const backoff = mockJobRepo.requeueRateLimited.mock.calls[0]![2] as number;
    expect(backoff).toBeGreaterThanOrEqual(108);
    expect(backoff).toBeLessThanOrEqual(132);
  });

  it('hands the breaker what the vendor said, from the transcriber\'s error', async () => {
    const refused = new TranscriptionError('RATE_LIMITED', 'Gemini transcription failed: {…}', true, {
      provider: 'gemini',
      status: 429,
      rateLimit: {
        vendorCode: 'RESOURCE_EXHAUSTED',
        quotaIds: ['GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'GenerateRequestsPerMinutePerProjectPerModel'],
        retryAfterSeconds: 36,
        vendorMessage: 'You exceeded your current quota',
      },
    });
    const limited = makeTranscriber({ transcribe: vi.fn().mockRejectedValue(refused) });
    const onRateLimited = vi.fn(() => 30);
    await runnerWith({ transcriber: limited }).run(makeJob({ attempts: 1 }), { onRateLimited });
    expect(onRateLimited).toHaveBeenCalledWith({
      stage: 'transcribe',
      vendor: 'gemini',
      vendorStatus: 429,
      vendorCode: 'RESOURCE_EXHAUSTED',
      quotaIds: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier,GenerateRequestsPerMinutePerProjectPerModel',
      vendorRetryAfterSeconds: 36,
      vendorReason: 'You exceeded your current quota',
    });
    expect(mockJobRepo.requeueRateLimited).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'rate-limited (transcribe, gemini): You exceeded your current quota');
  });

  it('names the analysis stage when the analysis call is the one refused', async () => {
    const analysisService = { analyze: vi.fn().mockRejectedValue(new AiError('rate_limited', 'openai_compatible', '429', 429)) };
    const onRateLimited = vi.fn(() => 30);
    await new DialerAnalysisRunner({ transcriber: makeTranscriber() as never, analysisService: analysisService as never, config: CFG })
      .run(makeJob(), { onRateLimited });
    expect(onRateLimited).toHaveBeenCalledWith({ stage: 'analyze', vendor: 'openai_compatible', vendorStatus: 429, vendorReason: '429' });
    // The job row keeps the same reason, for whoever reads the queue.
    expect(mockJobRepo.requeueRateLimited).toHaveBeenCalledWith('job-1', 5, expect.any(Number), 'rate-limited (analyze, openai_compatible): 429');
  });
});

describe('rateLimitCauseOf', () => {
  it('without vendor detail, the reason is the error\'s own message, trimmed to 500 characters', () => {
    expect(rateLimitCauseOf(new TranscriptionError('RATE_LIMITED', 'rate-limited: slow down'), 'transcribe')).toEqual({
      stage: 'transcribe', vendorReason: 'rate-limited: slow down',
    });
    expect(rateLimitCauseOf(new TranscriptionError('RATE_LIMITED', 'x'.repeat(2_000)), 'transcribe').vendorReason).toHaveLength(500);
  });

  it('an AiError without parsed detail still names its provider and status', () => {
    expect(rateLimitCauseOf(new AiError('rate_limited', 'openai_compatible', 'Too many requests', 429), 'analyze')).toEqual({
      stage: 'analyze', vendor: 'openai_compatible', vendorStatus: 429, vendorReason: 'Too many requests',
    });
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
