// The AI client layer: every call to an AI provider goes out through a client built
// here. See `types.ts` for the contract and how to add a provider.
export { createAiClient, aiClientConfigProblem } from './factory.js';
export { AiError } from './types.js';
export type {
  AiClient,
  AiClientCapabilities,
  AiClientConfig,
  AiErrorKind,
  AiFile,
  AiFinish,
  AiInputPart,
  AiJsonRequest,
  AiJsonResponse,
  AiJsonSchema,
  AiProvider,
  AiPurpose,
  AiStructuredOutputMode,
  AiUsage,
  AzureOpenAiClientConfig,
  GeminiClientConfig,
  OpenAiCompatibleClientConfig,
} from './types.js';
