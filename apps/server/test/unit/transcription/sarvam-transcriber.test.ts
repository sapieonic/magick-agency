import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { SarvamTranscriber } = await import('../../../src/transcription/sarvam-transcriber.js');
const { TranscriptionError } = await import('../../../src/transcription/types.js');

const cfg = { apiKey: 'sarvam-secret', model: 'saaras:v3', timeoutMs: 2500, baseUrl: 'https://sarvam.test/' };
let fetchMock: ReturnType<typeof vi.fn>;

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe('SarvamTranscriber', () => {
  it('maps diarized speaker_0/speaker_1 turns to agent/customer and sends auth', async () => {
    fetchMock.mockResolvedValue(ok({
      language_code: 'hi-IN',
      diarized_transcript: { entries: [
        { speaker: 'speaker_0', transcript: 'Namaste', start_time_seconds: 0, end_time_seconds: 1 },
        { speaker: 'speaker_1', transcript: 'Ji boliye', start_time_seconds: 2, end_time_seconds: 3 },
      ] },
    }));

    const result = await new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' });

    expect(result.entries).toEqual([
      { role: 'agent', content: 'Namaste', start_seconds: 0, end_seconds: 1 },
      { role: 'customer', content: 'Ji boliye', start_seconds: 2, end_seconds: 3 },
    ]);
    expect(result.detectedLanguage).toBe('hi-IN');
    expect(result.durationSeconds).toBe(3);
    expect(result.diarizationFailed).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('https://sarvam.test/speech-to-text', expect.objectContaining({
      method: 'POST', headers: { 'Api-Subscription-Key': 'sarvam-secret' },
    }));
  });

  it('flags a one-speaker diarized result as diarizationFailed', async () => {
    fetchMock.mockResolvedValue(ok({ diarized_transcript: { entries: [{ speaker: 'speaker_0', text: 'Only one side' }] } }));
    const result = await new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' });
    expect(result.entries[0]).toMatchObject({ role: 'agent', content: 'Only one side' });
    expect(result.diarizationFailed).toBe(true);
  });

  it('uses one unknown turn for the flat-transcript fallback and returns empty entries for empty audio text', async () => {
    fetchMock.mockResolvedValueOnce(ok({ transcript: 'Plain transcript', detected_language: 'en-IN' }));
    const flat = await new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' });
    expect(flat.entries).toEqual([{ role: 'unknown', content: 'Plain transcript' }]);
    expect(flat.diarizationFailed).toBe(true);

    fetchMock.mockResolvedValueOnce(ok({ transcript: '   ' }));
    const empty = await new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' });
    expect(empty.entries).toEqual([]);
    expect(empty.diarizationFailed).toBe(false);
  });

  it('maps non-2xx responses to TranscriptionError and 429 to RATE_LIMITED', async () => {
    fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));
    await expect(new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' }))
      .rejects.toMatchObject({ code: 'TRANSCRIPTION_FAILED', retryable: false });

    fetchMock.mockResolvedValueOnce(new Response('quota', { status: 429 }));
    await expect(new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' }))
      .rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(TranscriptionError).toBeDefined();
  });

  it('maps a timed-out fetch to TIMEOUT', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('timed out'), { name: 'TimeoutError' }));
    await expect(new SarvamTranscriber(cfg).transcribe({ audio: Buffer.from('audio'), mimeType: 'audio/wav' }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('uses channelRoles instead of the first-speaker heuristic and forwards languageHint', async () => {
    fetchMock.mockResolvedValue(ok({
      diarized_transcript: { entries: [
        { speaker: 'speaker_0', transcript: 'browser leg' },
        { speaker: 'speaker_1', transcript: 'pstn leg' },
      ] },
    }));
    const result = await new SarvamTranscriber(cfg).transcribe({
      audio: Buffer.from('audio'), mimeType: 'audio/wav', languageHint: 'ta-IN', channelRoles: { 0: 'customer', 1: 'agent' },
    });
    expect(result.entries.map((entry) => entry.role)).toEqual(['customer', 'agent']);
    expect(result.detectedLanguage).toBe('ta-IN');
    const form = fetchMock.mock.calls[0]![1].body as FormData;
    expect(form.get('language_code')).toBe('ta-IN');
  });
});
