import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  upload: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  generateContent: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    files = { upload: mocks.upload, get: mocks.get, delete: mocks.del };
    models = { generateContent: mocks.generateContent };
    constructor(_opts: unknown) {}
  },
  createPartFromUri: (uri: string, mimeType: string) => ({ fileData: { fileUri: uri, mimeType } }),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { GeminiTranscriber } = await import('../../../src/transcription/gemini-transcriber.js');
const { TranscriptionError } = await import('../../../src/transcription/types.js');
const { createAiClient } = await import('../../../src/ai/index.js');

const CFG = {
  apiKey: 'k', model: 'gemini-2.5-flash', timeoutMs: 5000, windowSeconds: 600, maxOutputTokens: 16384,
};
// The transcriber runs on a real Gemini AI client over the mocked SDK above, so these
// cases cover the client's request and response mapping as well as the transcriber.
function makeTranscriber(cfg: typeof CFG) {
  return new GeminiTranscriber({
    client: createAiClient({ provider: 'gemini', apiKey: cfg.apiKey, model: cfg.model, timeoutMs: cfg.timeoutMs }),
    windowSeconds: cfg.windowSeconds,
    maxOutputTokens: cfg.maxOutputTokens,
  });
}
const ACTIVE_FILE = { name: 'files/abc', uri: 'https://files/abc', mimeType: 'audio/mpeg', state: 'ACTIVE' };

function turnsResp(
  turns: Array<{ speaker: string; text: string; start_seconds?: number; end_seconds?: number }>,
  lang = 'English',
) {
  return {
    text: JSON.stringify({ detected_language: lang, turns }),
    candidates: [{ finishReason: 'STOP' }],
  };
}

function makeAudio(): Buffer {
  return Buffer.from('fake-audio-bytes');
}

describe('GeminiTranscriber', () => {
  beforeEach(() => {
    mocks.upload.mockReset();
    mocks.get.mockReset();
    mocks.del.mockReset();
    mocks.generateContent.mockReset();
    mocks.upload.mockResolvedValue(ACTIVE_FILE);
    mocks.del.mockResolvedValue({});
  });

  it('upload → generate happy path: diarized turns, language, cleanup', async () => {
    mocks.generateContent.mockResolvedValueOnce(
      turnsResp([
        { speaker: 'agent', text: 'Hello, this is Acme.', start_seconds: 0, end_seconds: 2 },
        { speaker: 'customer', text: 'Yes, speaking.', start_seconds: 3, end_seconds: 4 },
      ]),
    );

    const result = await makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' });

    expect(result.detectedLanguage).toBe('English');
    expect(result.model).toBe('gemini-2.5-flash');
    expect(result.diarizationFailed).toBe(false);
    expect(result.entries).toEqual([
      { role: 'agent', content: 'Hello, this is Acme.', start_seconds: 0, end_seconds: 2 },
      { role: 'customer', content: 'Yes, speaking.', start_seconds: 3, end_seconds: 4 },
    ]);
    expect(result.durationSeconds).toBe(4);
    expect(mocks.del).toHaveBeenCalledWith({ name: 'files/abc' });
    expect(mocks.generateContent.mock.calls[0]![0].config).toMatchObject({
      temperature: 0,
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: 'application/json',
    });
  });

  it('uses Gemini 3.5 migration-safe thinking settings without sampling overrides', async () => {
    mocks.generateContent.mockResolvedValueOnce(turnsResp([{ speaker: 'agent', text: 'Hi' }]));

    await makeTranscriber({ ...CFG, model: 'gemini-3.5-flash' }).transcribe({
      audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 10,
    });

    const config = mocks.generateContent.mock.calls[0]![0].config;
    expect(config).toMatchObject({
      maxOutputTokens: 16384,
      thinkingConfig: { thinkingLevel: 'MEDIUM' },
      responseMimeType: 'application/json',
    });
    expect(config).not.toHaveProperty('temperature');
    expect(config.thinkingConfig).not.toHaveProperty('thinkingBudget');
  });

  it('polls the Files API from PROCESSING → ACTIVE', async () => {
    vi.useFakeTimers();
    try {
      mocks.upload.mockResolvedValue({ ...ACTIVE_FILE, state: 'PROCESSING' });
      mocks.get.mockResolvedValueOnce({ ...ACTIVE_FILE, state: 'ACTIVE' });
      mocks.generateContent.mockResolvedValueOnce(turnsResp([{ speaker: 'agent', text: 'Hi' }]));

      const promise = makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' });
      await vi.advanceTimersByTimeAsync(1100);
      const result = await promise;

      expect(mocks.get).toHaveBeenCalledWith({ name: 'files/abc' });
      expect(result.entries).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws UNSUPPORTED_AUDIO when the Files API marks the upload FAILED', async () => {
    mocks.upload.mockResolvedValue({ ...ACTIVE_FILE, state: 'FAILED', uri: undefined });
    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_AUDIO', retryable: false });
    expect(mocks.del).toHaveBeenCalledWith({ name: 'files/abc' });
  });

  it('deletes an uploaded file when Files API polling fails', async () => {
    vi.useFakeTimers();
    try {
      mocks.upload.mockResolvedValue({ ...ACTIVE_FILE, state: 'PROCESSING' });
      mocks.get.mockRejectedValueOnce(new Error('poll failed'));

      const promise = makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' });
      const expectation = expect(promise).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
      await vi.advanceTimersByTimeAsync(1100);
      await expectation;
      expect(mocks.del).toHaveBeenCalledWith({ name: 'files/abc' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails with TRANSCRIPTION_FAILED on a non-STOP finishReason', async () => {
    mocks.generateContent.mockResolvedValueOnce({ text: '{}', candidates: [{ finishReason: 'SAFETY' }] });
    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
  });

  it('treats prompt blocking as a permanent provider failure, never silent audio', async () => {
    mocks.generateContent.mockResolvedValueOnce({
      promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'blocked by policy' },
    });
    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });
  });

  it('treats an unexplained no-candidate response as retryable, never silent audio', async () => {
    mocks.generateContent.mockResolvedValueOnce({ usageMetadata: { totalTokenCount: 10 } });
    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: true });
  });

  it('rejects STOP with empty content or missing required turns instead of classifying silence', async () => {
    mocks.generateContent
      .mockResolvedValueOnce({ candidates: [{ finishReason: 'STOP' }] })
      .mockResolvedValueOnce({ text: '{}', candidates: [{ finishReason: 'STOP' }] });

    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED' });
  });

  it('splits a bounded MAX_TOKENS window and preserves chronological offsets', async () => {
    mocks.generateContent
      .mockResolvedValueOnce({
        candidates: [{ finishReason: 'MAX_TOKENS', finishMessage: 'budget exhausted' }],
        usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 16000, totalTokenCount: 16100 },
      })
      .mockResolvedValueOnce(turnsResp([{ speaker: 'agent', text: 'first half', start_seconds: 1 }]))
      .mockResolvedValueOnce(turnsResp([{ speaker: 'customer', text: 'second half', start_seconds: 1 }]));

    const onProgress = vi.fn();
    const result = await makeTranscriber({ ...CFG, model: 'gemini-3.5-flash' }).transcribe(
      { audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 10 },
      onProgress,
    );

    expect(mocks.generateContent).toHaveBeenCalledTimes(3);
    expect(result.entries).toEqual([
      { role: 'agent', content: 'first half', start_seconds: 1 },
      { role: 'customer', content: 'second half', start_seconds: 6 },
    ]);
    expect(onProgress).toHaveBeenNthCalledWith(1, 0); // MAX_TOKENS parent response heartbeat
    expect(onProgress).toHaveBeenNthCalledWith(2, 5);
    expect(onProgress).toHaveBeenNthCalledWith(3, 10);
  });

  it('retries a minimum window once with bounded output escalation, then fails permanently', async () => {
    mocks.generateContent.mockResolvedValue({
      candidates: [{ finishReason: 'MAX_TOKENS' }],
      usageMetadata: { thoughtsTokenCount: 16384, totalTokenCount: 16400 },
    });

    await expect(
      makeTranscriber({ ...CFG, model: 'gemini-3.5-flash' }).transcribe({
        audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 5,
      }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });
    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    expect(mocks.generateContent.mock.calls[0]![0].config.maxOutputTokens).toBe(16384);
    expect(mocks.generateContent.mock.calls[1]![0].config.maxOutputTokens).toBe(32768);
  });

  it('never splits a parent into children below the five-second minimum', async () => {
    mocks.generateContent
      .mockResolvedValueOnce({ candidates: [{ finishReason: 'MAX_TOKENS' }] })
      .mockResolvedValueOnce(turnsResp([{ speaker: 'agent', text: 'whole six seconds' }]));

    const result = await makeTranscriber({ ...CFG, model: 'gemini-3.5-flash' }).transcribe({
      audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 6,
    });

    expect(result.entries).toHaveLength(1);
    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    const retryPrompt = mocks.generateContent.mock.calls[1]![0].contents[0].parts[1].text as string;
    expect(retryPrompt).toContain('from 0 to 6 seconds');
    expect(mocks.generateContent.mock.calls[1]![0].config.maxOutputTokens).toBe(32768);
  });

  it('bounds pathological recursive MAX_TOKENS expansion', async () => {
    mocks.generateContent.mockImplementation(async (args) => {
      const prompt = args.contents[0].parts[1].text as string;
      const match = /from ([\d.]+) to ([\d.]+) seconds/.exec(prompt);
      const duration = match ? Number(match[2]) - Number(match[1]) : 600;
      // Force the expensive tree shape: every splittable parent overflows, while
      // minimum leaves succeed so processing would otherwise explore the full tree.
      return duration >= 10
        ? { candidates: [{ finishReason: 'MAX_TOKENS' }] }
        : turnsResp([]);
    });

    await expect(
      makeTranscriber({ ...CFG, model: 'gemini-3.5-flash' }).transcribe({
        audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 600,
      }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });
    expect(mocks.generateContent).toHaveBeenCalledTimes(65);
  });

  it('returns an empty transcript (no turns) without throwing — runner classifies skipped', async () => {
    mocks.generateContent.mockResolvedValueOnce(turnsResp([]));
    const result = await makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' });
    expect(result.entries).toEqual([]);
    expect(result.diarizationFailed).toBe(false); // no turns ⇒ not "failed"
  });

  it('sets diarizationFailed when EVERY turn is unknown', async () => {
    mocks.generateContent.mockResolvedValueOnce(
      turnsResp([
        { speaker: 'unknown', text: 'mumble one' },
        { speaker: 'unknown', text: 'mumble two' },
      ]),
    );
    const result = await makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' });
    expect(result.diarizationFailed).toBe(true);
    expect(result.entries.every((e) => e.role === 'unknown')).toBe(true);
  });

  it('does NOT set diarizationFailed when at least one turn is attributed', async () => {
    mocks.generateContent.mockResolvedValueOnce(
      turnsResp([
        { speaker: 'agent', text: 'Hello' },
        { speaker: 'unknown', text: 'noise' },
      ]),
    );
    const result = await makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' });
    expect(result.diarizationFailed).toBe(false);
  });

  it('classifies RESOURCE_EXHAUSTED as retryable RATE_LIMITED (does not burn an attempt)', async () => {
    mocks.generateContent.mockRejectedValueOnce(Object.assign(new Error('RESOURCE_EXHAUSTED: quota'), { status: 429 }));
    await expect(
      makeTranscriber(CFG).transcribe({ audio: makeAudio(), mimeType: 'audio/mpeg' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(TranscriptionError).toBeDefined();
  });

  it('windows a long call, offsets timestamps by window start, and heartbeats per window', async () => {
    // 900s call, 600s window → windows [0,600], [600,900].
    mocks.generateContent
      .mockResolvedValueOnce(turnsResp([{ speaker: 'agent', text: 'first window', start_seconds: 10, end_seconds: 12 }]))
      .mockResolvedValueOnce(turnsResp([{ speaker: 'customer', text: 'second window', start_seconds: 5, end_seconds: 7 }]));

    const onProgress = vi.fn().mockResolvedValue(undefined);
    const result = await makeTranscriber(CFG).transcribe(
      { audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 900 },
      onProgress,
    );

    expect(mocks.generateContent).toHaveBeenCalledTimes(2);
    // Second window's timestamps offset by 600.
    expect(result.entries).toEqual([
      { role: 'agent', content: 'first window', start_seconds: 10, end_seconds: 12 },
      { role: 'customer', content: 'second window', start_seconds: 605, end_seconds: 607 },
    ]);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, 600);
    expect(onProgress).toHaveBeenNthCalledWith(2, 900);
  });

  it('carries the previous window last-two turns into the next window prompt (context seam)', async () => {
    mocks.generateContent
      .mockResolvedValueOnce(
        turnsResp([
          { speaker: 'agent', text: 'turn one', start_seconds: 0 },
          { speaker: 'customer', text: 'turn two', start_seconds: 5 },
        ]),
      )
      .mockResolvedValueOnce(turnsResp([{ speaker: 'agent', text: 'turn three', start_seconds: 1 }]));

    await makeTranscriber(CFG).transcribe(
      { audio: makeAudio(), mimeType: 'audio/mpeg', expectedDurationSeconds: 900 },
    );

    const secondCallPrompt = mocks.generateContent.mock.calls[1]![0].contents[0].parts[1].text as string;
    expect(secondCallPrompt).toContain('turn one');
    expect(secondCallPrompt).toContain('turn two');
    expect(secondCallPrompt).toContain('preceding turns');
  });

  it('channelRoles bypasses diarization (deterministic, never diarizationFailed)', async () => {
    // Even if the model returned all-unknown, channel mode is deterministic.
    mocks.generateContent.mockResolvedValueOnce(
      turnsResp([
        { speaker: 'agent', text: 'left leg' },
        { speaker: 'customer', text: 'right leg' },
      ]),
    );
    const result = await makeTranscriber(CFG).transcribe({
      audio: makeAudio(),
      mimeType: 'audio/mpeg',
      channelRoles: { 0: 'agent', 1: 'customer' },
    });
    expect(result.diarizationFailed).toBe(false);
    const prompt = mocks.generateContent.mock.calls[0]![0].contents[0].parts[1].text as string;
    expect(prompt).toContain('channel 0 = agent');
    expect(prompt).toContain('channel 1 = customer');
  });
});
