import OpenAI from 'openai';
import { chatCompletionJson } from './openai-chat.js';
import {
  AiError,
  type AiClient,
  type AiFile,
  type AiJsonRequest,
  type AiJsonResponse,
  type OpenAiCompatibleClientConfig,
} from './types.js';

/**
 * Any endpoint that speaks OpenAI's Chat Completions API: OpenAI itself (no
 * `baseUrl`), or a gateway or self-hosted server (OpenRouter, Together, Groq,
 * LiteLLM, vLLM, Ollama, ...) at `baseUrl`.
 */
export class OpenAiCompatibleClient implements AiClient {
  readonly provider = 'openai_compatible' as const;
  readonly model: string;
  readonly capabilities = { fileInput: false };
  private readonly client: OpenAI;

  constructor(private readonly cfg: OpenAiCompatibleClientConfig) {
    this.model = cfg.model;
    this.client = new OpenAI({
      // The SDK refuses an empty key. A keyless self-hosted endpoint ignores the
      // bearer this sends; `aiClientConfigProblem` only allows that with a baseUrl.
      apiKey: cfg.apiKey || 'not-set',
      // One request per call: the caller owns retries (the SDK would add 2 of its own).
      maxRetries: 0,
      ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { defaultHeaders: cfg.headers } : {}),
    });
  }

  generateJson(req: AiJsonRequest): Promise<AiJsonResponse> {
    return chatCompletionJson(this.client, {
      provider: this.provider,
      model: this.model,
      structuredOutput: this.cfg.structuredOutput ?? 'json_schema',
      ...(this.cfg.timeoutMs !== undefined ? { defaultTimeoutMs: this.cfg.timeoutMs } : {}),
    }, req);
  }

  async uploadFile(): Promise<AiFile> {
    throw new AiError('unsupported_operation', this.provider, 'openai_compatible does not support file upload');
  }

  async deleteFile(): Promise<void> {
    throw new AiError('unsupported_operation', this.provider, 'openai_compatible does not support file upload');
  }
}
