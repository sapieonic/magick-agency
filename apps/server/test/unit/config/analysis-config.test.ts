import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../../src/config/load.js';

/**
 * The env reader for the analysis block. Covers the `createAnalysisService` API-key
 * fallbacks (they live in the reader), the VoiceLink recording-host allow-list and
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
  // Recording hosts default to VoiceLink's, transcript retention to 30 days; the row
  // window stays unset.
  it('defaults: dialer analysis off, VoiceLink recording host, no secret, row retention unset, transcripts 30 days', () => {
    const c = parse();
    expect(c.dialerAnalysis).toBeUndefined();
    expect(c.voicelinkRecording.allowedHosts).toEqual(['recording.app.voicelink.co.in']);
    expect(c.recordingUrlSigningSecret).toBeUndefined();
    expect(c.retention.agencyRetentionDays).toBeUndefined();
    expect(c.retention.agencyTranscriptRetentionDays).toBe(30);
    expect(c.postCallAnalysis).toMatchObject({
      enabled: true,
      provider: 'openai_compatible',
      model: 'gpt-4o-mini',
      headers: {},
      structuredOutput: 'json_schema',
      temperature: 0.3,
      input: 'transcript',
      timeoutMs: 30000,
      azureApiVersion: '2024-12-01-preview',
    });
    expect(c.postCallAnalysis.baseUrl).toBeUndefined();
  });

  it('parses VOICELINK_RECORDING_HOSTS as a trimmed comma list', () => {
    expect(parse({ VOICELINK_RECORDING_HOSTS: ' a.test, b.test ,,' }).voicelinkRecording.allowedHosts).toEqual(['a.test', 'b.test']);
  });

  it('post-call analysis key falls back to OPENAI_API_KEY, or GEMINI_API_KEY for gemini', () => {
    expect(parse({ OPENAI_API_KEY: 'o' }).postCallAnalysis.apiKey).toBe('o');
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'gemini', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' }).postCallAnalysis.apiKey).toBe('g');
    expect(parse({ POST_CALL_ANALYSIS_API_KEY: 'dedicated', OPENAI_API_KEY: 'o' }).postCallAnalysis.apiKey).toBe('dedicated');
  });

  // OpenAI's key is a bearer token: a base URL sends requests to another host.
  it('never sends OPENAI_API_KEY to a base URL or to Azure', () => {
    const third = parse({ OPENAI_API_KEY: 'o', POST_CALL_ANALYSIS_BASE_URL: 'https://openrouter.ai/api/v1' });
    expect(third.postCallAnalysis.apiKey).toBeUndefined();
    expect(parse({ OPENAI_API_KEY: 'o', POST_CALL_ANALYSIS_PROVIDER: 'azure_openai' }).postCallAnalysis.apiKey).toBeUndefined();
    expect(parse({
      OPENAI_API_KEY: 'o', POST_CALL_ANALYSIS_BASE_URL: 'https://openrouter.ai/api/v1', POST_CALL_ANALYSIS_API_KEY: 'or',
    }).postCallAnalysis.apiKey).toBe('or');
  });

  it('defaults the model per provider', () => {
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'gemini' }).postCallAnalysis.model).toBe('gemini-3.5-flash');
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'azure_openai' }).postCallAnalysis.model).toBe('gpt-4o-mini');
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'gemini', POST_CALL_ANALYSIS_MODEL: '' }).postCallAnalysis.model).toBe('gemini-3.5-flash');
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'gemini', POST_CALL_ANALYSIS_MODEL: 'gemini-2.5-pro' }).postCallAnalysis.model).toBe('gemini-2.5-pro');
  });

  it('accepts openai as the older spelling of openai_compatible', () => {
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'openai' }).postCallAnalysis.provider).toBe('openai_compatible');
    expect(parse({ POST_CALL_ANALYSIS_PROVIDER: 'azure_openai' }).postCallAnalysis.provider).toBe('azure_openai');
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_PROVIDER: 'anthropic' }).ok).toBe(false);
  });

  it('reads the OpenAI-compatible endpoint settings', () => {
    const c = parse({
      POST_CALL_ANALYSIS_BASE_URL: 'https://openrouter.ai/api/v1',
      POST_CALL_ANALYSIS_HEADERS: 'HTTP-Referer=https://agency.test, X-Title = Magick Agency ,',
      POST_CALL_ANALYSIS_STRUCTURED_OUTPUT: 'json_object',
    }).postCallAnalysis;
    expect(c.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(c.headers).toEqual({ 'HTTP-Referer': 'https://agency.test', 'X-Title': 'Magick Agency' });
    expect(c.structuredOutput).toBe('json_object');
    expect(parse({ POST_CALL_ANALYSIS_BASE_URL: '' }).postCallAnalysis.baseUrl).toBeUndefined();
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_BASE_URL: 'not a url' }).ok).toBe(false);
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_STRUCTURED_OUTPUT: 'xml' }).ok).toBe(false);
  });

  it('refuses a malformed header entry without echoing its value', () => {
    const r = parseConfig({ ...base, POST_CALL_ANALYSIS_HEADERS: 'Authorization: Bearer sk-secret' });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    const badName = parseConfig({ ...base, POST_CALL_ANALYSIS_HEADERS: 'My Header=sk-secret' });
    expect(badName.ok).toBe(false);
    expect(JSON.stringify(badName)).toContain('not a valid HTTP token');
    expect(JSON.stringify(badName)).not.toContain('sk-secret');
  });

  it('temperature: a number, or none to send none; anything else fails boot', () => {
    expect(parse({ POST_CALL_ANALYSIS_TEMPERATURE: '0' }).postCallAnalysis.temperature).toBe(0);
    expect(parse({ POST_CALL_ANALYSIS_TEMPERATURE: 'none' }).postCallAnalysis.temperature).toBeNull();
    expect(parse({ POST_CALL_ANALYSIS_TEMPERATURE: '' }).postCallAnalysis.temperature).toBe(0.3);
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_TEMPERATURE: 'warm' }).ok).toBe(false);
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_TEMPERATURE: '3' }).ok).toBe(false);
  });

  it('audio input: gemini only, with a 180 s default timeout that an explicit value overrides', () => {
    const audio = parse({ POST_CALL_ANALYSIS_PROVIDER: 'gemini', POST_CALL_ANALYSIS_INPUT: 'audio' }).postCallAnalysis;
    expect(audio).toMatchObject({ input: 'audio', timeoutMs: 180000 });
    expect(parse({
      POST_CALL_ANALYSIS_PROVIDER: 'gemini', POST_CALL_ANALYSIS_INPUT: 'audio', POST_CALL_ANALYSIS_TIMEOUT_MS: '60000',
    }).postCallAnalysis.timeoutMs).toBe(60000);

    const refused = parseConfig({ ...base, POST_CALL_ANALYSIS_INPUT: 'audio' });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).toContain('needs a provider that accepts audio (gemini)');
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_PROVIDER: 'azure_openai', POST_CALL_ANALYSIS_INPUT: 'audio' }).ok).toBe(false);
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_INPUT: 'video' }).ok).toBe(false);
    // Empty is unset, and a disabled block is not refused for its input.
    expect(parse({ POST_CALL_ANALYSIS_INPUT: '' }).postCallAnalysis.input).toBe('transcript');
    expect(parse({ POST_CALL_ANALYSIS_STRUCTURED_OUTPUT: '' }).postCallAnalysis.structuredOutput).toBe('json_schema');
    expect(parseConfig({ ...base, POST_CALL_ANALYSIS_ENABLED: 'false', POST_CALL_ANALYSIS_INPUT: 'audio' }).ok).toBe(true);
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
