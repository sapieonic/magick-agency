import type { AppConfig } from '../config/schema.js';
import { PostCallAnalysisService } from './analysis.service.js';
import { aiClientConfigProblem, createAiClient, type AiClientConfig } from '../ai/index.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'analysis-factory' });

/**
 * The AI client config post-call analysis runs on, from the `postCallAnalysis` block.
 * The API key fallbacks (GEMINI_API_KEY; OPENAI_API_KEY only without a base URL) are
 * already applied by the env reader; Azure's own key wins over the shared one here.
 */
export function postCallAnalysisClientConfig(config: AppConfig): AiClientConfig {
  const pca = config.postCallAnalysis;
  switch (pca.provider) {
    case 'azure_openai':
      return {
        provider: 'azure_openai',
        model: pca.model,
        apiKey: pca.azureApiKey || pca.apiKey || '',
        endpoint: pca.azureEndpoint ?? '',
        apiVersion: pca.azureApiVersion,
        deployment: pca.azureDeployment,
        timeoutMs: pca.timeoutMs,
      };
    case 'gemini':
      return { provider: 'gemini', model: pca.model, apiKey: pca.apiKey ?? '', timeoutMs: pca.timeoutMs };
    case 'openai_compatible':
      return {
        provider: 'openai_compatible',
        model: pca.model,
        ...(pca.apiKey ? { apiKey: pca.apiKey } : {}),
        ...(pca.baseUrl ? { baseUrl: pca.baseUrl } : {}),
        headers: pca.headers,
        structuredOutput: pca.structuredOutput,
        timeoutMs: pca.timeoutMs,
      };
  }
}

export function createAnalysisService(config: AppConfig): PostCallAnalysisService | null {
  if (!config.postCallAnalysis.enabled) {
    log.info('Post-call analysis is disabled');
    return null;
  }

  const clientConfig = postCallAnalysisClientConfig(config);
  const problem = aiClientConfigProblem(clientConfig);
  if (problem) {
    log.warn({ provider: clientConfig.provider }, `Post-call analysis enabled but ${problem} — disabling`);
    return null;
  }

  const client = createAiClient(clientConfig);
  log.info(
    { provider: client.provider, model: client.model, input: config.postCallAnalysis.input },
    'Post-call analysis service initialized',
  );
  return new PostCallAnalysisService({
    client,
    timeoutMs: config.postCallAnalysis.timeoutMs,
    maxConversationTurns: config.postCallAnalysis.maxConversationTurns,
    temperature: config.postCallAnalysis.temperature,
    input: config.postCallAnalysis.input,
  });
}

export { PostCallAnalysisService } from './analysis.service.js';
export type { AnalysisAudio, AnalysisServiceConfig } from './analysis.service.js';

// Shipped custom-dimension presets — re-exported here so a consumer that already
// imports the analysis layer finds them without knowing the file. A consumer that
// must not load the analysis service imports `./dimension-presets.js` directly.
export { KB_GROUNDING_DIMENSION, ANALYSIS_DIMENSION_PRESETS } from './dimension-presets.js';
