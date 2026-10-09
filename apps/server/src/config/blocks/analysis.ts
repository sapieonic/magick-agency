import { z } from 'zod';
import { envBoolean, type Env } from '../env.js';

/**
 * Analysis config (decision B4: one config block per area, so blocks never collide):
 * `postCallAnalysis`, `dialerAnalysis`, `voicelinkRecording`, `recordingUrlSigningSecret`
 * and `retention`.
 *  - `voicelinkRecording.allowedHosts`: the allow-list the recording fetcher and playback
 *    proxy enforce; defaults to VoiceLink's recording host when `VOICELINK_RECORDING_HOSTS`
 *    is unset (Manas, 2026-10-09);
 *  - `recordingUrlSigningSecret` is read through config, never straight off `process.env`;
 *  - `retention` has no run-level window: `agencyRetentionDays` is optional and unset
 *    means the row purge does not run (Manas, 2026-10-09: deleting call records is not a
 *    safe default); `agencyTranscriptRetentionDays` defaults to 30 days (Manas,
 *    2026-10-09), so the transcript half runs out of the box;
 *  - `postCallAnalysis.apiKey` falls back to OPENAI_API_KEY / GEMINI_API_KEY.
 */

const postCallAnalysisSchema = z.object({
  enabled: envBoolean.default(true),
  provider: z.enum(['openai', 'gemini', 'azure_openai']).default('openai'),
  apiKey: z.string().optional(),
  model: z.string().default('gpt-4o-mini'),
  timeoutMs: z.coerce.number().default(30000),
  maxConversationTurns: z.coerce.number().default(200),
  azureApiKey: z.string().optional(),
  azureEndpoint: z.string().optional(),
  azureApiVersion: z.string().default('2024-12-01-preview'),
  azureDeployment: z.string().optional(),
});

/**
 * Dialer Call Analysis — post-call transcription + analysis of agency calls.
 * Presence of this block (env `DIALER_ANALYSIS_ENABLED` truthy) activates the
 * worker + transcriber; the `agency_call_analysis` feature flag additionally gates
 * per-tenant availability. A call has no live STT, so the recording is transcribed
 * after the fact, then run through the post-call analysis service.
 */
const dialerAnalysisSchema = z.object({
  enabled: envBoolean.default(false),
  transcriber: z.enum(['gemini', 'sarvam']).default('gemini'),
  /** Gemini model for transcription. 3.5 Flash is GA and supports audio + structured output. */
  geminiModel: z.string().min(1).default('gemini-3.5-flash'),
  /**
   * Dedicated transcriber key. Falls back to GEMINI_API_KEY, but operators SHOULD
   * set a distinct key: a burst of hour-long transcriptions can starve other
   * Gemini use of quota (M4).
   */
  geminiApiKey: z.string().optional(),
  /** Sarvam batch STT key (Indian languages only). Falls back to SARVAM_API_KEY. */
  sarvamApiKey: z.string().optional(),
  /** Per-window transcription request timeout (ms). */
  transcribeTimeoutMs: z.coerce.number().int().min(5000).default(180000),
  /** Time-window size for long-call chunking; each window heartbeats (M9). */
  transcribeWindowSeconds: z.coerce.number().int().min(60).default(600),
  /** Explicit per-window output ceiling. MAX_TOKENS windows are split adaptively. */
  transcribeMaxOutputTokens: z.coerce.number().int().min(1024).max(65536).default(16384),
  /** Hard cap on recording bytes buffered — never buffer unbounded audio (C4). */
  maxRecordingBytes: z.coerce.number().int().min(1024).default(50 * 1024 * 1024),
  /** Below this answered talk-time, a summary is pure hallucination — skip it. */
  minTalkTimeSeconds: z.coerce.number().int().min(0).default(10),
  /** Give the carrier this long to POST the recording URL before `expired`. */
  recordingWaitMinutes: z.coerce.number().int().min(1).default(30),
  /** Provider-call attempt ceiling before terminal `failed` (infra churn excluded). */
  maxAttempts: z.coerce.number().int().min(1).default(3),
  /** Lifetime attempt ceiling incl. manual retries — the "stop mashing Retry" guard. */
  maxAttemptsTotal: z.coerce.number().int().min(1).default(8),
  /** Per-replica concurrent transcriptions (NOT cluster-wide — size accordingly, M4). */
  concurrency: z.coerce.number().int().min(1).default(2),
  /** Worker poll interval when armed (self-dormant when idle). */
  pollIntervalMs: z.coerce.number().int().min(1000).default(60000),
  /** Short settle delay before first fetch — a URL served pre-finalization truncates. */
  settleSeconds: z.coerce.number().int().min(0).default(15),
  /**
   * In-attempt retries when the recording fetch fails or comes back truncated
   * (the carrier's pre-finalization race). The settle delay covers the common case; these
   * cover the tail WITHOUT burning a job attempt, so a carrier that finalizes a few
   * seconds late doesn't consume the `maxAttempts` budget. Each retry waits
   * `recordingFetchRetryDelaySeconds` (doubling). `0` disables.
   */
  recordingFetchRetries: z.coerce.number().int().min(0).max(10).default(2),
  /** Base delay (s) between in-attempt recording-fetch retries; doubles each retry. */
  recordingFetchRetryDelaySeconds: z.coerce.number().int().min(1).default(15),
});

/**
 * The host VoiceLink serves call recordings from, e.g.
 * `https://recording.app.voicelink.co.in/client_1150/2026-10-09/<uuid>.mp3`.
 * Default for `VOICELINK_RECORDING_HOSTS` (Manas, 2026-10-09).
 */
export const DEFAULT_VOICELINK_RECORDING_HOST = 'recording.app.voicelink.co.in';

/**
 * VoiceLink recording hosts the server may fetch from. A recording URL is
 * persisted from the carrier's unauthenticated recording webhook, so it is
 * attacker-reachable: the fetcher and the playback proxy only touch an https URL whose
 * PARSED hostname is exact-or-subdomain of an entry here (`recordingHostMatches`).
 *
 * Manas, 2026-10-09: `VOICELINK_RECORDING_HOSTS` UNSET means VoiceLink's own recording
 * host ({@link DEFAULT_VOICELINK_RECORDING_HOST}); SET means exactly the comma-separated
 * list it holds, so an explicitly EMPTY value (`VOICELINK_RECORDING_HOSTS=`) is the empty
 * list and refuses every recording fetch and playback — fail closed, the operator's
 * lever for turning recording access off.
 */
const voicelinkRecordingSchema = z.object({
  allowedHosts: z.array(z.string().min(1)).default([DEFAULT_VOICELINK_RECORDING_HOST]),
});

const retentionSchema = z.object({
  /** Slack incoming-webhook URL for purge run summaries. Unset = no Slack report. */
  slackWebhookUrl: z.string().url().optional(),
  /** Floor for `agencyRetentionDays` — guards against a fat-fingered env value wiping recent data. */
  minDays: z.coerce.number().int().min(1).default(30),
  /**
   * Agency call-row retention: `agency_calls` rows, their analysis jobs, and the
   * `audit_logs` partitions older than this are purged. Unset = rows are kept.
   */
  agencyRetentionDays: z.coerce.number().int().min(1).optional(),
  /**
   * Agency transcript retention: `conversation_log` / `transcript_meta` are nulled
   * after this many days while `call_analysis` survives to row expiry. Deliberately
   * NOT floored by `minDays`: holding the verbatim transcript for LESS time than the
   * row is the conservative direction.
   *
   * Manas, 2026-10-09: defaults to 30 days. An unset `AGENCY_TRANSCRIPT_RETENTION_DAYS`
   * falls back to `DIALER_TRANSCRIPT_RETENTION_DAYS`, then to 30 (see the env read).
   */
  agencyTranscriptRetentionDays: z.coerce.number().int().min(1).default(30),
  /** How often the purge runs (ms). Default daily. */
  purgeIntervalMs: z.coerce.number().int().min(1000).default(24 * 60 * 60 * 1000),
}).superRefine((data, ctx) => {
  // `AGENCY_RETENTION_DAYS` deletes rows, so it answers to the retention floor
  // (`RETENTION_MIN_DAYS`). Refused at boot rather than clamped.
  if (data.agencyRetentionDays !== undefined && data.agencyRetentionDays < data.minDays) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agencyRetentionDays'],
      message:
        `AGENCY_RETENTION_DAYS (${data.agencyRetentionDays}) must be >= RETENTION_MIN_DAYS `
        + `(${data.minDays})`,
    });
  }
});

export const analysisConfigSchema = z.object({
  postCallAnalysis: postCallAnalysisSchema.default({}),
  dialerAnalysis: dialerAnalysisSchema.optional(),
  voicelinkRecording: voicelinkRecordingSchema.default({}),
  /** HMAC key for signed recording playback URLs (>= 16 chars); else an ephemeral key. */
  recordingUrlSigningSecret: z.string().optional(),
  retention: retentionSchema.default({}),
});

export function readAnalysisEnv(env: Env): Record<string, unknown> {
  const provider = env['POST_CALL_ANALYSIS_PROVIDER'];
  return {
    postCallAnalysis: {
      enabled: env['POST_CALL_ANALYSIS_ENABLED'],
      provider,
      apiKey: env['POST_CALL_ANALYSIS_API_KEY']
        ?? (provider === 'gemini' ? env['GEMINI_API_KEY'] : env['OPENAI_API_KEY']),
      model: env['POST_CALL_ANALYSIS_MODEL'],
      timeoutMs: env['POST_CALL_ANALYSIS_TIMEOUT_MS'],
      maxConversationTurns: env['POST_CALL_ANALYSIS_MAX_TURNS'],
      azureApiKey: env['POST_CALL_ANALYSIS_AZURE_API_KEY'],
      azureEndpoint: env['POST_CALL_ANALYSIS_AZURE_ENDPOINT'],
      azureApiVersion: env['POST_CALL_ANALYSIS_AZURE_API_VERSION'],
      azureDeployment: env['POST_CALL_ANALYSIS_AZURE_DEPLOYMENT'],
    },
    dialerAnalysis: env['DIALER_ANALYSIS_ENABLED'] ? {
      enabled: env['DIALER_ANALYSIS_ENABLED'],
      transcriber: env['DIALER_TRANSCRIBER'],
      geminiModel: env['DIALER_TRANSCRIBE_MODEL'],
      // Dedicated transcriber key, else the shared flat Gemini key (M4: prefer dedicated).
      geminiApiKey: env['DIALER_TRANSCRIBE_API_KEY'] ?? env['GEMINI_API_KEY'],
      sarvamApiKey: env['DIALER_TRANSCRIBE_SARVAM_API_KEY'] ?? env['SARVAM_API_KEY'],
      transcribeTimeoutMs: env['DIALER_TRANSCRIBE_TIMEOUT_MS'],
      transcribeWindowSeconds: env['DIALER_TRANSCRIBE_WINDOW_SECONDS'],
      transcribeMaxOutputTokens: env['DIALER_TRANSCRIBE_MAX_OUTPUT_TOKENS'],
      maxRecordingBytes: env['DIALER_MAX_RECORDING_BYTES'],
      minTalkTimeSeconds: env['DIALER_ANALYSIS_MIN_TALK_TIME_SECONDS'],
      recordingWaitMinutes: env['DIALER_ANALYSIS_RECORDING_WAIT_MINUTES'],
      maxAttempts: env['DIALER_ANALYSIS_MAX_ATTEMPTS'],
      maxAttemptsTotal: env['DIALER_ANALYSIS_MAX_ATTEMPTS_TOTAL'],
      concurrency: env['DIALER_ANALYSIS_CONCURRENCY'],
      pollIntervalMs: env['DIALER_ANALYSIS_POLL_INTERVAL_MS'],
      settleSeconds: env['DIALER_ANALYSIS_SETTLE_SECONDS'],
      recordingFetchRetries: env['DIALER_ANALYSIS_RECORDING_FETCH_RETRIES'],
      recordingFetchRetryDelaySeconds: env['DIALER_ANALYSIS_RECORDING_FETCH_RETRY_DELAY_SECONDS'],
    } : undefined,
    voicelinkRecording: {
      // Unset → the schema default; set (even to '') → exactly the parsed list.
      allowedHosts: env['VOICELINK_RECORDING_HOSTS'] === undefined
        ? undefined
        : env['VOICELINK_RECORDING_HOSTS']
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
    },
    recordingUrlSigningSecret: env['RECORDING_URL_SIGNING_SECRET'],
    retention: {
      slackWebhookUrl: env['RETENTION_SLACK_WEBHOOK_URL'],
      minDays: env['RETENTION_MIN_DAYS'],
      agencyRetentionDays: env['AGENCY_RETENTION_DAYS'],
      // Fallback order: the agency window, else the dialer-wide one, else 30.
      agencyTranscriptRetentionDays: env['AGENCY_TRANSCRIPT_RETENTION_DAYS'] ?? env['DIALER_TRANSCRIPT_RETENTION_DAYS'],
      purgeIntervalMs: env['RETENTION_PURGE_INTERVAL_MS'],
    },
  };
}
