import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  generateContent: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    files = { upload: mocks.upload, get: mocks.get, delete: mocks.del };
    models = { generateContent: mocks.generateContent };
    constructor(opts: unknown) { mocks.ctor(opts); }
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { createAiClient } = await import('../../../src/ai/index.js');
import type { AiJsonRequest } from '../../../src/ai/index.js';

const SCHEMA = { name: 'call_analysis', strict: true, schema: { type: 'object', additionalProperties: false } };

function analysisRequest(overrides: Partial<AiJsonRequest> = {}): AiJsonRequest {
  return {
    purpose: 'post_call_analysis',
    system: 'You analyse calls.',
    input: [{ type: 'text', text: 'Transcript here' }],
    schema: SCHEMA,
    temperature: 0.3,
    ...overrides,
  };
}

function gemini(model = 'gemini-3.5-flash') {
  return createAiClient({ provider: 'gemini', apiKey: 'g-key', model, timeoutMs: 5000 });
}

describe('gemini client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.del.mockResolvedValue({});
  });

  it('uses the native SDK with the key and timeout, and sends the JSON Schema as responseJsonSchema', async () => {
    mocks.generateContent.mockResolvedValueOnce({
      text: '{"ok":true}',
      candidates: [{ finishReason: 'STOP', tokenCount: 7 }],
      modelVersion: 'gemini-3.5-flash-001',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3, totalTokenCount: 110 },
    });

    const res = await gemini().generateJson(analysisRequest());

    expect(mocks.ctor).toHaveBeenCalledWith({ apiKey: 'g-key', httpOptions: { timeout: 5000 } });
    const args = mocks.generateContent.mock.calls[0]![0];
    expect(args.model).toBe('gemini-3.5-flash');
    expect(args.contents).toEqual([{ role: 'user', parts: [{ text: 'Transcript here' }] }]);
    expect(args.config).toEqual({
      responseMimeType: 'application/json',
      responseJsonSchema: SCHEMA.schema,
      systemInstruction: 'You analyse calls.',
    });
    expect(res).toEqual({
      text: '{"ok":true}',
      finish: 'stop',
      providerFinishReason: 'STOP',
      usage: { inputTokens: 100, outputTokens: 7, thoughtTokens: 3, totalTokens: 110 },
      model: 'gemini-3.5-flash',
      modelVersion: 'gemini-3.5-flash-001',
      outputTokenCount: 7,
    });
  });

  it('Gemini 3.x: drops temperature (Google migration guidance); analysis keeps default thinking', async () => {
    mocks.generateContent.mockResolvedValueOnce({ text: '{}', candidates: [{ finishReason: 'STOP' }] });
    await createAiClient({ provider: 'gemini', apiKey: 'k', model: 'models/gemini-3.5-flash' }).generateJson(analysisRequest());
    const config = mocks.generateContent.mock.calls[0]![0].config;
    expect(config).not.toHaveProperty('temperature');
    expect(config).not.toHaveProperty('thinkingConfig');
  });

  it('Gemini 2.x: keeps the requested temperature; analysis keeps default thinking', async () => {
    mocks.generateContent.mockResolvedValueOnce({ text: '{}', candidates: [{ finishReason: 'STOP' }] });
    await gemini('gemini-2.5-flash').generateJson(analysisRequest());
    const config = mocks.generateContent.mock.calls[0]![0].config;
    expect(config.temperature).toBe(0.3);
    expect(config).not.toHaveProperty('thinkingConfig');
  });

  it('transcription purpose: MEDIUM thinking on 3.x, thinking off on 2.x', async () => {
    mocks.generateContent.mockResolvedValue({ text: '{}', candidates: [{ finishReason: 'STOP' }] });
    const req = analysisRequest({ purpose: 'transcription', temperature: 0, maxOutputTokens: 1024 });
    await gemini('gemini-3.5-flash').generateJson(req);
    await gemini('gemini-2.5-flash').generateJson(req);
    expect(mocks.generateContent.mock.calls[0]![0].config).toMatchObject({
      maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'MEDIUM' },
    });
    expect(mocks.generateContent.mock.calls[1]![0].config).toMatchObject({
      maxOutputTokens: 1024, temperature: 0, thinkingConfig: { thinkingBudget: 0 },
    });
  });

  it('maps finishes: no candidate (blocked or not), MAX_TOKENS, a safety stop', async () => {
    const client = gemini();
    mocks.generateContent.mockResolvedValueOnce({ promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'nope' } });
    expect(await client.generateJson(analysisRequest())).toMatchObject({
      finish: 'blocked', blockReason: 'SAFETY', blockReasonMessage: 'nope', text: '',
    });
    mocks.generateContent.mockResolvedValueOnce({ usageMetadata: { totalTokenCount: 1 } });
    expect((await client.generateJson(analysisRequest())).finish).toBe('no_output');
    mocks.generateContent.mockResolvedValueOnce({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a"' }] } }] });
    expect(await client.generateJson(analysisRequest())).toMatchObject({ finish: 'max_tokens', text: '{"a"' });
    mocks.generateContent.mockResolvedValueOnce({ candidates: [{ finishReason: 'SAFETY', finishMessage: 'unsafe' }] });
    expect(await client.generateJson(analysisRequest())).toMatchObject({
      finish: 'blocked', providerFinishReason: 'SAFETY', finishMessage: 'unsafe',
    });
  });

  it('classifies RESOURCE_EXHAUSTED / 429 as rate_limited, other failures as request_failed', async () => {
    const client = gemini();
    mocks.generateContent.mockRejectedValueOnce(new Error('429 RESOURCE_EXHAUSTED: quota'));
    await expect(client.generateJson(analysisRequest())).rejects.toMatchObject({ kind: 'rate_limited', provider: 'gemini' });
    mocks.generateContent.mockRejectedValueOnce(new Error('500 internal'));
    await expect(client.generateJson(analysisRequest())).rejects.toMatchObject({ kind: 'request_failed' });
  });

  it('uploads a file, polls until ACTIVE, and references it as a file part', async () => {
    vi.useFakeTimers();
    try {
      mocks.upload.mockResolvedValueOnce({ name: 'files/a', state: 'PROCESSING' });
      mocks.get.mockResolvedValueOnce({ name: 'files/a', uri: 'https://files/a', mimeType: 'audio/mpeg', state: 'ACTIVE' });
      const client = gemini();

      const pending = client.uploadFile(Buffer.from('audio'), 'audio/mpeg');
      await vi.advanceTimersByTimeAsync(1100);
      const file = await pending;

      expect(file).toEqual({ provider: 'gemini', id: 'files/a', uri: 'https://files/a', mimeType: 'audio/mpeg' });
      mocks.generateContent.mockResolvedValueOnce({ text: '{}', candidates: [{ finishReason: 'STOP' }] });
      await client.generateJson(analysisRequest({ input: [{ type: 'file', file }, { type: 'text', text: 'go' }] }));
      expect(mocks.generateContent.mock.calls[0]![0].contents[0].parts).toEqual([
        { fileData: { fileUri: 'https://files/a', mimeType: 'audio/mpeg' } },
        { text: 'go' },
      ]);
      await client.deleteFile(file);
      expect(mocks.del).toHaveBeenCalledWith({ name: 'files/a' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('deletes an upload that is rejected (unsupported_input) or never becomes ACTIVE (timeout)', async () => {
    mocks.upload.mockResolvedValueOnce({ name: 'files/bad', state: 'FAILED' });
    await expect(gemini().uploadFile(Buffer.from('a'), 'audio/mpeg')).rejects.toMatchObject({ kind: 'unsupported_input' });
    expect(mocks.del).toHaveBeenCalledWith({ name: 'files/bad' });

    vi.useFakeTimers();
    try {
      mocks.upload.mockResolvedValueOnce({ name: 'files/slow', state: 'PROCESSING' });
      mocks.get.mockResolvedValue({ name: 'files/slow', state: 'PROCESSING' });
      const client = createAiClient({ provider: 'gemini', apiKey: 'k', model: 'gemini-3.5-flash', timeoutMs: 2000 });
      const pending = expect(client.uploadFile(Buffer.from('a'), 'audio/mpeg')).rejects.toMatchObject({ kind: 'timeout' });
      await vi.advanceTimersByTimeAsync(4000);
      await pending;
      expect(mocks.del).toHaveBeenCalledWith({ name: 'files/slow' });
    } finally {
      vi.useRealTimers();
      mocks.get.mockReset();
    }
  });
});
