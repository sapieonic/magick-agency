import OpenAI, { AzureOpenAI } from 'openai';
import type { CallAnalysisResult } from '@magick-agency/db/models/call.model';
import type { ConversationEntry } from '@magick-agency/db/models/conversation-entry.model';
import type { AnalyticsConfig } from '@magick-agency/db/models/prompt.model';
import { buildAnalysisPrompt, buildJsonSchema, uniqueDimensions } from './prompt-builder.js';
import { withRetry } from '../utils/retry.js';
import { Traced } from '@magick-agency/observability';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'post-call-analysis' });

export interface AnalysisServiceConfig {
  provider: 'openai' | 'gemini' | 'azure_openai';
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxConversationTurns: number;
  azureEndpoint?: string;
  azureApiVersion?: string;
  azureDeployment?: string;
}

export class PostCallAnalysisService {
  private client: OpenAI;
  private model: string;
  private provider: 'openai' | 'gemini' | 'azure_openai';
  private timeoutMs: number;
  private maxConversationTurns: number;

  constructor(config: AnalysisServiceConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs;
    this.maxConversationTurns = config.maxConversationTurns;

    if (config.provider === 'azure_openai') {
      this.client = new AzureOpenAI({
        apiKey: config.apiKey,
        endpoint: config.azureEndpoint!,
        apiVersion: config.azureApiVersion ?? '2024-12-01-preview',
        deployment: config.azureDeployment,
      });
    } else {
      const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
        apiKey: config.apiKey,
      };

      if (config.provider === 'gemini') {
        clientOptions.baseURL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
      }

      this.client = new OpenAI(clientOptions);
    }
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
    opts?: { context?: string | null },
  ): Promise<CallAnalysisResult> {
    const span = Traced.getSpan(this);
    span?.setAttribute('analysis.provider', this.provider);
    span?.setAttribute('analysis.model', this.model);

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
    );

    const jsonSchema = buildJsonSchema(analyticsConfig);

    log.debug({ callId, provider: this.provider, model: this.model, turns: conversationLog.length }, 'Starting post-call analysis');

    const parsed = await withRetry(
      async () => {
        const response = await this.client.chat.completions.create(
          {
            model: this.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: jsonSchema as any,
            },
            // Gemini 3.x is tuned for its default sampling parameters and Google
            // recommends omitting temperature/top-p/top-k. Retain the established
            // temperature for OpenAI, Azure, and older Gemini models.
            ...(!isGemini3Model(this.provider, this.model) ? { temperature: 0.3 } : {}),
          },
          { signal: AbortSignal.timeout(this.timeoutMs) },
        );

        const choice = response.choices[0];
        if (!choice?.message?.content) {
          throw new Error('Empty response from analysis LLM');
        }

        let result: { common: CallAnalysisResult['common']; custom: Record<string, unknown> };
        try {
          result = JSON.parse(choice.message.content);
        } catch {
          log.error({ callId, raw: choice.message.content.substring(0, 500) }, 'Failed to parse analysis JSON');
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

    const latencyMs = Date.now() - startTime;

    Traced.getSpan(this)?.setAttribute('analysis.latency_ms', latencyMs);
    Traced.getSpan(this)?.setAttribute('analysis.sentiment', parsed.result.common.overall_sentiment.label);

    const analysisResult: CallAnalysisResult = {
      common: parsed.result.common,
      custom: parsed.result.custom,
      _meta: {
        model: this.model,
        provider: this.provider,
        latency_ms: latencyMs,
        prompt_tokens: parsed.usage?.prompt_tokens ?? 0,
        completion_tokens: parsed.usage?.completion_tokens ?? 0,
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

function isGemini3Model(provider: AnalysisServiceConfig['provider'], model: string): boolean {
  if (provider !== 'gemini') return false;
  const major = Number(/^(?:models\/)?gemini-(\d+)/i.exec(model)?.[1]);
  return Number.isFinite(major) && major >= 3;
}
