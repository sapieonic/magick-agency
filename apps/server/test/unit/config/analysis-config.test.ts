import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';

/**
 * New (magick-agency): the env reader for lane D's block. Covers what core's
 * `createAnalysisService` factory tests covered through `config.ai.*` fallbacks
 * (the fallback now lives in the reader), the VoiceLink recording-host allow-list and
 * the signing secret.
 */
const base = {
  DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency',
  REDIS_URL: 'redis://localhost:6383/0',
};

function parse(extra: Record<string, string> = {}) {
  const r = parseConfig({ ...base, ...extra });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.config;
}

describe('analysis config block', () => {
  // Manas, 2026-10-09: recording hosts default to VoiceLink's, transcript retention to
  // core's 30 days; the row window stays unset.
  it('defaults: dialer analysis off, VoiceLink recording host, no secret, row retention unset, transcripts 30 days', () => {
    const c = parse();
    expect(c.dialerAnalysis).toBeUndefined();
    expect(c.voicelinkRecording.allowedHosts).toEqual(['recording.app.voicelink.co.in']);
    expect(c.recordingUrlSigningSecret).toBeUndefined();
    expect(c.retention.agencyRetentionDays).toBeUndefined();
    expect(c.retention.agencyTranscriptRetentionDays).toBe(30);
    expect(c.postCallAnalysis).toMatchObject({ enabled: true, provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('parses VOICELINK_RECORDING_HOSTS as a trimmed comma list', () => {
    expect(parse({ VOICELINK_RECORDING_HOSTS: ' a.test, b.test ,,' }).voicelinkRecording.allowedHosts).toEqual(['a.test', 'b.test']);
  });

  it('post-call analysis key falls back to OPENAI_API_KEY, or GEMINI_API_KEY for gemini', () => {
    expect(parse({ OPENAI_API_KEY: 'o' }).postCallAnalysis.apiKey).toBe('o');
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }).postCallAnalysis.apiKey).toBe('g');
    expect(parse({ POST_CALL_ANALYSIS_API_KEY: 'dedicated', OPENAI_API_KEY: 'o' }).postCallAnalysis.apiKey).toBe('dedicated');
  });

  it('dialer analysis block appears only when DIALER_ANALYSIS_ENABLED is set, with the transcriber key fallback', () => {
    const c = parse({ DIALER_ANALYSIS_ENABLED: 'true', GEMINI_API_KEY: 'g' });
    expect(c.dialerAnalysis).toMatchObject({ enabled: true, geminiApiKey: 'g', geminiModel: 'gemini-3.5-flash' });
    expect(parse({ DIALER_ANALYSIS_ENABLED: 'true', GEMINI_API_KEY: 'g', DIALER_TRANSCRIBE_API_KEY: 'd' }).dialerAnalysis?.geminiApiKey).toBe('d');
  });

  it('reads the retention windows and refuses a row window below the floor', () => {
    const c = parse({ AGENCY_RETENTION_DAYS: '400', AGENCY_TRANSCRIPT_RETENTION_DAYS: '7' });
    expect(c.retention.agencyRetentionDays).toBe(400);
    expect(c.retention.agencyTranscriptRetentionDays).toBe(7);
    expect(parseConfig({ ...base, AGENCY_RETENTION_DAYS: '4' }).ok).toBe(false);
  });
});
