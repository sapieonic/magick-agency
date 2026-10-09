import { createChildLogger } from '@magick-agency/observability';
import type { DialerSpeakerRole, DialerTranscriptEntry } from '@magick-agency/db/models/agency-call.model';
import {
  TranscriptionError,
  type Transcriber,
  type TranscribeProgress,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.js';

const log = createChildLogger({ component: 'gemini-transcriber' });

export interface GeminiTranscriberConfig {
  apiKey: string;
  model: string;
  /** Per-window transcription request timeout (ms). Also the Files-API poll deadline. */
  timeoutMs: number;
  /** Time-window size (seconds) for long-call chunking; each window heartbeats (M9). */
  windowSeconds: number;
  /** Explicit per-window generation ceiling; MAX_TOKENS windows split adaptively. */
  maxOutputTokens: number;
}

// Minimal structural types for the parts of @google/genai we touch. The package
// is ESM-only, so a TYPE-position `import('@google/genai').X` fails under the
// project's CommonJS compile (TS1542) — the runtime dynamic `import()` is fine.
// These also make the client trivially mockable in unit tests. Lifted verbatim
// from pdf-extractor.ts, the repo's only other Files-API consumer.
interface GenAIFile {
  uri?: string;
  mimeType?: string;
  name?: string;
  state?: unknown;
}
interface GenAIUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}
interface GenAIGenerateResponse {
  text?: string;
  candidates?: Array<{
    finishReason?: unknown;
    finishMessage?: string;
    tokenCount?: number;
    content?: { parts?: Array<{ text?: string }> };
  }>;
  modelVersion?: string;
  usageMetadata?: GenAIUsageMetadata;
  promptFeedback?: {
    blockReason?: unknown;
    blockReasonMessage?: string;
  };
}
interface GenAIClient {
  files: {
    upload(args: { file: Blob; config?: { mimeType?: string } }): Promise<GenAIFile>;
    get(args: { name: string }): Promise<GenAIFile>;
    delete(args: { name: string }): Promise<unknown>;
  };
  models: {
    generateContent(args: unknown): Promise<GenAIGenerateResponse>;
  };
}

interface RawTurn {
  speaker?: unknown;
  text?: unknown;
  start_seconds?: unknown;
  end_seconds?: unknown;
}

/**
 * Gemini transcriber (default, D3). Modelled directly on `src/knowledge/pdf-extractor.ts`
 * — the only existing Files-API consumer — and reuses its proven shape:
 *
 *  - **Files API upload, never inline base64.** A 10-minute mp3 is ~5 MB; base64
 *    inflates ~33% and Gemini's request limit is ~20 MB.
 *  - **Poll until ACTIVE** with a generous deadline (audio processing is slower
 *    than PDF).
 *  - **Dynamic `await import('@google/genai')`** with local structural types.
 *  - **Model-aware thinking.** Gemini 3.x uses `thinkingLevel: MEDIUM` and no
 *    sampling overrides per Google's migration guide; 2.5 uses `thinkingBudget: 0`.
 *  - **Explicit output ceiling + adaptive split.** A MAX_TOKENS time-window is
 *    bisected until it succeeds or reaches the safe minimum, avoiding identical
 *    job-level retries and truncated JSON.
 *  - **`try/finally` best-effort `files.delete`** — never leave customer call
 *    audio on Google's Files API longer than needed.
 *
 * Diarization is LLM-guessed on a mono recording (the primary path today); when
 * `channelRoles` is present (a dual-channel recording, forward-looking M3) the
 * transcriber attributes deterministically by channel and skips diarization.
 *
 * Windowing (spec §6): long calls are chunked by time (`windowSeconds`, default
 * 600), each window's timestamps offset by its start, and the previous window's
 * last two turns carried as context so speaker labels stay consistent across seams.
 */
export class GeminiTranscriber implements Transcriber {
  readonly provider = 'gemini' as const;

  constructor(private readonly cfg: GeminiTranscriberConfig) {}

  async transcribe(req: TranscriptionRequest, onProgress?: TranscribeProgress): Promise<TranscriptionResult> {
    const genai = await import('@google/genai');
    const { GoogleGenAI, createPartFromUri, Type } = genai;
    const ai = new GoogleGenAI({
      apiKey: this.cfg.apiKey,
      httpOptions: { timeout: this.cfg.timeoutMs },
    }) as unknown as GenAIClient;

    let uploaded: GenAIFile | undefined;
    try {
      // Keep the raw uploaded handle in the outer cleanup scope. If Files API
      // processing subsequently times out/fails, the customer audio is still
      // deleted immediately rather than waiting for Google's automatic expiry.
      uploaded = await this.upload(ai, req.audio, req.mimeType);
      const readyFile = await this.waitUntilActive(ai, uploaded, req.mimeType);
      const filePart = createPartFromUri(readyFile.uri, readyFile.mimeType);
      const schema = buildTurnsSchema(Type);
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
            ai,
            filePart,
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
                { model: this.cfg.model, start: win.start, end: win.end, splitAt: split[0].end, ...err.usage },
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
                  model: this.cfg.model,
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
        model: this.cfg.model,
        diarizationFailed,
      };
    } finally {
      if (uploaded?.name) {
        try {
          await ai.files.delete({ name: uploaded.name });
        } catch (err) {
          log.warn({ err, fileName: uploaded.name }, 'Failed to delete Gemini transcription upload');
        }
      }
    }
  }

  /** Upload customer audio. The caller owns cleanup as soon as this succeeds. */
  private async upload(ai: GenAIClient, audio: Buffer, mimeType: string): Promise<GenAIFile> {
    const blob = new Blob([audio], { type: mimeType });
    try {
      return await ai.files.upload({ file: blob, config: { mimeType } });
    } catch (err) {
      throw classifyGeminiError(err, 'Failed to upload recording to Gemini Files API');
    }
  }

  /** Poll an uploaded file until the Files API marks it ACTIVE (or FAILED). */
  private async waitUntilActive(
    ai: GenAIClient,
    uploaded: GenAIFile,
    mimeType: string,
  ): Promise<{ uri: string; mimeType: string }> {
    let file = uploaded;
    const deadline = Date.now() + this.cfg.timeoutMs;
    while (String(file.state) === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new TranscriptionError('TIMEOUT', 'Timed out waiting for the recording to be processed');
      }
      await sleep(1000);
      try {
        file = await ai.files.get({ name: file.name! });
      } catch (err) {
        throw classifyGeminiError(err, 'Failed to poll Gemini Files API');
      }
    }
    if (String(file.state) === 'FAILED' || !file.uri) {
      throw new TranscriptionError('UNSUPPORTED_AUDIO', 'The recording could not be processed for transcription', false);
    }
    return { uri: file.uri, mimeType: file.mimeType ?? mimeType };
  }

  /** One time-window → diarized turns, timestamps offset by the window start. */
  private async transcribeWindow(
    ai: GenAIClient,
    filePart: unknown,
    schema: unknown,
    prompt: string,
    windowStart: number,
    maxOutputTokens: number,
  ): Promise<{ detectedLanguage: string; entries: DialerTranscriptEntry[] }> {
    let resp: GenAIGenerateResponse;
    try {
      resp = await ai.models.generateContent({
        model: this.cfg.model,
        contents: [{ role: 'user', parts: [filePart, { text: prompt }] }],
        config: generationConfig(this.cfg.model, maxOutputTokens, schema),
      });
    } catch (err) {
      throw classifyGeminiError(err, 'Gemini transcription request failed');
    }

    const candidate = resp.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const usage = compactUsage(resp.usageMetadata);
    const blockReason = resp.promptFeedback?.blockReason;
    log.info(
      {
        model: this.cfg.model,
        modelVersion: resp.modelVersion,
        finishReason: finishReason == null ? undefined : String(finishReason),
        finishMessage: candidate?.finishMessage,
        candidateTokenCount: candidate?.tokenCount,
        promptBlockReason: blockReason == null ? undefined : String(blockReason),
        promptBlockReasonMessage: resp.promptFeedback?.blockReasonMessage,
        ...usage,
      },
      'Gemini transcription window response',
    );
    if (!candidate) {
      const blocked = blockReason != null && String(blockReason) !== 'BLOCK_REASON_UNSPECIFIED';
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        blocked
          ? `Gemini blocked the transcription prompt (blockReason=${String(blockReason)}` +
              `${resp.promptFeedback?.blockReasonMessage ? `, message=${resp.promptFeedback.blockReasonMessage}` : ''})`
          : 'Gemini transcription returned no candidates',
        !blocked,
      );
    }
    if (finishReason && String(finishReason) !== 'STOP') {
      if (String(finishReason) === 'MAX_TOKENS') {
        throw new WindowTooLargeError(usage);
      }
      throw new TranscriptionError(
        'TRANSCRIPTION_FAILED',
        `Transcription did not complete (finishReason=${String(finishReason)}` +
          `${candidate?.finishMessage ? `, finishMessage=${candidate.finishMessage}` : ''})` +
          formatUsageSuffix(usage),
        !PERMANENT_FINISH_REASONS.has(String(finishReason)),
      );
    }

    const raw =
      resp.text ??
      candidate?.content?.parts?.map((p) => (p as { text?: string }).text ?? '').join('') ??
      '';
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

/** Gemini 3.x migration-safe config while retaining 2.5 compatibility. */
function generationConfig(model: string, maxOutputTokens: number, schema: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: schema as never,
  };
  const major = Number(/^(?:models\/)?gemini-(\d+)/i.exec(model)?.[1]);
  if (Number.isFinite(major) && major >= 3) {
    base['thinkingConfig'] = { thinkingLevel: 'MEDIUM' };
  } else {
    base['temperature'] = 0;
    base['thinkingConfig'] = { thinkingBudget: 0 };
  }
  return base;
}

function compactUsage(usage: GenAIUsageMetadata | undefined): TokenUsageSnapshot {
  return {
    ...(usage?.promptTokenCount != null ? { promptTokens: usage.promptTokenCount } : {}),
    ...(usage?.candidatesTokenCount != null ? { candidateTokens: usage.candidatesTokenCount } : {}),
    ...(usage?.thoughtsTokenCount != null ? { thoughtTokens: usage.thoughtsTokenCount } : {}),
    ...(usage?.totalTokenCount != null ? { totalTokens: usage.totalTokenCount } : {}),
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
 * The diarization prompt (spec §6, verbatim). Getting agent vs. customer backwards
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
 * Channel-attribution prompt (M3, forward-looking). When the recording is
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

function buildTurnsSchema(Type: Record<string, string>): unknown {
  return {
    type: Type.OBJECT,
    properties: {
      detected_language: { type: Type.STRING },
      turns: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            speaker: { type: Type.STRING, enum: ['agent', 'customer', 'unknown'] },
            text: { type: Type.STRING },
            start_seconds: { type: Type.NUMBER },
            end_seconds: { type: Type.NUMBER },
          },
          required: ['speaker', 'text'],
        },
      },
    },
    required: ['detected_language', 'turns'],
  };
}

/** Map a raw @google/genai error to a TranscriptionError, detecting 429/RESOURCE_EXHAUSTED. */
function classifyGeminiError(err: unknown, context: string): TranscriptionError {
  const message = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  if (status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message)) {
    // Retried with longer backoff and does NOT consume an attempt (M4).
    return new TranscriptionError('RATE_LIMITED', `${context}: ${message}`);
  }
  return new TranscriptionError('TRANSCRIPTION_FAILED', `${context}: ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
