import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';
import type { ConversationEntry } from '@magick-agency/db/models/conversation-entry.model';
import type { AnalyticsConfig } from '@magick-agency/db/models/prompt.model';
import { buildAnalysisPrompt, buildJsonSchema, uniqueDimensions } from './prompt-builder.js';
import { withRetry } from '../utils/retry.js';
import type { AiClient, AiInputPart, AiUsage } from '../ai/index.js';
import { Traced } from '@magick-agency/observability';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'post-call-analysis' });

export interface AnalysisServiceConfig {
  /** The provider client (`ai/`); the factory in `./index.ts` builds it from config. */
  client: AiClient;
  timeoutMs: number;
  maxConversationTurns: number;
  /** Sampling temperature; null sends none. */
  temperature: number | null;
  /** `audio` also sends the recording; the client must accept files. Default `transcript`. */
  input?: 'transcript' | 'audio';
}

/** The recording, for `audio` input. */
export interface AnalysisAudio {
  bytes: Buffer;
  mimeType: string;
}

export class PostCallAnalysisService {
  private readonly client: AiClient;
  private readonly timeoutMs: number;
  private readonly maxConversationTurns: number;
  private readonly temperature: number | null;
  private readonly input: 'transcript' | 'audio';

  constructor(config: AnalysisServiceConfig) {
    this.client = config.client;
    this.timeoutMs = config.timeoutMs;
    this.maxConversationTurns = config.maxConversationTurns;
    this.temperature = config.temperature;
    this.input = config.input ?? 'transcript';
    if (this.input === 'audio' && !this.client.capabilities.fileInput) {
      throw new Error(`Post-call analysis input=audio needs a provider that accepts audio; ${this.client.provider} does not`);
    }
  }

  /** True when `analyze` must be given the recording (`opts.audio`). */
  get needsAudio(): boolean {
    return this.input === 'audio';
  }

  @Traced('analysis.run', {
    attrs: (callId: string, conversationLog: ConversationEntry[], analyticsConfig: AnalyticsConfig) => ({
      'call.id': callId,
      'analysis.turns': conversationLog.length,
      'analysis.custom_dimensions': analyticsConfig.custom_dimensions.length,
    }),
  })
  async analyze(
    callId: string,
    conversationLog: ConversationEntry[],
    analyticsConfig: AnalyticsConfig,
    opts?: {
      context?: string | null;
      audio?: AnalysisAudio;
      /**
       * Called after the upload and before every request, so a caller that fences a
       * long job by liveness sees it alive. A throw aborts the analysis; give the
       * error `nonRetryable` or the retry loop asks again.
       */
      heartbeat?: () => Promise<void>;
    },
  ): Promise<CallAnalysisResult> {
    const span = Traced.getSpan(this);
    span?.setAttribute('analysis.provider', this.client.provider);
    span?.setAttribute('analysis.model', this.client.model);
    span?.setAttribute('analysis.input', this.input);
    if (this.input === 'audio' && !opts?.audio) {
      throw new Error('Post-call analysis input=audio was called without the recording');
    }

    const startTime = Date.now();

    // The validators reject duplicate keys at save time, but a row saved before
    // that check still carries them. The prompt builder drops the repeats (first
    // wins) so analysis succeeds; say so, or the stored row stays dirty unnoticed.
    const dims = analyticsConfig.custom_dimensions;
    const kept = uniqueDimensions(dims);
    if (kept.length !== dims.length) {
      const keptSet = new Set(kept);
      log.warn(
        { callId, droppedKeys: dims.filter((d) => !keptSet.has(d)).map((d) => d.key) },
        'Dropped duplicate custom dimension keys from a stored analytics config',
      );
    }

    const { systemPrompt, userPrompt } = buildAnalysisPrompt(
      conversationLog,
      analyticsConfig,
      this.maxConversationTurns,
      opts?.context,
      { audio: this.input === 'audio' },
    );

    const jsonSchema = buildJsonSchema(analyticsConfig);

    log.debug(
      { callId, provider: this.client.provider, model: this.client.model, turns: conversationLog.length },
      'Starting post-call analysis',
    );

    // Uploaded once, outside the retries: a retry re-asks, it does not re-upload.
    const recording = opts?.audio && this.input === 'audio'
      ? await this.client.uploadFile(opts.audio.bytes, opts.audio.mimeType)
      : null;
    const input: AiInputPart[] = recording
      ? [{ type: 'file', file: recording }, { type: 'text', text: userPrompt }]
      : [{ type: 'text', text: userPrompt }];

    let parsed: { result: { common: CallAnalysisResult['common']; custom: Record<string, unknown> }; usage: AiUsage };
    try {
      parsed = await withRetry(
        async () => {
          await opts?.heartbeat?.();
          const response = await this.client.generateJson({
            purpose: 'post_call_analysis',
            system: systemPrompt,
            input,
            schema: jsonSchema,
            ...(this.temperature !== null ? { temperature: this.temperature } : {}),
            timeoutMs: this.timeoutMs,
          });

          if (!response.text) {
            throw new Error('Empty response from analysis LLM');
          }

          let result: { common: CallAnalysisResult['common']; custom: Record<string, unknown> };
          try {
            result = JSON.parse(response.text);
          } catch {
            log.error({ callId, raw: response.text.substring(0, 500) }, 'Failed to parse analysis JSON');
            throw new Error('Invalid JSON in analysis response');
          }

          return {
            result,
            usage: response.usage,
          };
        },
        {
          maxRetries: 2,
          baseDelayMs: 2000,
          onRetry: (error, attempt) => {
            log.warn({ err: error, callId, attempt }, 'Analysis LLM call retry');
          },
        },
      );
    } finally {
      // Customer audio does not stay on the provider longer than the request needs it.
      if (recording) {
        await this.client.deleteFile(recording).catch((err: unknown) => {
          log.warn({ err, callId, fileId: recording.id }, 'Failed to delete the analysis recording upload');
        });
      }
    }

    const latencyMs = Date.now() - startTime;

    Traced.getSpan(this)?.setAttribute('analysis.latency_ms', latencyMs);
    Traced.getSpan(this)?.setAttribute('analysis.sentiment', parsed.result.common.overall_sentiment.label);

    const analysisResult: CallAnalysisResult = {
      common: parsed.result.common,
      custom: parsed.result.custom,
      _meta: {
        model: this.client.model,
        provider: this.client.provider,
        input: this.input,
        latency_ms: latencyMs,
        prompt_tokens: parsed.usage.inputTokens ?? 0,
        completion_tokens: parsed.usage.outputTokens ?? 0,
        analyzed_at: new Date().toISOString(),
      },
    };

    log.info({
      callId,
      latencyMs,
      sentiment: analysisResult.common.overall_sentiment.label,
      topics: analysisResult.common.key_topics.length,
      customDimensions: Object.keys(analysisResult.custom).length,
    }, 'Post-call analysis completed');

    return analysisResult;
  }
}
