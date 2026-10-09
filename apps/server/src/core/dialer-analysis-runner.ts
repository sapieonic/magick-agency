/*
 * Reads and writes `agency_calls` through the shared repository. There is no
 * settlement: the job completes with no charge step (decision S6). The recording
 * fetch is gated by the VoiceLink recording-host allow-list. The PostHog /
 * LLM-observability emitters come from `analytics/posthog.ts` and
 * `analytics/llm-observability.ts`.
 */
import type { AppConfig } from '../config/schema.js';
import { dialerAnalysisJobRepository } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { fetchRecordingBytes } from '../transcription/recording-fetcher.js';
import { TranscriptionError, type Transcriber, type TranscriptionResult } from '../transcription/types.js';
import type { PostCallAnalysisService } from '../analysis/index.js';
import type { AnalyticsConfig } from '@magick-agency/db/models/prompt.model';
import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';
import type { ConversationEntry } from '@magick-agency/db/models/conversation-entry.model';
import type {
  DialerTranscriptEntry,
  DialerSpeakerRole,
  TranscriptMeta,
} from '@magick-agency/db/models/agency-call.model';
import type { DialerAnalysisJobRecord } from '@magick-agency/db/models/dialer-analysis-job.model';
import { auditLogger } from '../audit/audit-logger.js';
import { createChildLogger } from '@magick-agency/observability';
import { Traced } from '@magick-agency/observability';
import {
  dialerAnalysisTotal,
  dialerAnalysisDurationSeconds,
  dialerTranscriptionAudioSeconds,
} from '@magick-agency/observability/metrics/analysis';
import {
  trackDialerTranscription,
  trackDialerLlmAnalysis,
} from '../analytics/llm-observability.js';
import { trackDialerCallAnalyzed } from '../analytics/posthog.js';

const log = createChildLogger({ component: 'dialer-analysis-runner' });

/** The resolved (non-optional) dialer-analysis config block. */
export type DialerAnalysisConfig = NonNullable<AppConfig['dialerAnalysis']>;

/** Below this fraction of the DB-reported duration, a fetched recording is treated as truncated. */
const AUDIO_SHORTFALL_RATIO = 0.8;
/** Base backoff (s) for a retryable transcribe/analyze failure — doubled per attempt, capped. */
const RETRY_BACKOFF_BASE_SECONDS = 30;
const RETRY_BACKOFF_CAP_SECONDS = 1800;
/** Rate-limit backoff base (s) — longer, jittered, and does NOT consume an attempt. */
const RATE_LIMIT_BACKOFF_BASE_SECONDS = 60;

/** Internal control-flow signal: another replica/recovery generation owns the job. */
class StaleAnalysisClaimError extends Error {
  constructor(jobId: string, generation: number) {
    super(`Dialer analysis claim was fenced out (job=${jobId}, generation=${generation})`);
    this.name = 'StaleAnalysisClaimError';
  }
}

export interface DialerAnalysisRunnerDeps {
  transcriber: Transcriber;
  analysisService: PostCallAnalysisService;
  config: DialerAnalysisConfig;
  /**
   * VoiceLink recording hosts the fetch may touch (`voicelinkRecording.allowedHosts`).
   * Omitted = empty = every fetch is refused (fail closed).
   */
  recordingHosts?: readonly string[];
}

/**
 * Runs one dialer-analysis job end-to-end: fetch the recording, transcribe it,
 * persist the transcript, analyse it, and complete both tables in one transaction.
 * Every step is generation-fenced via
 * the repository primitives, so a resurrected original runner can't stomp a recovered
 * run's output.
 *
 * `run` **never throws** — the whole body is a try/catch. On error it classifies
 * retryable vs not, applies exponential backoff via the repo's requeue helpers, and
 * only marks the job `failed` when attempts are exhausted or the error is permanent.
 * That containment is what lets the worker loop over a batch of claimed jobs without
 * one failure taking down the sweep.
 */
export class DialerAnalysisRunner {
  private readonly transcriber: Transcriber;
  private readonly analysisService: PostCallAnalysisService;
  private readonly cfg: DialerAnalysisConfig;
  private readonly recordingHosts: readonly string[];

  constructor(deps: DialerAnalysisRunnerDeps) {
    this.transcriber = deps.transcriber;
    this.analysisService = deps.analysisService;
    this.cfg = deps.config;
    this.recordingHosts = deps.recordingHosts ?? [];
  }

  /** The active transcriber's provider. */
  get transcriberProvider(): 'gemini' | 'sarvam' {
    return this.transcriber.provider;
  }

  @Traced('dialer_analysis.run', {
    attrs: (job: DialerAnalysisJobRecord) => ({
      'call.id': job.call_id,
      'analysis.job_id': job.id,
    }),
  })
  async run(job: DialerAnalysisJobRecord): Promise<void> {
    const span = Traced.getSpan(this);
    span?.setAttribute('analysis.transcriber', this.transcriber.provider);
    const { id: jobId, call_id: callId, tenant_id: tenantId, account_id: accountId, claim_generation: generation } = job;

    try {
      // ── 1. Load the call row. ──────────────────────────────────────────────
      const call = await webrtcCallRepository.findById(callId);
      if (!call) {
        await dialerAnalysisJobRepository.markSkipped(jobId, callId, generation, 'CALL_NOT_FOUND', 'call row missing');
        this.countTerminal(tenantId, 'skipped');
        return;
      }
      // Already analysed (a duplicate/reprocessed job) or erased — nothing to do.
      if (call.analysis_status === 'completed' || call.analysis_status === 'deleted') {
        await dialerAnalysisJobRepository.markSkipped(jobId, callId, generation, 'ALREADY_ANALYSED', `analysis_status=${call.analysis_status}`);
        this.countTerminal(tenantId, 'skipped');
        return;
      }
      if (!call.recording_url) {
        await dialerAnalysisJobRepository.markSkipped(jobId, callId, generation, 'NO_RECORDING', 'call has no recording_url');
        this.countTerminal(tenantId, 'skipped');
        return;
      }

      // ── 2. analyticsConfig from the SNAPSHOT (never a live profile lookup). ─
      const snapshot = job.profile_snapshot;
      const analyticsConfig: AnalyticsConfig = { custom_dimensions: snapshot?.custom_dimensions ?? [] };
      const context = snapshot?.context ?? null;

      // Duration the carrier/DB reports — the transcription window plan + cross-check.
      const recordingDurationSeconds = call.recording_duration_seconds ?? call.talk_time_seconds ?? undefined;

      let entries: DialerTranscriptEntry[];
      let transcriberProvider: 'gemini' | 'sarvam';
      let transcriberModel: string;
      let transcriberDurationSeconds: number;

      // ── 3. RESUME: a prior attempt transcribed but analysis failed. Skip 4–7. ──
      const resumed = (call.conversation_log?.length ?? 0) > 0;
      if (resumed) {
        entries = call.conversation_log!;
        transcriberProvider = call.transcript_meta?.provider ?? this.transcriber.provider;
        transcriberModel = call.transcript_meta?.model ?? 'unknown';
        transcriberDurationSeconds = call.transcript_meta?.duration_seconds ?? recordingDurationSeconds ?? 0;
        log.info({ callId, jobId, turns: entries.length }, 'Resuming dialer analysis from persisted transcript');
      } else {
        // ── 4-6. Fetch + transcribe, with bounded in-attempt retries for the
        //   pre-finalization race (a URL served before the carrier finalized the
        //   recording returns TRUNCATED audio). The settle delay covers the common
        //   case; these retries cover the tail without burning a job attempt.
        const transcribeStart = Date.now();
        const result = await this.fetchAndTranscribe({
          callId, jobId, generation,
          recordingUrl: call.recording_url,
          recordingDurationSeconds: recordingDurationSeconds ?? null,
          languageHint: job.analysis_language ?? snapshot?.language_hint ?? undefined,
        });

        // Empty transcript ⇒ a silent / hold-music recording: a legitimate no-op.
        // Skip (do NOT retry) rather than fail.
        if (result.entries.length === 0) {
          await dialerAnalysisJobRepository.markSkipped(jobId, callId, generation, 'TRANSCRIPTION_EMPTY', 'transcript was empty (silent/hold-music recording)');
          this.countTerminal(tenantId, 'skipped');
          return;
        }

        entries = result.entries;
        transcriberProvider = this.transcriber.provider;
        transcriberModel = result.model;
        transcriberDurationSeconds = result.durationSeconds;

        // ── 7. Persist the transcript BEFORE analysis (fenced). A transcript is
        //       valuable on its own; a later analysis failure then resumes cheaply. ─
        const transcriptMeta: TranscriptMeta = {
          provider: this.transcriber.provider,
          model: result.model,
          detected_language: result.detectedLanguage,
          duration_seconds: result.durationSeconds,
          turn_count: result.entries.length,
          latency_ms: Date.now() - transcribeStart,
          transcribed_at: new Date().toISOString(),
          source_url: call.recording_url, // the URL this job actually consumed.
          diarization_failed: result.diarizationFailed,
        };
        const persisted = await dialerAnalysisJobRepository.persistTranscript(jobId, callId, generation, {
          conversation_log: result.entries,
          transcript_meta: transcriptMeta,
        });
        if (!persisted) {
          // Fence rejected — a recovered run owns this job now. Abandon quietly.
          log.warn({ callId, jobId, generation }, 'Transcript persist fenced out (stale claim generation); abandoning run');
          return;
        }

        // Cost-proxy metric — audio actually transcribed.
        dialerTranscriptionAudioSeconds.observe({ transcriber: this.transcriber.provider }, result.durationSeconds);
        // LLM-observability span for the transcription call (metrics-only).
        trackDialerTranscription({
          callId, tenantId, accountId,
          provider: this.transcriber.provider,
          model: result.model,
          latencyMs: transcriptMeta.latency_ms,
          audioSeconds: result.durationSeconds,
        });
      }

      span?.setAttribute('analysis.turns', entries.length);

      // ── 8. transcribing → analyzing (fenced). ────────────────────────────────
      const marked = await dialerAnalysisJobRepository.markAnalyzing(jobId, generation);
      if (!marked) {
        log.warn({ callId, jobId, generation }, 'markAnalyzing fenced out (stale claim generation); abandoning run');
        return;
      }
      await this.assertClaimActive(jobId, generation);

      // ── 9. Analyse (shared, call-type-agnostic service). Context from snapshot. ─
      const analyzeStart = Date.now();
      const analysis: CallAnalysisResult = await this.analysisService.analyze(
        callId,
        toAnalysisEntries(entries),
        analyticsConfig,
        { context },
      );
      this.observeStage('analyze', (Date.now() - analyzeStart) / 1000);

      // ── 10. Complete BOTH tables in one transaction, fenced. ─────────────────
      const analysisAudioSeconds = billableAudioSeconds(recordingDurationSeconds, transcriberDurationSeconds);
      span?.setAttribute('analysis.audio_seconds', analysisAudioSeconds);
      const completed = await dialerAnalysisJobRepository.completeWithAnalysis(jobId, callId, generation, {
        call_analysis: analysis,
        analysis_audio_seconds: analysisAudioSeconds,
      });
      if (!completed) {
        log.warn({ callId, jobId, generation }, 'completeWithAnalysis fenced out (stale claim generation); abandoning run');
        return;
      }

      // ── 11. Metrics · PostHog · audit. ───────────────────────────────────────
      this.countTerminal(tenantId, 'completed');
      trackDialerCallAnalyzed({
        callId, tenantId, accountId,
        transcriber: transcriberProvider,
        provider: call.provider,
        audioSeconds: analysisAudioSeconds,
        turnCount: entries.length,
        diarizationFailed: call.transcript_meta?.diarization_failed,
        analysisProfileId: job.profile_id,
        analysis,
      });
      trackDialerLlmAnalysis({ callId, tenantId, accountId, analysis });
      auditLogger.log({
        callId, tenantId, accountId,
        eventType: 'dialer_call.analysis.completed',
        eventCategory: 'ai',
        severity: 'info',
        eventData: {
          transcriber: transcriberProvider,
          model: transcriberModel,
          audio_seconds: analysisAudioSeconds,
          turns: entries.length,
          sentiment: analysis.common.overall_sentiment.label,
        },
      });

      log.info({ callId, jobId, audioSeconds: analysisAudioSeconds, turns: entries.length }, 'Dialer analysis completed');
    } catch (err) {
      if (err instanceof StaleAnalysisClaimError) {
        // Recovery or graceful shutdown already transferred ownership. Do not
        // requeue/fail/count this stale run; its successor owns the lifecycle.
        log.warn({ callId, jobId, generation }, 'Dialer analysis claim fenced out; abandoning stale run');
        return;
      }
      await this.handleError(job, err).catch((handlerErr) => {
        // Even the failure-handling must not throw out of run().
        log.error({ err: handlerErr, callId, jobId }, 'Dialer analysis error-handler failed');
      });
    }
  }

  /**
   * Fetch the recording and transcribe it, retrying in-attempt on a truncated or
   * failed fetch (the pre-finalization race).
   *
   * A carrier can hand us a `recording_url` a moment before the file is finalized;
   * fetching then returns SHORT audio, which would otherwise be transcribed and
   * analysed as if it were the whole call — a silently wrong summary. The settle
   * delay handles the common case, and these bounded retries handle the tail.
   *
   * They deliberately do NOT consume a job attempt: a carrier finalizing a few
   * seconds late is not a failure of the job, and burning the `maxAttempts` budget
   * on it would push genuinely-retryable work into terminal `failed`. A retryable
   * error that survives the loop is rethrown and handled normally.
   *
   * Every truncation is logged at WARN with the coverage ratio so a systematically
   * late-finalizing carrier is identifiable in Loki (`grep dialer-analysis-runner`
   * + `recordingTruncated`) rather than showing up as mysteriously short summaries.
   */
  private async fetchAndTranscribe(ctx: {
    callId: string;
    jobId: string;
    generation: number;
    recordingUrl: string;
    recordingDurationSeconds: number | null;
    languageHint: string | undefined;
  }): Promise<TranscriptionResult> {
    const {
      callId, jobId, generation, recordingUrl,
      recordingDurationSeconds, languageHint,
    } = ctx;
    // `?? 0` so a config object without the knob still fetches once (never zero times).
    const maxRetries = this.cfg.recordingFetchRetries ?? 0;
    const retryDelaySeconds = this.cfg.recordingFetchRetryDelaySeconds ?? 15;
    let lastTruncation: { covered: number; expected: number } | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Doubling delay — give the carrier time to finalize before re-fetching.
        const delayMs = retryDelaySeconds * 1000 * 2 ** (attempt - 1);
        log.warn({
          callId, jobId, attempt, maxRetries, delayMs,
          coveredSeconds: lastTruncation?.covered,
          expectedSeconds: lastTruncation?.expected,
          recordingTruncated: lastTruncation != null,
        }, 'Re-fetching dialer recording (previous fetch failed or was truncated)');
        await sleep(delayMs);
        await this.assertClaimActive(jobId, generation);
      }

      const fetchStart = Date.now();
      const fetched = await fetchRecordingBytes(recordingUrl, {
        maxBytes: this.cfg.maxRecordingBytes,
        timeoutMs: this.cfg.transcribeTimeoutMs,
        allowedHosts: this.recordingHosts,
      });
      this.observeStage('fetch', (Date.now() - fetchStart) / 1000);

      await this.assertClaimActive(jobId, generation);

      const transcribeStart = Date.now();
      const result: TranscriptionResult = await this.transcriber.transcribe(
        {
          audio: fetched.bytes,
          mimeType: fetched.mimeType,
          languageHint,
          // Mono carrier recording today; forward-looking — no channel map.
          channelRoles: undefined,
          expectedDurationSeconds: recordingDurationSeconds ?? undefined,
        },
        async () => {
          await this.assertClaimActive(jobId, generation);
        },
      );
      this.observeStage('transcribe', (Date.now() - transcribeStart) / 1000);

      // An empty transcript is a legitimate silent recording, not a truncation —
      // hand it back so the caller can `skip` it (retrying would never help).
      if (result.entries.length === 0) return result;

      // Duration cross-check: far less transcribed audio than the DB reports
      // means we very likely fetched a pre-finalization (truncated) file.
      if (recordingDurationSeconds && recordingDurationSeconds > 0) {
        const covered = coveredSeconds(result.entries, result.durationSeconds);
        if (covered < recordingDurationSeconds * AUDIO_SHORTFALL_RATIO) {
          lastTruncation = { covered, expected: recordingDurationSeconds };
          if (attempt < maxRetries) continue;
          // Retries exhausted — surface it as retryable so the job backs off and
          // tries again later (the carrier may still be finalizing).
          log.error({
            callId, jobId, coveredSeconds: covered, expectedSeconds: recordingDurationSeconds,
            coverageRatio: Number((covered / recordingDurationSeconds).toFixed(2)),
            retriesUsed: maxRetries, recordingTruncated: true,
          }, 'Dialer recording still truncated after in-attempt retries');
          throw new TranscriptionError(
            'AUDIO_TOO_SHORT',
            `transcribed ${covered.toFixed(0)}s of an expected ${recordingDurationSeconds}s recording after ${maxRetries} re-fetch(es) (likely a truncated fetch)`,
            true,
          );
        }
      }

      if (attempt > 0) {
        log.info({ callId, jobId, attempt, turns: result.entries.length }, 'Dialer recording re-fetch succeeded');
      }
      return result;
    }

    // Unreachable: the loop either returns or throws.
    throw new TranscriptionError('TRANSCRIPTION_FAILED', 'recording fetch retry loop exited unexpectedly', true);
  }

  /** Refresh liveness and abort immediately when this claim generation lost ownership. */
  private async assertClaimActive(jobId: string, generation: number): Promise<void> {
    const active = await dialerAnalysisJobRepository.heartbeat(jobId, generation);
    if (!active) throw new StaleAnalysisClaimError(jobId, generation);
  }

  /**
   * Classify the error and drive the job to the right next state, never throwing.
   *   - RATE_LIMITED           → requeue WITHOUT consuming an attempt.
   *   - non-retryable          → fail immediately.
   *   - retryable + attempts left → requeue with exponential backoff.
   *   - retryable + exhausted  → fail.
   */
  private async handleError(job: DialerAnalysisJobRecord, err: unknown): Promise<void> {
    const { id: jobId, call_id: callId, tenant_id: tenantId, claim_generation: generation, attempts } = job;
    const isTx = err instanceof TranscriptionError;
    const code = isTx ? (err as TranscriptionError).code : 'ANALYSIS_FAILED';
    const message = err instanceof Error ? err.message : String(err);

    // Rate limit: retry with a longer jittered backoff and DON'T burn an attempt.
    if (isTx && (err as TranscriptionError).code === 'RATE_LIMITED') {
      const backoff = jitter(Math.min(RATE_LIMIT_BACKOFF_BASE_SECONDS * Math.pow(2, attempts), RETRY_BACKOFF_CAP_SECONDS));
      await dialerAnalysisJobRepository.requeueRateLimited(jobId, generation, backoff);
      log.warn({ callId, jobId, backoff }, 'Dialer analysis rate-limited; requeued without consuming an attempt');
      return;
    }

    const retryable = isTx ? (err as TranscriptionError).retryable : true;
    const attemptsExhausted = attempts >= this.cfg.maxAttempts;

    if (!retryable || attemptsExhausted) {
      await dialerAnalysisJobRepository.markFailed(jobId, callId, generation, code, message);
      this.countTerminal(tenantId, 'failed');
      auditLogger.log({
        callId, tenantId, accountId: job.account_id,
        eventType: 'dialer_call.analysis.failed',
        eventCategory: 'ai',
        severity: 'error',
        eventData: { error_code: code, error: message, attempts, retryable, exhausted: attemptsExhausted },
      });
      log.error({ callId, jobId, code, retryable, attempts }, 'Dialer analysis failed (terminal)');
      return;
    }

    const backoff = jitter(Math.min(RETRY_BACKOFF_BASE_SECONDS * Math.pow(2, attempts - 1), RETRY_BACKOFF_CAP_SECONDS));
    await dialerAnalysisJobRepository.requeueForRetry(jobId, generation, backoff, code, message);
    log.warn({ callId, jobId, code, backoff, attempts }, 'Dialer analysis failed; requeued for retry');
  }

  private observeStage(stage: 'fetch' | 'transcribe' | 'analyze', seconds: number): void {
    dialerAnalysisDurationSeconds.observe({ transcriber: this.transcriber.provider, stage }, seconds);
  }

  private countTerminal(tenantId: string, status: string): void {
    const labels = { tenant_id: tenantId, status, transcriber: this.transcriber.provider };
    dialerAnalysisTotal.inc(labels);
  }
}

/** Map dialer roles to the analysis service's assistant/user vocabulary at the boundary. */
export function toAnalysisEntries(entries: DialerTranscriptEntry[]): ConversationEntry[] {
  return entries.map((e) => ({
    role: dialerRoleToAnalysisRole(e.role),
    content: e.content,
    // The prompt builder ignores timestamp; synthesize a stable one from start_seconds.
    timestamp: e.start_seconds != null ? new Date(e.start_seconds * 1000).toISOString() : '',
    ...(e.language ? { language: e.language } : {}),
    ...(e.confidence != null ? { confidence: e.confidence } : {}),
  }));
}

function dialerRoleToAnalysisRole(role: DialerSpeakerRole): ConversationEntry['role'] {
  // agent → assistant, customer → user, unknown → user (analysis speaks assistant/user).
  return role === 'agent' ? 'assistant' : 'user';
}

/** The actual audio span covered by the transcript — a truncation signal. */
function coveredSeconds(entries: DialerTranscriptEntry[], fallback: number): number {
  let max = 0;
  for (const e of entries) {
    const end = e.end_seconds ?? e.start_seconds ?? 0;
    if (end > max) max = end;
  }
  return max > 0 ? max : fallback;
}

/** analysis_audio_seconds = min(recording duration, transcriber-reported duration); recorded, not charged. */
function billableAudioSeconds(recordingDurationSeconds: number | undefined, transcriberDurationSeconds: number): number {
  const t = Math.max(0, Math.round(transcriberDurationSeconds));
  if (recordingDurationSeconds == null || recordingDurationSeconds <= 0) return t;
  return Math.min(Math.round(recordingDurationSeconds), t);
}

/** ±20 % jitter so many retries don't align into a thundering herd. */
function jitter(seconds: number): number {
  return Math.round(seconds * (0.9 + Math.random() * 0.2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
