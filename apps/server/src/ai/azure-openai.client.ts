import { AzureOpenAI } from 'openai';
import { chatCompletionJson } from './openai-chat.js';
import {
  AiError,
  type AiClient,
  type AiFile,
  type AiJsonRequest,
  type AiJsonResponse,
  type AzureOpenAiClientConfig,
} from './types.js';

/** Azure OpenAI: the same Chat Completions request, Azure's endpoint, API version and deployment. */
export class AzureOpenAiClient implements AiClient {
  readonly provider = 'azure_openai' as const;
  readonly model: string;
  readonly capabilities = { fileInput: false };
  private readonly client: AzureOpenAI;

  constructor(private readonly cfg: AzureOpenAiClientConfig) {
    this.model = cfg.model;
    this.client = new AzureOpenAI({
      apiKey: cfg.apiKey,
      endpoint: cfg.endpoint,
      apiVersion: cfg.apiVersion,
      deployment: cfg.deployment,
      // One request per call: the caller owns retries (the SDK would add 2 of its own).
      maxRetries: 0,
    });
  }

  generateJson(req: AiJsonRequest): Promise<AiJsonResponse> {
    return chatCompletionJson(this.client, {
      provider: this.provider,
      model: this.model,
      // Azure's GPT-4o-class deployments support json_schema.
      structuredOutput: 'json_schema',
      ...(this.cfg.timeoutMs !== undefined ? { defaultTimeoutMs: this.cfg.timeoutMs } : {}),
    }, req);
  }

  async uploadFile(): Promise<AiFile> {
    throw new AiError('unsupported_operation', this.provider, 'azure_openai does not support file upload');
  }

  async deleteFile(): Promise<void> {
    throw new AiError('unsupported_operation', this.provider, 'azure_openai does not support file upload');
  }
}
