import { AzureOpenAiClient } from './azure-openai.client.js';
import { GeminiAiClient } from './gemini.client.js';
import { OpenAiCompatibleClient } from './openai-compatible.client.js';
import { AiError, type AiClient, type AiClientConfig, type AiProvider } from './types.js';

type ConfigFor<P extends AiProvider> = Extract<AiClientConfig, { provider: P }>;

/**
 * One builder per provider. Typed over `AiProvider`, so adding a provider to the union
 * without a builder here does not compile.
 */
const BUILDERS: { [P in AiProvider]: (cfg: ConfigFor<P>) => AiClient } = {
  openai_compatible: (cfg) => new OpenAiCompatibleClient(cfg),
  azure_openai: (cfg) => new AzureOpenAiClient(cfg),
  gemini: (cfg) => new GeminiAiClient(cfg),
};

/**
 * What is missing for this config to make a working client, or null when nothing is.
 * Callers that treat a missing key as "feature off" check this first and log it;
 * `createAiClient` throws it.
 */
export function aiClientConfigProblem(cfg: AiClientConfig): string | null {
  if (!cfg.model) return `${cfg.provider}: no model set`;
  switch (cfg.provider) {
    case 'openai_compatible':
      // A self-hosted endpoint may need no key; OpenAI itself always does.
      return !cfg.apiKey && !cfg.baseUrl ? 'openai_compatible: no API key, and no base URL for a keyless endpoint' : null;
    case 'azure_openai':
      if (!cfg.apiKey) return 'azure_openai: no API key';
      if (!cfg.endpoint) return 'azure_openai: no endpoint';
      return null;
    case 'gemini':
      return !cfg.apiKey ? 'gemini: no API key' : null;
  }
}

export function createAiClient(cfg: AiClientConfig): AiClient {
  const problem = aiClientConfigProblem(cfg);
  if (problem) throw new AiError('invalid_config', cfg.provider, problem);
  const build = BUILDERS[cfg.provider] as (c: AiClientConfig) => AiClient;
  return build(cfg);
}
