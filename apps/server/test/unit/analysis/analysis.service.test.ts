import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConversationEntry } from '@magick-agency/db/models/conversation-entry.model';
import type { AnalyticsConfig } from '@magick-agency/db/models/prompt.model';


const mocks = vi.hoisted(() => ({
  chatCompletionsCreate: vi.fn(),
  azureChatCompletionsCreate: vi.fn(),
  OpenAICtor: vi.fn(),
  AzureOpenAICtor: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.chatCompletionsCreate } };
    constructor(opts: any) { mocks.OpenAICtor(opts); }
  },
  AzureOpenAI: class MockAzureOpenAI {
    chat = { completions: { create: mocks.azureChatCompletionsCreate } };
    constructor(opts: any) { mocks.AzureOpenAICtor(opts); }
  },
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({
    info: vi.fn(),
    warn: mocks.logWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
  Traced: Object.assign(
    () => (_method: any, _ctx: any) => _method,
    { getSpan: () => ({ setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() }) },
  ),
}));

import { PostCallAnalysisService } from '../../../src/analysis/analysis.service.js';

function makeLog(turns = 4): ConversationEntry[] {
  return Array.from({ length: turns }, (_, i) => ({
    role: i % 2 === 0 ? 'assistant' as const : 'user' as const,
    content: `Turn ${i}`,
    timestamp: new Date().toISOString(),
  }));
}

const emptyConfig: AnalyticsConfig = { custom_dimensions: [] };

const validAnalysisResponse = {
  common: {
    overall_sentiment: { label: 'neutral', score: 0.1 },
    turn_sentiments: [
      { turn_index: 0, role: 'assistant', sentiment: { label: 'neutral', score: 0.0 } },
    ],
    key_topics: ['greeting', 'scheduling'],
    conversation_quality: { coherence: 7, resolution_achieved: true, effectiveness_score: 8 },
    summary: 'A brief scheduling conversation.',
  },
  custom: {},
};

describe('PostCallAnalysisService', () => {
  let service: PostCallAnalysisService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new PostCallAnalysisService({
      provider: 'openai',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      timeoutMs: 30000,
      maxConversationTurns: 200,
    });
  });

  it('returns structured analysis result on success', async () => {
    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const result = await service.analyze('call-1', makeLog(), emptyConfig);

    expect(result.common.overall_sentiment.label).toBe('neutral');
    expect(result.common.key_topics).toEqual(['greeting', 'scheduling']);
    expect(result.common.conversation_quality.coherence).toBe(7);
    expect(result._meta.provider).toBe('openai');
    expect(result._meta.model).toBe('gpt-4o-mini');
    expect(result._meta.prompt_tokens).toBe(100);
    expect(result._meta.completion_tokens).toBe(50);
    expect(result._meta.latency_ms).toBeGreaterThanOrEqual(0);
    expect(result._meta.analyzed_at).toBeDefined();
  });

  it('passes custom dimensions through to result', async () => {
    const responseWithCustom = {
      ...validAnalysisResponse,
      custom: { payment_intent: true, objection_category: 'affordability' },
    };

    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(responseWithCustom) } }],
      usage: { prompt_tokens: 120, completion_tokens: 60 },
    });

    const config: AnalyticsConfig = {
      custom_dimensions: [
        { key: 'payment_intent', description: 'Willingness to pay', type: 'boolean' },
        { key: 'objection_category', description: 'Primary objection', type: 'enum', options: ['affordability', 'dispute'] },
      ],
    };

    const result = await service.analyze('call-2', makeLog(), config);
    expect(result.custom.payment_intent).toBe(true);
    expect(result.custom.objection_category).toBe('affordability');
  });

  it('throws on empty response from LLM after retries', async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: null } }],
      usage: null,
    });

    await expect(service.analyze('call-3', makeLog(), emptyConfig)).rejects.toThrow('Empty response');
    expect(mocks.chatCompletionsCreate).toHaveBeenCalledTimes(3);
  }, 15000);

  it('throws on invalid JSON response after retries', async () => {
    mocks.chatCompletionsCreate.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
      usage: null,
    });

    await expect(service.analyze('call-4', makeLog(), emptyConfig)).rejects.toThrow('Invalid JSON');
    expect(mocks.chatCompletionsCreate).toHaveBeenCalledTimes(3);
  }, 15000);

  it('retries on failure then succeeds', async () => {
    mocks.chatCompletionsCreate
      .mockRejectedValueOnce(new Error('rate limited'))
      .mockRejectedValueOnce(new Error('rate limited again'))
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

    const result = await service.analyze('call-5', makeLog(), emptyConfig);
    expect(result.common.overall_sentiment.label).toBe('neutral');
    expect(mocks.chatCompletionsCreate).toHaveBeenCalledTimes(3);
  }, 15000);

  it('throws after retry exhaustion (3 attempts)', async () => {
    mocks.chatCompletionsCreate
      .mockRejectedValueOnce(new Error('error 1'))
      .mockRejectedValueOnce(new Error('error 2'))
      .mockRejectedValueOnce(new Error('error 3'));

    await expect(service.analyze('call-6', makeLog(), emptyConfig)).rejects.toThrow('error 3');
    expect(mocks.chatCompletionsCreate).toHaveBeenCalledTimes(3);
  }, 15000);

  it('uses response_format json_schema in API call', async () => {
    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await service.analyze('call-7', makeLog(), emptyConfig);

    const callArgs = mocks.chatCompletionsCreate.mock.calls[0]![0];
    expect(callArgs.response_format.type).toBe('json_schema');
    expect(callArgs.response_format.json_schema.name).toBe('call_analysis');
    expect(callArgs.temperature).toBe(0.3);
  });

  it('sends a de-duplicated schema and warns when a stored config repeats a dimension key', async () => {
    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ ...validAnalysisResponse, custom: { payment_intent: true } }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const dupConfig: AnalyticsConfig = {
      custom_dimensions: [
        { key: 'payment_intent', description: 'First wording', type: 'boolean' },
        { key: 'payment_intent', description: 'Second wording', type: 'string' },
      ],
    };

    await service.analyze('call-dup', makeLog(), dupConfig);

    const custom = mocks.chatCompletionsCreate.mock.calls[0]![0].response_format.json_schema.schema.properties.custom;
    expect(custom.required).toEqual(['payment_intent']);
    expect(custom.properties.payment_intent).toEqual({ type: 'boolean' });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      { callId: 'call-dup', droppedKeys: ['payment_intent'] },
      'Dropped duplicate custom dimension keys from a stored analytics config',
    );
  });

  it('does not warn when every dimension key is unique', async () => {
    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await service.analyze('call-uniq', makeLog(), {
      custom_dimensions: [{ key: 'payment_intent', description: 'Paid?', type: 'boolean' }],
    });

    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it('constructs Gemini client with custom baseURL', () => {
    new PostCallAnalysisService({
      provider: 'gemini',
      apiKey: 'gemini-key',
      model: 'gemini-2.0-flash',
      timeoutMs: 30000,
      maxConversationTurns: 200,
    });

    expect(mocks.OpenAICtor).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'gemini-key',
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      }),
    );
  });

  it('omits sampling overrides for Gemini 3.x summary generation', async () => {
    const geminiService = new PostCallAnalysisService({
      provider: 'gemini',
      apiKey: 'gemini-key',
      model: 'models/gemini-3.5-flash',
      timeoutMs: 30000,
      maxConversationTurns: 200,
    });
    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await geminiService.analyze('call-gemini-3', makeLog(), emptyConfig);

    const callArgs = mocks.chatCompletionsCreate.mock.calls[0]![0];
    expect(callArgs).not.toHaveProperty('temperature');
    expect(callArgs).not.toHaveProperty('top_p');
    expect(callArgs).not.toHaveProperty('top_k');
  });

  describe('azure_openai provider', () => {
    let azureService: PostCallAnalysisService;

    beforeEach(() => {
      azureService = new PostCallAnalysisService({
        provider: 'azure_openai',
        apiKey: 'azure-key',
        model: 'gpt-4o',
        timeoutMs: 30000,
        maxConversationTurns: 200,
        azureEndpoint: 'https://myresource.openai.azure.com',
        azureApiVersion: '2024-12-01-preview',
        azureDeployment: 'gpt-4o',
      });
    });

    it('constructs AzureOpenAI client with correct options', () => {
      expect(mocks.AzureOpenAICtor).toHaveBeenCalledWith({
        apiKey: 'azure-key',
        endpoint: 'https://myresource.openai.azure.com',
        apiVersion: '2024-12-01-preview',
        deployment: 'gpt-4o',
      });
    });

    it('returns structured analysis result via Azure client', async () => {
      mocks.azureChatCompletionsCreate.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
        usage: { prompt_tokens: 80, completion_tokens: 40 },
      });

      const result = await azureService.analyze('call-azure-1', makeLog(), emptyConfig);

      expect(result.common.overall_sentiment.label).toBe('neutral');
      expect(result._meta.provider).toBe('azure_openai');
      expect(result._meta.model).toBe('gpt-4o');
      expect(result._meta.prompt_tokens).toBe(80);
      expect(mocks.azureChatCompletionsCreate).toHaveBeenCalledTimes(1);
    });

    it('passes custom dimensions through with Azure provider', async () => {
      const responseWithCustom = {
        ...validAnalysisResponse,
        custom: { payment_intent: true, objection_category: 'dispute' },
      };

      mocks.azureChatCompletionsCreate.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(responseWithCustom) } }],
        usage: { prompt_tokens: 100, completion_tokens: 60 },
      });

      const config: AnalyticsConfig = {
        custom_dimensions: [
          { key: 'payment_intent', description: 'Willingness to pay', type: 'boolean' },
          { key: 'objection_category', description: 'Primary objection', type: 'enum', options: ['affordability', 'dispute'] },
        ],
      };

      const result = await azureService.analyze('call-azure-2', makeLog(), config);
      expect(result.custom.payment_intent).toBe(true);
      expect(result.custom.objection_category).toBe('dispute');
      expect(result._meta.provider).toBe('azure_openai');
    });

    it('uses json_schema response format with Azure client', async () => {
      mocks.azureChatCompletionsCreate.mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });

      await azureService.analyze('call-azure-3', makeLog(), emptyConfig);

      const callArgs = mocks.azureChatCompletionsCreate.mock.calls[0]![0];
      expect(callArgs.response_format.type).toBe('json_schema');
      expect(callArgs.response_format.json_schema.name).toBe('call_analysis');
      expect(callArgs.response_format.json_schema.strict).toBe(true);
    });

    it('defaults azureApiVersion when not provided', () => {
      new PostCallAnalysisService({
        provider: 'azure_openai',
        apiKey: 'azure-key-2',
        model: 'gpt-4o-mini',
        timeoutMs: 30000,
        maxConversationTurns: 200,
        azureEndpoint: 'https://other.openai.azure.com',
      });

      expect(mocks.AzureOpenAICtor).toHaveBeenCalledWith(
        expect.objectContaining({
          apiVersion: '2024-12-01-preview',
        }),
      );
    });
  });
});
