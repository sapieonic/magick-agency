import type { AppConfig } from '../config/schema.js';
import { createChildLogger } from '@magick-agency/observability';
import { createAiClient } from '../ai/index.js';
import { GeminiTranscriber } from './gemini-transcriber.js';
import { SarvamTranscriber } from './sarvam-transcriber.js';
import type { Transcriber } from './types.js';

const log = createChildLogger({ component: 'transcriber-factory' });

/** Languages the Sarvam batch STT supports (Indian languages only). */
const SARVAM_SUPPORTED_LANGUAGES = new Set([
  'hi-IN', 'en-IN', 'te-IN', 'ta-IN', 'kn-IN',
  'ml-IN', 'mr-IN', 'gu-IN', 'bn-IN', 'pa-IN', 'od-IN',
]);

/** True when Sarvam can transcribe the given BCP-47 language hint. */
export function isSarvamSupportedLanguage(languageHint: string): boolean {
  return SARVAM_SUPPORTED_LANGUAGES.has(languageHint);
}

/**
 * Construct the configured transcriber, or `null` to disable the feature.
 *
 * Returns `null` when `config.dialerAnalysis` is absent (env not set) or the block
 * is present but `!enabled` — mirroring `createAnalysisService` returning `null` to
 * disable post-call analysis. The caller (worker/runner) treats a `null` transcriber
 * as "feature off".
 */
export function createTranscriber(config: AppConfig): Transcriber | null {
  const cfg = config.dialerAnalysis;
  if (!cfg || !cfg.enabled) {
    return null;
  }

  if (cfg.transcriber === 'sarvam') {
    if (!cfg.sarvamApiKey) {
      log.warn('Dialer analysis transcriber=sarvam but no Sarvam API key available — disabling');
      return null;
    }
    return new SarvamTranscriber({
      apiKey: cfg.sarvamApiKey,
      // Sarvam's saarika family is the batch STT model; use the same env-model as
      // the streaming client if provided, else a sensible default.
      model: 'saarika:v2',
      timeoutMs: cfg.transcribeTimeoutMs,
    });
  }

  // Default: Gemini.
  if (!cfg.geminiApiKey) {
    log.warn('Dialer analysis transcriber=gemini but no Gemini API key available — disabling');
    return null;
  }
  return new GeminiTranscriber({
    client: createAiClient({
      provider: 'gemini',
      apiKey: cfg.geminiApiKey,
      model: cfg.geminiModel,
      timeoutMs: cfg.transcribeTimeoutMs,
    }),
    windowSeconds: cfg.transcribeWindowSeconds,
    maxOutputTokens: cfg.transcribeMaxOutputTokens,
  });
}

export { GeminiTranscriber } from './gemini-transcriber.js';
export { SarvamTranscriber } from './sarvam-transcriber.js';
export { fetchRecordingBytes } from './recording-fetcher.js';
export * from './types.js';
