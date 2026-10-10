import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  azureCreate: vi.fn(),
  OpenAICtor: vi.fn(),
  AzureOpenAICtor: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: mocks.create } };
    constructor(opts: unknown) { mocks.OpenAICtor(opts); }
  },
  AzureOpenAI: class MockAzureOpenAI {
    chat = { completions: { create: mocks.azureCreate } };
    constructor(opts: unknown) { mocks.AzureOpenAICtor(opts); }
  },
}));

const { createAiClient, AiError } = await import('../../../src/ai/index.js');
import type { AiJsonRequest } from '../../../src/ai/index.js';

const SCHEMA = { name: 'call_analysis', strict: true, schema: { type: 'object', properties: { a: { type: 'string' } } } };

function request(overrides: Partial<AiJsonRequest> = {}): AiJsonRequest {
  return {
    purpose: 'post_call_analysis',
    system: 'You analyse calls.',
    input: [{ type: 'text', text: 'Transcript here' }],
    schema: SCHEMA,
    ...overrides,
  };
}

function completion(content: string | null, extra: Record<string, unknown> = {}) {
  return {
    model: 'gpt-4o-mini-2024-07-18',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...extra,
  };
}

describe('openai_compatible client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('talks to OpenAI by default: the key, no base URL, no extra headers', () => {
    createAiClient({ provider: 'openai_compatible', apiKey: 'sk-1', model: 'gpt-4o-mini' });
    expect(mocks.OpenAICtor).toHaveBeenCalledWith({ apiKey: 'sk-1', maxRetries: 0 });
  });

  it('passes a base URL and extra headers to the SDK, and a placeholder key for a keyless endpoint', () => {
    createAiClient({
      provider: 'openai_compatible',
      model: 'llama3.1',
      baseUrl: 'http://localhost:11434/v1',
      headers: { 'X-Title': 'Magick Agency' },
    });
    expect(mocks.OpenAICtor).toHaveBeenCalledWith({
      apiKey: 'not-set',
      maxRetries: 0,
      baseURL: 'http://localhost:11434/v1',
      defaultHeaders: { 'X-Title': 'Magick Agency' },
    });
  });

  it('sends the schema as json_schema response_format, system then user, and maps the answer', async () => {
    mocks.create.mockResolvedValueOnce(completion('{"a":"x"}', {
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } },
    }));
    const client = createAiClient({ provider: 'openai_compatible', apiKey: 'k', model: 'gpt-4o-mini' });

    const res = await client.generateJson(request({ temperature: 0.3, timeoutMs: 1000 }));

    const [body, opts] = mocks.create.mock.calls[0]!;
    expect(body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You analyse calls.' },
        { role: 'user', content: 'Transcript here' },
      ],
      response_format: { type: 'json_schema', json_schema: SCHEMA },
      temperature: 0.3,
    });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(res).toEqual({
      text: '{"a":"x"}',
      finish: 'stop',
      providerFinishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, thoughtTokens: 2, totalTokens: 15 },
      model: 'gpt-4o-mini',
      modelVersion: 'gpt-4o-mini-2024-07-18',
    });
  });

  it('omits temperature and max_tokens unless asked', async () => {
    mocks.create.mockResolvedValueOnce(completion('{}'));
    const client = createAiClient({ provider: 'openai_compatible', apiKey: 'k', model: 'o4-mini' });
    await client.generateJson(request());
    const body = mocks.create.mock.calls[0]![0];
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('max_tokens');

    mocks.create.mockResolvedValueOnce(completion('{}'));
    await client.generateJson(request({ maxOutputTokens: 256 }));
    expect(mocks.create.mock.calls[1]![0].max_tokens).toBe(256);
  });

  it('json_object mode: JSON mode response_format, and the schema given to the model in the system message', async () => {
    mocks.create.mockResolvedValueOnce(completion('{}'));
    const client = createAiClient({
      provider: 'openai_compatible', apiKey: 'k', model: 'm', baseUrl: 'https://llm.test/v1', structuredOutput: 'json_object',
    });

    await client.generateJson(request());

    const body = mocks.create.mock.calls[0]![0];
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toContain('You analyse calls.');
    expect(body.messages[0].content).toContain('JSON Schema');
    expect(body.messages[0].content).toContain(JSON.stringify(SCHEMA.schema));
  });

  it('maps finish reasons: length → max_tokens, content_filter → blocked, no choice → no_output', async () => {
    const client = createAiClient({ provider: 'openai_compatible', apiKey: 'k', model: 'm' });
    mocks.create.mockResolvedValueOnce(completion('{"a":', { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] }));
    expect((await client.generateJson(request())).finish).toBe('max_tokens');
    mocks.create.mockResolvedValueOnce(completion(null, { choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }));
    const blocked = await client.generateJson(request());
    expect(blocked).toMatchObject({ finish: 'blocked', text: '' });
    mocks.create.mockResolvedValueOnce(completion(null, { choices: [] }));
    expect((await client.generateJson(request())).finish).toBe('no_output');
  });

  it('turns a 429 into rate_limited and anything else into request_failed, keeping the message', async () => {
    const client = createAiClient({ provider: 'openai_compatible', apiKey: 'k', model: 'm' });
    mocks.create.mockRejectedValueOnce(Object.assign(new Error('Too many requests'), { status: 429 }));
    await expect(client.generateJson(request())).rejects.toMatchObject({
      name: 'AiError', kind: 'rate_limited', provider: 'openai_compatible', status: 429, message: 'Too many requests',
    });
    mocks.create.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(client.generateJson(request())).rejects.toMatchObject({ kind: 'request_failed', message: 'socket hang up' });
  });

  it('has no file input: a file part and uploadFile are refused', async () => {
    const client = createAiClient({ provider: 'openai_compatible', apiKey: 'k', model: 'm' });
    expect(client.capabilities.fileInput).toBe(false);
    const file = { provider: 'gemini' as const, id: 'f', uri: 'u', mimeType: 'audio/mpeg' };
    await expect(client.generateJson(request({ input: [{ type: 'file', file }] })))
      .rejects.toMatchObject({ kind: 'unsupported_operation' });
    await expect(client.uploadFile(Buffer.from('a'), 'audio/mpeg')).rejects.toBeInstanceOf(AiError);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe('azure_openai client', () => {
  beforeEach(() => vi.clearAllMocks());

  it('builds the Azure SDK client from endpoint, API version and deployment', () => {
    createAiClient({
      provider: 'azure_openai',
      apiKey: 'az-key',
      model: 'gpt-4o',
      endpoint: 'https://res.openai.azure.com',
      apiVersion: '2024-12-01-preview',
      deployment: 'gpt-4o-prod',
    });
    expect(mocks.AzureOpenAICtor).toHaveBeenCalledWith({
      apiKey: 'az-key',
      endpoint: 'https://res.openai.azure.com',
      apiVersion: '2024-12-01-preview',
      deployment: 'gpt-4o-prod',
      maxRetries: 0,
    });
    expect(mocks.OpenAICtor).not.toHaveBeenCalled();
  });

  it('sends the same Chat Completions request with json_schema and reports azure_openai', async () => {
    mocks.azureCreate.mockResolvedValueOnce(completion('{"a":"y"}'));
    const client = createAiClient({
      provider: 'azure_openai', apiKey: 'k', model: 'gpt-4o', endpoint: 'https://res.openai.azure.com', apiVersion: 'v',
    });

    const res = await client.generateJson(request({ temperature: 0.3 }));

    const body = mocks.azureCreate.mock.calls[0]![0];
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: SCHEMA });
    expect(body.model).toBe('gpt-4o');
    expect(client.provider).toBe('azure_openai');
    expect(res.text).toBe('{"a":"y"}');
  });
});
