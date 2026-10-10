import { createChildLogger } from '@magick-agency/observability';
import type { DialerSpeakerRole, DialerTranscriptEntry } from '@magick-agency/db/models/agency-call.model';
import { AiError, type AiClient, type AiFile, type AiJsonResponse, type AiJsonSchema, type AiUsage } from '../ai/index.js';
import {
  TranscriptionError,
  type Transcriber,
  type TranscribeProgress,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.js';

const log = createChildLogger({ component: 'gemini-transcriber' });

export interface GeminiTranscriberConfig {
  /** A Gemini client from the AI layer (`ai/`): it does the upload, the requests and the cleanup. */
  client: AiClient;
  /** Time-window size (seconds) for long-call chunking; each window heartbeats. */
  windowSeconds: number;
  /** Explicit per-window generation ceiling; MAX_TOKENS windows split adaptively. */
  maxOutputTokens: number;
}

interface RawTurn {
  speaker?: unknown;
  text?: unknown;
  start_seconds?: unknown;
  end_seconds?: unknown;
}

/**
 * Gemini transcriber (the default). Its shape:
 *
 *  - **Files API upload, never inline base64.** A 10-minute mp3 is ~5 MB; base64
 *    inflates ~33% and Gemini's request limit is ~20 MB. The client uploads, waits
 *    until the file is usable, and owns the SDK (`ai/gemini.client.ts`), including
 *    the model-aware thinking settings a `transcription` request gets.
 *  - **Explicit output ceiling + adaptive split.** A MAX_TOKENS time-window is
 *    bisected until it succeeds or reaches the safe minimum, avoiding identical
 *    job-level retries and truncated JSON.
 *  - **`try/finally` best-effort `files.delete`** — never leave customer call
 *    audio on Google's Files API longer than needed.
 *
 * Diarization is LLM-guessed on a mono recording (the primary path today); when
 * `channelRoles` is present (a dual-channel recording, forward-looking) the
 * transcriber attributes deterministically by channel and skips diarization.
 *
 * Windowing: long calls are chunked by time (`windowSeconds`, default
 * 600), each window's timestamps offset by its start, and the previous window's
 * last two turns carried as context so speaker labels stay consistent across seams.
 */
export class GeminiTranscriber implements Transcriber {
  readonly provider = 'gemini' as const;

  constructor(private readonly cfg: GeminiTranscriberConfig) {}

  async transcribe(req: TranscriptionRequest, onProgress?: TranscribeProgress): Promise<TranscriptionResult> {
    const { client } = this.cfg;
    // The client deletes a file that never became usable itself; from here on the
    // handle is ours, and the `finally` deletes the customer audio immediately
    // rather than waiting for Google's automatic expiry.
    const uploaded = await this.upload(req.audio, req.mimeType);
    try {
      const schema = TURNS_SCHEMA;
      const useChannels = req.channelRoles && Object.keys(req.channelRoles).length > 0;
      const entries: DialerTranscriptEntry[] = [];
      let detectedLanguage = '';

      // A mutable queue lets a dense MAX_TOKENS window be bisected in place while
      // preserving chronological order and speaker-label context at each seam.
      const windows = planWindows(req.expectedDurationSeconds, this.cfg.windowSeconds);
      const pending = [...windows];
      let completedWindows = 0;
      let requestCount = 0;
      // Every planned window gets one request; only a bounded number of additional
      // split/leaf-retry requests is allowed across the whole call.
      const requestCeiling = windows.length + MAX_ADDITIONAL_WINDOW_REQUESTS;

      while (pending.length > 0) {
        const win = pending.shift()!;
        if (requestCount >= requestCeiling) {
          throw new TranscriptionError(
            'TRANSCRIPTION_FAILED',
            `Gemini transcription exceeded the bounded request ceiling (${requestCeiling})`,
            false,
          );
        }
        requestCount++;
        // Carry the previous window's last two turns as textual context so speaker
        // labels stay consistent across the seam.
        const contextTurns = entries.slice(-2);
        const prompt = useChannels
          ? channelPrompt(req.channelRoles!, win, req.languageHint)
          : diarizationPrompt(win, contextTurns, req.languageHint);

        let window: { detectedLanguage: string; entries: DialerTranscriptEntry[] };
        try {
          window = await this.transcribeWindow(
            uploaded,
            schema,
            prompt,
            win.start,
            win.maxOutputTokens ?? this.cfg.maxOutputTokens,
          );
        } catch (err) {
          // A provider response (including MAX_TOKENS) is forward progress for
          // liveness purposes. The runner callback also aborts immediately if this
          // job's generation has been fenced out by another replica.
          if (onProgress) await onProgress(win.start);
          if (err instanceof WindowTooLargeError) {
            const split = splitWindow(win);
            if (split) {
              log.warn(
                { model: client.model, start: win.start, end: win.end, splitAt: split[0].end, ...err.usage },
                'Gemini transcription window hit MAX_TOKENS; splitting and retrying',
              );
              pending.unshift(split[0], split[1]);
              continue;
            }
            if ((win.maxTokenRetries ?? 0) < MAX_LEAF_TOKEN_RETRIES) {
              const escalatedOutputTokens = Math.min(
                (win.maxOutputTokens ?? this.cfg.maxOutputTokens) * 2,
                GEMINI_MAX_OUTPUT_TOKENS,
              );
              log.warn(
                {
                  model: client.model,
                  start: win.start,
                  end: win.end,
                  requestCount,
                  maxOutputTokens: escalatedOutputTokens,
                  ...err.usage,
                },
                'Gemini minimum transcription window hit MAX_TOKENS; retrying once with bounded escalation',
              );
              pending.unshift({
                ...win,
                maxTokenRetries: (win.maxTokenRetries ?? 0) + 1,
                maxOutputTokens: escalatedOutputTokens,
              });
              continue;
            }
            throw new TranscriptionError(
              'TRANSCRIPTION_FAILED',
              `Gemini transcription exhausted the output budget for the smallest allowed ${windowLabel(win)} window` +
                formatUsageSuffix(err.usage),
              false,
            );
          }
          throw err;
        }
        if (!detectedLanguage && window.detectedLanguage) detectedLanguage = window.detectedLanguage;
        entries.push(...window.entries);
        completedWindows++;

        if (onProgress) await onProgress(win.end ?? win.start);
      }

      // diarizationFailed only when we actually got turns and every one is 'unknown'.
      // Deterministic channel attribution is never "failed".
      const diarizationFailed =
        !useChannels && entries.length > 0 && entries.every((e) => e.role === 'unknown');

      const durationSeconds = entries.reduce(
        (max, e) => Math.max(max, e.end_seconds ?? e.start_seconds ?? 0),
        req.expectedDurationSeconds ?? 0,
      );

      log.info(
        { turns: entries.length, detectedLanguage, diarizationFailed, windows: completedWindows },
        'Gemini transcription complete',
      );
      return {
        entries,
        detectedLanguage: detectedLanguage || 'unknown',
        durationSeconds,
        model: client.model,
        diarizationFailed,
      };
    } finally {
      try {
        await client.deleteFile(uploaded);
      } catch (err) {
        log.warn({ err, fileName: uploaded.id }, 'Failed to delete Gemini transcription upload');
      }
    }
  }

  /** Upload customer audio and wait until it is usable. The caller owns cleanup once this returns. */
  private async upload(audio: Buffer, mimeType: string): Promise<AiFile> {
    try {
      return await this.cfg.client.uploadFile(audio, mimeType);
    } catch (err) {
      throw toTranscriptionError(err, 'Failed to upload the recording for transcription');
    }
  }

  /** One time-window → diarized turns, timestamps offset by the window start. */
  private async transcribeWindow(
    file: AiFile,
    schema: AiJsonSchema,
    prompt: string,
    windowStart: number,
    maxOutputTokens: number,
  ): Promise<{ detectedLanguage: string; entries: DialerTranscriptEntry[] }> {
    const { client } = this.cfg;
    let resp: AiJsonResponse;
    try {
      resp = await client.generateJson({
        purpose: 'transcription',
        input: [{ type: 'file', file }, { type: 'text', text: prompt }],
        schema,
        // Dropped for Gemini 3.x by the client; thinking is set there per model family.
        temperature: 0,
        maxOutputTokens,
      });
    } catch (err) {
      throw toTranscriptionError(err, 'Gemini transcription request failed');
    }

    const usage = compactUsage(resp.usage);
    const finishReason = resp.providerFinishReason;
    log.info(
      {
        model: client.model,
        modelVersion: resp.modelVersion,
        finishReason,
        finishMessage: resp.finishMessage,
        candidateTokenCount: resp.outputTokenCount,
        promptBlockReason: resp.blockReason,
        promptBlockReasonMessage: resp.blockReasonMessage,
        ...usage,
      },
      'Gemini transcription window response',
    );
    if (resp.finish === 'no_output' || (resp.finish === 'blocked' && finishReason === undefined)) {
      const blocked = resp.finish === 'blocked';
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        blocked
          ? `Gemini blocked the transcription prompt (blockReason=${resp.blockReason}` +
              `${resp.blockReasonMessage ? `, message=${resp.blockReasonMessage}` : ''})`
          : 'Gemini transcription returned no candidates',
        !blocked,
      );
    }
    if (finishReason && finishReason !== 'STOP') {
      if (finishReason === 'MAX_TOKENS') {
        throw new WindowTooLargeError(usage);
      }
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        `Transcription did not complete (finishReason=${finishReason}` +
          `${resp.finishMessage ? `, finishMessage=${resp.finishMessage}` : ''})` +
          formatUsageSuffix(usage),
        !PERMANENT_FINISH_REASONS.has(finishReason),
      );
    }

    const raw = resp.text;
    if (!raw.trim()) {
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        'Gemini transcription returned an empty candidate instead of structured JSON',
      );
    }

    let parsed: { detected_language?: string; turns?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        `Transcription returned invalid JSON: ${(err as Error).message}`,
      );
    }

    if (!Array.isArray(parsed.turns)) {
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        'Gemini transcription JSON did not contain the required turns array',
      );
    }
    const rawTurns = parsed.turns as RawTurn[];
    const entries: DialerTranscriptEntry[] = rawTurns
      .filter((t): t is RawTurn => t !== null && typeof t === 'object' && !Array.isArray(t))
      .map((t) => normalizeTurn(t, windowStart))
      .filter((e): e is DialerTranscriptEntry => e !== null);

    return { detectedLanguage: String(parsed.detected_language ?? ''), entries };
  }
}

/** A time-window: [start, end] seconds. `end` is undefined for the single unbounded window. */
interface Window {
  start: number;
  end?: number;
  /** One bounded retry is allowed once a window can no longer be split safely. */
  maxTokenRetries?: number;
  /** Leaf retry may temporarily raise the configured ceiling, never past Gemini's maximum. */
  maxOutputTokens?: number;
}

/** Below this size a split adds provider churn without meaningful input reduction. */
const MIN_SPLIT_WINDOW_SECONDS = 5;
/** Bound pathological recursive MAX_TOKENS expansion across the whole call. */
const MAX_ADDITIONAL_WINDOW_REQUESTS = 64;
const MAX_LEAF_TOKEN_RETRIES = 1;
const GEMINI_MAX_OUTPUT_TOKENS = 65_536;
const PERMANENT_FINISH_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII']);

interface TokenUsageSnapshot {
  promptTokens?: number;
  candidateTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

/** Internal signal: this time window must be divided before retrying. */
class WindowTooLargeError extends Error {
  constructor(readonly usage: TokenUsageSnapshot) {
    super('Gemini transcription window reached MAX_TOKENS');
    this.name = 'WindowTooLargeError';
  }
}

/** Chunk the call by time. Absent a known duration, transcribe in one unbounded window. */
function planWindows(totalSeconds: number | undefined, windowSeconds: number): Window[] {
  if (!totalSeconds || totalSeconds <= 0 || totalSeconds <= windowSeconds) {
    return [{ start: 0, end: totalSeconds }];
  }
  const windows: Window[] = [];
  for (let start = 0; start < totalSeconds; start += windowSeconds) {
    windows.push({ start, end: Math.min(start + windowSeconds, totalSeconds) });
  }
  return windows;
}

function splitWindow(win: Window): [Window, Window] | null {
  if (win.end === undefined) return null;
  const duration = win.end - win.start;
  // Both children must satisfy the minimum; e.g. a six-second parent must not
  // silently produce two three-second requests.
  if (duration < MIN_SPLIT_WINDOW_SECONDS * 2) return null;
  const mid = win.start + duration / 2;
  return [{ start: win.start, end: mid }, { start: mid, end: win.end }];
}

function windowLabel(win: Window): string {
  return win.end === undefined ? `starting at ${win.start}s` : `${win.start}-${win.end}s`;
}

function compactUsage(usage: AiUsage): TokenUsageSnapshot {
  return {
    ...(usage.inputTokens != null ? { promptTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens != null ? { candidateTokens: usage.outputTokens } : {}),
    ...(usage.thoughtTokens != null ? { thoughtTokens: usage.thoughtTokens } : {}),
    ...(usage.totalTokens != null ? { totalTokens: usage.totalTokens } : {}),
  };
}

function formatUsageSuffix(usage: TokenUsageSnapshot): string {
  const parts = Object.entries(usage).map(([key, value]) => `${key}=${value}`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

/** Normalize one raw model turn, offsetting timestamps into absolute call time. */
function normalizeTurn(t: RawTurn, windowStart: number): DialerTranscriptEntry | null {
  const content = String(t.text ?? '').trim();
  if (!content) return null;
  const role = coerceRole(t.speaker);
  const entry: DialerTranscriptEntry = { role, content };
  const start = Number(t.start_seconds);
  const end = Number(t.end_seconds);
  if (Number.isFinite(start)) entry.start_seconds = windowStart + start;
  if (Number.isFinite(end)) entry.end_seconds = windowStart + end;
  return entry;
}

function coerceRole(raw: unknown): DialerSpeakerRole {
  const s = String(raw ?? '').toLowerCase();
  if (s === 'agent') return 'agent';
  if (s === 'customer') return 'customer';
  return 'unknown';
}

/**
 * The diarization prompt. Getting agent vs. customer backwards
 * inverts every per-speaker insight, so the situation is stated explicitly.
 */
function diarizationPrompt(win: Window, contextTurns: DialerTranscriptEntry[], languageHint?: string): string {
  const lines: string[] = [];
  lines.push(
    'This is a two-party phone call. The agent is the person who placed the call ' +
      '(typically speaks first, identifies themselves or their company, asks questions, ' +
      'and drives the conversation). The customer is the person who answered. Label ' +
      "each turn `agent` or `customer`. If you genuinely cannot tell, use `unknown` — " +
      'do not guess.',
  );
  lines.push('');
  lines.push('Transcribe the spoken turns faithfully. Do NOT summarize, translate, or add commentary.');
  if (languageHint) lines.push(`The primary language is likely "${languageHint}", but transcribe what is actually spoken.`);
  if (win.end !== undefined) {
    lines.push(
      `Transcribe ONLY the portion of this audio from ${win.start} to ${win.end} seconds. ` +
        `Report start_seconds/end_seconds RELATIVE to ${win.start} (i.e. 0 = ${win.start} seconds into the call).`,
    );
  } else {
    lines.push('Report start_seconds/end_seconds as seconds from the beginning of the audio.');
  }
  if (contextTurns.length > 0) {
    lines.push('');
    lines.push('For speaker-label continuity, the immediately preceding turns were:');
    for (const t of contextTurns) lines.push(`- ${t.role}: ${t.content}`);
  }
  lines.push('');
  lines.push('detected_language: the dominant natural language of the conversation (e.g. "English", "Hindi").');
  return lines.join('\n');
}

/**
 * Channel-attribution prompt (forward-looking). When the recording is
 * multi-channel with a known leg per channel, attribution is deterministic —
 * no diarization guessing.
 */
function channelPrompt(channelRoles: Record<number, DialerSpeakerRole>, win: Window, languageHint?: string): string {
  const mapping = Object.entries(channelRoles)
    .map(([ch, role]) => `channel ${ch} = ${role}`)
    .join(', ');
  const lines: string[] = [];
  lines.push(
    `This is a two-party phone call recorded with separate audio channels (${mapping}). ` +
      'Attribute each turn to the role of the channel it was spoken on. Do not guess ' +
      'speakers — use the channel mapping.',
  );
  lines.push('Transcribe the spoken turns faithfully. Do NOT summarize, translate, or add commentary.');
  if (languageHint) lines.push(`The primary language is likely "${languageHint}", but transcribe what is actually spoken.`);
  if (win.end !== undefined) {
    lines.push(
      `Transcribe ONLY the portion from ${win.start} to ${win.end} seconds. ` +
        `Report start_seconds/end_seconds RELATIVE to ${win.start}.`,
    );
  } else {
    lines.push('Report start_seconds/end_seconds as seconds from the beginning of the audio.');
  }
  lines.push('detected_language: the dominant natural language of the conversation.');
  return lines.join('\n');
}

/** The turns schema, as standard JSON Schema (sent as Gemini's `responseJsonSchema`). */
const TURNS_SCHEMA: AiJsonSchema = {
  name: 'transcript_turns',
  schema: {
    type: 'object',
    properties: {
      detected_language: { type: 'string' },
      turns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            speaker: { type: 'string', enum: ['agent', 'customer', 'unknown'] },
            text: { type: 'string' },
            start_seconds: { type: 'number' },
            end_seconds: { type: 'number' },
          },
          required: ['speaker', 'text'],
        },
      },
    },
    required: ['detected_language', 'turns'],
  },
};

/**
 * Map an AI-layer error to a TranscriptionError. Rate limiting is retried with a
 * longer backoff and does NOT consume an attempt; a file the provider could not
 * process is permanent.
 */
function toTranscriptionError(err: unknown, context: string): TranscriptionError {
  if (err instanceof TranscriptionError) return err;
  const message = (err as Error)?.message ?? String(err);
  if (err instanceof AiError) {
    switch (err.kind) {
      case 'rate_limited':
        return new TranscriptionError('RATE_LIMITED', `${context}: ${message}`);
      case 'timeout':
        return new TranscriptionError('TIMEOUT', 'Timed out waiting for the recording to be processed');
      case 'unsupported_input':
        return new TranscriptionError('UNSUPPORTED_AUDIO', 'The recording could not be processed for transcription', false);
      default:
        break;
    }
  }
  return new TranscriptionError('TRANSCRIPTION_FAILED', `${context}: ${message}`);
}
