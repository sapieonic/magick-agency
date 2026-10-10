import { createChildLogger } from '@magick-agency/observability';
import {
  AiError,
  type AiClient,
  type AiFile,
  type AiFinish,
  type AiInputPart,
  type AiJsonRequest,
  type AiJsonResponse,
  type AiUsage,
  type GeminiClientConfig,
} from './types.js';

// Minimal structural types for the parts of @google/genai this client touches. The
// package is ESM-only, so a TYPE-position `import('@google/genai').X` fails under the
// project's CommonJS compile (TS1542); the runtime dynamic `import()` is fine. They
// also keep the SDK trivially mockable in unit tests.
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
interface GenAIModule {
  GoogleGenAI: new (opts: { apiKey: string; httpOptions?: { timeout?: number } }) => unknown;
  createPartFromUri(uri: string, mimeType: string): unknown;
}

const log = createChildLogger({ component: 'ai-gemini' });

/** Finish reasons that are a content refusal rather than a cut-off or an error. */
const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION']);

/**
 * Gemini through its own SDK (`@google/genai`), not the OpenAI-compatible endpoint:
 * the Files API (audio for transcription) and `responseJsonSchema` are only here.
 *
 * Model-family tuning lives here so callers never branch on Gemini versions:
 * - **Gemini 3.x**: no sampling overrides (Google's migration guidance), so any
 *   `temperature` is dropped. A `transcription` request gets `thinkingLevel: MEDIUM`.
 * - **Gemini 2.x**: `temperature` is sent as given. A `transcription` request turns
 *   thinking off (`thinkingBudget: 0`).
 * - Any other purpose keeps the model's default thinking.
 */
export class GeminiAiClient implements AiClient {
  readonly provider = 'gemini' as const;
  readonly model: string;
  readonly capabilities = { fileInput: true };
  private sdk: Promise<{ ai: GenAIClient; genai: GenAIModule }> | null = null;

  constructor(private readonly cfg: GeminiClientConfig) {
    this.model = cfg.model;
  }

  async generateJson(req: AiJsonRequest): Promise<AiJsonResponse> {
    const { ai, genai } = await this.load();
    const parts = req.input.map((part) => toGeminiPart(genai, part));

    let resp: GenAIGenerateResponse;
    try {
      resp = await ai.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: generationConfig(this.model, req),
      });
    } catch (err) {
      throw classify(err, 'Gemini generateContent failed');
    }
    return toResponse(this.model, resp);
  }

  /** Upload, then poll until the Files API marks it ACTIVE. Deletes it again if it never gets there. */
  async uploadFile(data: Buffer, mimeType: string): Promise<AiFile> {
    const { ai } = await this.load();
    let file: GenAIFile;
    try {
      file = await ai.files.upload({ file: new Blob([data], { type: mimeType }), config: { mimeType } });
    } catch (err) {
      throw classify(err, 'Gemini Files API upload failed');
    }
    try {
      return await this.waitUntilActive(ai, file, mimeType);
    } catch (err) {
      // The caller only owns cleanup once it has the handle; until then it is ours.
      if (file.name) {
        await ai.files.delete({ name: file.name }).catch((deleteErr: unknown) => {
          log.warn({ err: deleteErr, fileName: file.name }, 'Failed to delete a Gemini upload that never became usable');
        });
      }
      throw err;
    }
  }

  async deleteFile(file: AiFile): Promise<void> {
    const { ai } = await this.load();
    try {
      await ai.files.delete({ name: file.id });
    } catch (err) {
      throw classify(err, 'Gemini Files API delete failed');
    }
  }

  private async waitUntilActive(ai: GenAIClient, uploaded: GenAIFile, mimeType: string): Promise<AiFile> {
    let file = uploaded;
    const deadline = Date.now() + (this.cfg.timeoutMs ?? 180_000);
    while (String(file.state) === 'PROCESSING') {
      if (Date.now() > deadline) {
        throw new AiError('timeout', this.provider, 'Timed out waiting for the uploaded file to be processed');
      }
      await sleep(1000);
      try {
        file = await ai.files.get({ name: file.name! });
      } catch (err) {
        throw classify(err, 'Gemini Files API poll failed');
      }
    }
    if (String(file.state) === 'FAILED' || !file.uri) {
      throw new AiError('unsupported_input', this.provider, 'The uploaded file could not be processed');
    }
    return { provider: this.provider, id: file.name!, uri: file.uri, mimeType: file.mimeType ?? mimeType };
  }

  private load(): Promise<{ ai: GenAIClient; genai: GenAIModule }> {
    this.sdk ??= import('@google/genai').then((mod) => {
      const genai = mod as unknown as GenAIModule;
      const ai = new genai.GoogleGenAI({
        apiKey: this.cfg.apiKey,
        ...(this.cfg.timeoutMs !== undefined ? { httpOptions: { timeout: this.cfg.timeoutMs } } : {}),
      }) as GenAIClient;
      return { ai, genai };
    });
    return this.sdk;
  }
}

function toGeminiPart(genai: GenAIModule, part: AiInputPart): unknown {
  if (part.type === 'text') return { text: part.text };
  return genai.createPartFromUri(part.file.uri, part.file.mimeType);
}

function geminiMajor(model: string): number {
  return Number(/^(?:models\/)?gemini-(\d+)/i.exec(model)?.[1]);
}

function generationConfig(model: string, req: AiJsonRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {
    responseMimeType: 'application/json',
    responseJsonSchema: req.schema.schema,
  };
  if (req.system) config['systemInstruction'] = req.system;
  if (req.maxOutputTokens !== undefined) config['maxOutputTokens'] = req.maxOutputTokens;
  if (req.timeoutMs !== undefined) config['httpOptions'] = { timeout: req.timeoutMs };

  const major = geminiMajor(model);
  const gemini3 = Number.isFinite(major) && major >= 3;
  if (!gemini3 && req.temperature !== undefined) config['temperature'] = req.temperature;
  if (req.purpose === 'transcription') {
    config['thinkingConfig'] = gemini3 ? { thinkingLevel: 'MEDIUM' } : { thinkingBudget: 0 };
  }
  return config;
}

function toResponse(model: string, resp: GenAIGenerateResponse): AiJsonResponse {
  const candidate = resp.candidates?.[0];
  const rawFinish = candidate?.finishReason == null ? undefined : String(candidate.finishReason);
  const blockReason = resp.promptFeedback?.blockReason == null ? undefined : String(resp.promptFeedback.blockReason);
  const text = resp.text ?? candidate?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';

  let finish: AiFinish;
  if (!candidate) {
    finish = blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED' ? 'blocked' : 'no_output';
  } else if (rawFinish === undefined || rawFinish === 'STOP') {
    finish = 'stop';
  } else if (rawFinish === 'MAX_TOKENS') {
    finish = 'max_tokens';
  } else {
    finish = BLOCKED_FINISH_REASONS.has(rawFinish) ? 'blocked' : 'other';
  }

  return {
    text,
    finish,
    ...(rawFinish !== undefined ? { providerFinishReason: rawFinish } : {}),
    ...(candidate?.finishMessage ? { finishMessage: candidate.finishMessage } : {}),
    ...(blockReason !== undefined ? { blockReason } : {}),
    ...(resp.promptFeedback?.blockReasonMessage ? { blockReasonMessage: resp.promptFeedback.blockReasonMessage } : {}),
    usage: toUsage(resp.usageMetadata),
    model,
    ...(resp.modelVersion ? { modelVersion: resp.modelVersion } : {}),
    ...(candidate?.tokenCount != null ? { outputTokenCount: candidate.tokenCount } : {}),
  };
}

function toUsage(usage: GenAIUsageMetadata | undefined): AiUsage {
  return {
    ...(usage?.promptTokenCount != null ? { inputTokens: usage.promptTokenCount } : {}),
    ...(usage?.candidatesTokenCount != null ? { outputTokens: usage.candidatesTokenCount } : {}),
    ...(usage?.thoughtsTokenCount != null ? { thoughtTokens: usage.thoughtsTokenCount } : {}),
    ...(usage?.totalTokenCount != null ? { totalTokens: usage.totalTokenCount } : {}),
  };
}

/** 429 / RESOURCE_EXHAUSTED is rate limiting; everything else is a failed request. */
function classify(err: unknown, context: string): AiError {
  const message = (err as Error)?.message ?? String(err);
  const status = typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined;
  const kind = status === 429 || /RESOURCE_EXHAUSTED|rate limit|quota/i.test(message)
    ? 'rate_limited'
    : 'request_failed';
  return new AiError(kind, 'gemini', `${context}: ${message}`, status, { cause: err });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
