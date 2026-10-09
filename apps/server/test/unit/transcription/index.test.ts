import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { SarvamTranscriber } = await import('../../../src/transcription/sarvam-transcriber.js');
const { createTranscriber, isSarvamSupportedLanguage } = await import('../../../src/transcription/index.js');

const CFG = { apiKey: 'k', model: 'saarika:v2', timeoutMs: 5000, baseUrl: 'https://api.sarvam.test' };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('SarvamTranscriber', () => {
  const origFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('maps speaker_0 → agent, speaker_1 → customer (first speaker = agent)', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      jsonResponse({
        language_code: 'hi-IN',
        diarized_transcript: {
          entries: [
            { speaker: 'speaker_0', transcript: 'Namaste, Acme se.', start_time_seconds: 0, end_time_seconds: 2 },
            { speaker: 'speaker_1', transcript: 'Ji boliye.', start_time_seconds: 3, end_time_seconds: 4 },
            { speaker: 'speaker_0', transcript: 'Aapka payment due hai.' },
          ],
        },
      }),
    );
    const result = await new SarvamTranscriber(CFG).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' });
    expect(result.entries.map((e) => e.role)).toEqual(['agent', 'customer', 'agent']);
    expect(result.detectedLanguage).toBe('hi-IN');
    expect(result.diarizationFailed).toBe(false);
    expect(result.entries[0]!.start_seconds).toBe(0);
  });

  it('sets diarizationFailed when only one speaker is detected', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      jsonResponse({
        language_code: 'en-IN',
        diarized_transcript: {
          entries: [
            { speaker: 'speaker_0', transcript: 'Hello?' },
            { speaker: 'speaker_0', transcript: 'Anyone there?' },
          ],
        },
      }),
    );
    const result = await new SarvamTranscriber(CFG).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' });
    expect(result.diarizationFailed).toBe(true);
  });

  it('falls back to a single unknown turn when no diarization is present', async () => {
    (global.fetch as any).mockResolvedValueOnce(jsonResponse({ transcript: 'flat text', language_code: 'en-IN' }));
    const result = await new SarvamTranscriber(CFG).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' });
    expect(result.entries).toEqual([{ role: 'unknown', content: 'flat text' }]);
  });

  it('maps a 429 to retryable RATE_LIMITED', async () => {
    (global.fetch as any).mockResolvedValueOnce(jsonResponse({}, 429));
    await expect(
      new SarvamTranscriber(CFG).transcribe({ audio: Buffer.from('a'), mimeType: 'audio/wav' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('respects channelRoles when speaker index is resolvable', async () => {
    (global.fetch as any).mockResolvedValueOnce(
      jsonResponse({
        diarized_transcript: {
          entries: [
            { speaker: 'speaker_1', transcript: 'from channel one' },
            { speaker: 'speaker_0', transcript: 'from channel zero' },
          ],
        },
      }),
    );
    const result = await new SarvamTranscriber(CFG).transcribe({
      audio: Buffer.from('a'),
      mimeType: 'audio/wav',
      channelRoles: { 0: 'customer', 1: 'agent' },
    });
    expect(result.entries.map((e) => e.role)).toEqual(['agent', 'customer']);
  });
});

describe('createTranscriber', () => {
  const base = {
    enabled: true,
    transcriber: 'gemini' as const,
    geminiModel: 'gemini-3.5-flash',
    geminiApiKey: 'gk',
    sarvamApiKey: 'sk',
    transcribeTimeoutMs: 180000,
    transcribeWindowSeconds: 600,
    transcribeMaxOutputTokens: 16384,
    maxRecordingBytes: 1000,
    minTalkTimeSeconds: 10,
    recordingWaitMinutes: 30,
    maxAttempts: 3,
    maxAttemptsTotal: 8,
    concurrency: 2,
    pollIntervalMs: 60000,
    settleSeconds: 15,
  };

  it('returns null when dialerAnalysis is absent', () => {
    expect(createTranscriber({ dialerAnalysis: undefined } as any)).toBeNull();
  });

  it('returns null when dialerAnalysis is present but disabled', () => {
    expect(createTranscriber({ dialerAnalysis: { ...base, enabled: false } } as any)).toBeNull();
  });

  it('constructs a Gemini transcriber by default', () => {
    const t = createTranscriber({ dialerAnalysis: base } as any);
    expect(t?.provider).toBe('gemini');
  });

  it('constructs a Sarvam transcriber when selected', () => {
    const t = createTranscriber({ dialerAnalysis: { ...base, transcriber: 'sarvam' } } as any);
    expect(t?.provider).toBe('sarvam');
  });

  it('returns null when the selected provider has no API key', () => {
    expect(createTranscriber({ dialerAnalysis: { ...base, geminiApiKey: undefined } } as any)).toBeNull();
    expect(
      createTranscriber({ dialerAnalysis: { ...base, transcriber: 'sarvam', sarvamApiKey: undefined } } as any),
    ).toBeNull();
  });

  it('isSarvamSupportedLanguage recognises Indian languages only', () => {
    expect(isSarvamSupportedLanguage('hi-IN')).toBe(true);
    expect(isSarvamSupportedLanguage('en-IN')).toBe(true);
    expect(isSarvamSupportedLanguage('fr-FR')).toBe(false);
  });
});
