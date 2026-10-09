import type { AppConfig } from '../config/schema.js';
import { PostCallAnalysisService, type AnalysisServiceConfig } from './analysis.service.js';
import { createChildLogger } from '@magick-agency/observability';

const log = createChildLogger({ component: 'analysis-factory' });

export function createAnalysisService(config: AppConfig): PostCallAnalysisService | null {
  if (!config.postCallAnalysis.enabled) {
    log.info('Post-call analysis is disabled');
    return null;
  }

  const provider = config.postCallAnalysis.provider;

  // Resolve API key: dedicated > provider-specific. (The env reader in
  // `config/blocks/analysis.ts` already falls back to OPENAI_API_KEY / GEMINI_API_KEY
  // when it fills `postCallAnalysis.apiKey`.)
  let apiKey: string | undefined;
  if (provider === 'azure_openai') {
    apiKey = config.postCallAnalysis.azureApiKey || config.postCallAnalysis.apiKey;
  } else {
    apiKey = config.postCallAnalysis.apiKey;
  }

  if (!apiKey) {
    log.warn('Post-call analysis enabled but no API key available — disabling');
    return null;
  }

  // Azure OpenAI requires endpoint
  if (provider === 'azure_openai' && !config.postCallAnalysis.azureEndpoint) {
    log.warn('Azure OpenAI provider selected but POST_CALL_ANALYSIS_AZURE_ENDPOINT not set — disabling');
    return null;
  }

  const serviceConfig: AnalysisServiceConfig = {
    provider,
    apiKey,
    model: config.postCallAnalysis.model,
    timeoutMs: config.postCallAnalysis.timeoutMs,
    maxConversationTurns: config.postCallAnalysis.maxConversationTurns,
    azureEndpoint: config.postCallAnalysis.azureEndpoint,
    azureApiVersion: config.postCallAnalysis.azureApiVersion,
    azureDeployment: config.postCallAnalysis.azureDeployment,
  };

  log.info({ provider: serviceConfig.provider, model: serviceConfig.model }, 'Post-call analysis service initialized');
  return new PostCallAnalysisService(serviceConfig);
}

export { PostCallAnalysisService } from './analysis.service.js';
export type { AnalysisServiceConfig } from './analysis.service.js';

// Shipped custom-dimension presets — re-exported here so a consumer that already
// imports the analysis layer finds them without knowing the file. A consumer that
// must not load the analysis service imports `./dimension-presets.js` directly.
export { KB_GROUNDING_DIMENSION, ANALYSIS_DIMENSION_PRESETS } from './dimension-presets.js';
