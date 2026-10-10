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
import { AiError, createAiClient, type AiClientConfig } from '../../../src/ai/index.js';

/** The service on a real AI client over the mocked `openai` SDK. */
function makeService(client: AiClientConfig, temperature: number | null = 0.3): PostCallAnalysisService {
  return new PostCallAnalysisService({
    client: createAiClient(client),
    timeoutMs: 30000,
    maxConversationTurns: 200,
    temperature,
  });
}

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
    service = makeService({ provider: 'openai_compatible', apiKey: 'test-key', model: 'gpt-4o-mini' });
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
    expect(result._meta.provider).toBe('openai_compatible');
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

  it('sends no temperature when configured with none (models that refuse one)', async () => {
    const noTemp = makeService({ provider: 'openai_compatible', apiKey: 'k', model: 'o4-mini' }, null);
    mocks.chatCompletionsCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify(validAnalysisResponse) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await noTemp.analyze('call-no-temp', makeLog(), emptyConfig);

    expect(mocks.chatCompletionsCreate.mock.calls[0]![0]).not.toHaveProperty('temperature');
  });

  describe('azure_openai provider', () => {
    let azureService: PostCallAnalysisService;

    beforeEach(() => {
      azureService = makeService({
        provider: 'azure_openai',
        apiKey: 'azure-key',
        model: 'gpt-4o',
        endpoint: 'https://myresource.openai.azure.com',
        apiVersion: '2024-12-01-preview',
        deployment: 'gpt-4o',
      });
    });

    it('constructs AzureOpenAI client with correct options', () => {
      expect(mocks.AzureOpenAICtor).toHaveBeenCalledWith({
        apiKey: 'azure-key',
        endpoint: 'https://myresource.openai.azure.com',
        apiVersion: '2024-12-01-preview',
        deployment: 'gpt-4o',
        maxRetries: 0,
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
  });
});

describe('PostCallAnalysisService with audio input', () => {
  const FILE = { provider: 'gemini' as const, id: 'files/rec', uri: 'https://files/rec', mimeType: 'audio/mpeg' };
  const AUDIO = { bytes: Buffer.from('mp3-bytes'), mimeType: 'audio/mpeg' };

  function fakeClient(fileInput = true) {
    return {
      provider: 'gemini' as const,
      model: 'gemini-3.5-flash',
      capabilities: { fileInput },
      generateJson: vi.fn(),
      uploadFile: vi.fn().mockResolvedValue(FILE),
      deleteFile: vi.fn().mockResolvedValue(undefined),
    };
  }

  function audioService(client: ReturnType<typeof fakeClient>) {
    return new PostCallAnalysisService({ client, timeoutMs: 180000, maxConversationTurns: 200, temperature: 0.3, input: 'audio' });
  }

  const okResponse = {
    text: JSON.stringify(validAnalysisResponse), finish: 'stop', usage: { inputTokens: 900, outputTokens: 50 }, model: 'gemini-3.5-flash',
  };

  beforeEach(() => vi.clearAllMocks());

  it('uploads the recording, sends it before the transcript, records input=audio, then deletes it', async () => {
    const client = fakeClient();
    client.generateJson.mockResolvedValueOnce(okResponse);

    const result = await audioService(client).analyze('call-a1', makeLog(), emptyConfig, { audio: AUDIO });

    expect(client.uploadFile).toHaveBeenCalledWith(AUDIO.bytes, 'audio/mpeg');
    const req = client.generateJson.mock.calls[0]![0];
    expect(req.input[0]).toEqual({ type: 'file', file: FILE });
    expect(req.input[1].type).toBe('text');
    expect(req.input[1].text).toContain('using the attached recording');
    expect(req.system).toContain('## Call Recording');
    expect(req.timeoutMs).toBe(180000);
    expect(result._meta).toMatchObject({ input: 'audio', provider: 'gemini', prompt_tokens: 900 });
    expect(client.deleteFile).toHaveBeenCalledWith(FILE);
  });

  it('uploads once across retries, and still deletes the upload when every attempt fails', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    client.generateJson.mockRejectedValue(new Error('model overloaded'));
    try {
      // The retry backoff is real seconds; advance through it instead of waiting.
      const outcome = expect(audioService(client).analyze('call-a2', makeLog(), emptyConfig, { audio: AUDIO }))
        .rejects.toThrow('model overloaded');
      await vi.advanceTimersByTimeAsync(30_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(client.generateJson).toHaveBeenCalledTimes(3);
    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    expect(client.deleteFile).toHaveBeenCalledWith(FILE);
  });

  it('heartbeats after the upload and before every request', async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const order: string[] = [];
    client.uploadFile.mockImplementation(async () => { order.push('upload'); return FILE; });
    client.generateJson
      .mockImplementationOnce(async () => { order.push('request'); throw new Error('model overloaded'); })
      .mockImplementationOnce(async () => { order.push('request'); return okResponse; });
    const heartbeat = vi.fn(async () => { order.push('heartbeat'); });
    try {
      const outcome = audioService(client).analyze('call-h1', makeLog(), emptyConfig, { audio: AUDIO, heartbeat });
      await vi.advanceTimersByTimeAsync(30_000);
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(order).toEqual(['upload', 'heartbeat', 'request', 'heartbeat', 'request']);
  });

  it('a heartbeat that throws a nonRetryable error stops at once, and the upload is still deleted', async () => {
    const client = fakeClient();
    const fenced = Object.assign(new Error('fenced'), { nonRetryable: true });

    await expect(audioService(client).analyze('call-h2', makeLog(), emptyConfig, {
      audio: AUDIO, heartbeat: vi.fn().mockRejectedValue(fenced),
    })).rejects.toBe(fenced);

    expect(client.generateJson).not.toHaveBeenCalled();
    expect(client.deleteFile).toHaveBeenCalledWith(FILE);
  });

  it('does not retry in place an AI error a retry cannot fix (rate limit, rejected input)', async () => {
    for (const kind of ['rate_limited', 'unsupported_input'] as const) {
      const client = fakeClient();
      client.generateJson.mockRejectedValue(new AiError(kind, 'gemini', kind));
      await expect(audioService(client).analyze('call-h3', makeLog(), emptyConfig, { audio: AUDIO })).rejects.toThrow(kind);
      expect(client.generateJson).toHaveBeenCalledTimes(1);
      expect(client.deleteFile).toHaveBeenCalledWith(FILE);
    }
  });

  it('a failed delete is logged, not thrown: the analysis result still comes back', async () => {
    const client = fakeClient();
    client.generateJson.mockResolvedValueOnce(okResponse);
    client.deleteFile.mockRejectedValueOnce(new Error('delete failed'));

    const result = await audioService(client).analyze('call-a3', makeLog(), emptyConfig, { audio: AUDIO });

    expect(result.common.overall_sentiment.label).toBe('neutral');
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.objectContaining({ fileId: 'files/rec' }), expect.any(String));
  });

  it('refuses audio input on a client without file input, and an analyze call without the recording', async () => {
    expect(() => audioService(fakeClient(false))).toThrow(/needs a provider that accepts audio/);

    const client = fakeClient();
    expect(audioService(client).needsAudio).toBe(true);
    await expect(audioService(client).analyze('call-a4', makeLog(), emptyConfig)).rejects.toThrow(/without the recording/);
    expect(client.uploadFile).not.toHaveBeenCalled();
  });

  it('transcript input (the default) never uploads, even when audio is passed', async () => {
    const client = fakeClient();
    client.generateJson.mockResolvedValueOnce(okResponse);
    const service = new PostCallAnalysisService({ client, timeoutMs: 30000, maxConversationTurns: 200, temperature: 0.3 });

    const result = await service.analyze('call-t1', makeLog(), emptyConfig, { audio: AUDIO });

    expect(service.needsAudio).toBe(false);
    expect(client.uploadFile).not.toHaveBeenCalled();
    expect(client.generateJson.mock.calls[0]![0].input).toEqual([{ type: 'text', text: expect.any(String) }]);
    expect(result._meta.input).toBe('transcript');
  });
});
