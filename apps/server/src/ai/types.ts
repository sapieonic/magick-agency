/**
 * The one shape every AI call in this server goes through. Post-call analysis and
 * the Gemini transcriber both talk to a provider only through an {@link AiClient}
 * built by `createAiClient` (`ai/factory.ts`); nothing else imports a provider SDK.
 *
 * A client does ONE request per call and translates the provider's answer into this
 * neutral shape. Retry policy, windowing, prompt building and what a finish reason
 * means for the job stay with the caller, which knows the domain.
 *
 * Adding a provider: a value in {@link AiProvider}, its config in
 * {@link AiClientConfig}, a client class, and one entry in the factory's builder map
 * (the map is typed over `AiProvider`, so a missing entry does not compile).
 */

export type AiProvider = 'openai_compatible' | 'azure_openai' | 'gemini';

/**
 * What the request is for. Lets a provider apply tuning that is specific to its model
 * family without the caller knowing the family (Gemini: thinking settings and
 * sampling). It is also the label on every log line.
 */
export type AiPurpose = 'post_call_analysis' | 'transcription';

/** How an OpenAI-compatible endpoint is asked for JSON. */
export type AiStructuredOutputMode = 'json_schema' | 'json_object';

export interface OpenAiCompatibleClientConfig {
  provider: 'openai_compatible';
  /** Model id the endpoint expects, e.g. `gpt-4o-mini`, `llama-3.1-70b`. */
  model: string;
  /**
   * Bearer key. Optional only when `baseUrl` is set: a self-hosted endpoint
   * (vLLM, Ollama, a gateway on a private network) may not check one.
   */
  apiKey?: string;
  /** Base URL including the version path, e.g. `https://openrouter.ai/api/v1`. Unset = OpenAI. */
  baseUrl?: string;
  /** Extra headers on every request (e.g. OpenRouter's `HTTP-Referer`, a gateway's tenant header). */
  headers?: Record<string, string>;
  /**
   * `json_schema` (the default) sends the schema as `response_format`. `json_object`
   * is for endpoints that only support JSON mode: the schema is then given to the
   * model in the system message, and the caller's own parsing is the only check.
   */
  structuredOutput?: AiStructuredOutputMode;
  /** Default per-request timeout; a request's own `timeoutMs` wins. */
  timeoutMs?: number;
}

export interface AzureOpenAiClientConfig {
  provider: 'azure_openai';
  /** Sent as the request's `model`; also the deployment when `deployment` is unset. */
  model: string;
  apiKey: string;
  /** `https://<resource>.openai.azure.com` */
  endpoint: string;
  apiVersion: string;
  deployment?: string;
  timeoutMs?: number;
}

export interface GeminiClientConfig {
  provider: 'gemini';
  /** e.g. `gemini-3.5-flash`. */
  model: string;
  apiKey: string;
  /** Default per-request timeout, and the deadline for an uploaded file to become usable. */
  timeoutMs?: number;
}

export type AiClientConfig = OpenAiCompatibleClientConfig | AzureOpenAiClientConfig | GeminiClientConfig;

/** A file uploaded to the provider, referenced from a request instead of sent inline. */
export interface AiFile {
  readonly provider: AiProvider;
  /** Provider's handle, used to delete it. */
  readonly id: string;
  readonly uri: string;
  readonly mimeType: string;
}

export type AiInputPart =
  | { type: 'text'; text: string }
  | { type: 'file'; file: AiFile };

/** A JSON Schema plus the name and strictness OpenAI's `json_schema` response format wants. */
export interface AiJsonSchema {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AiJsonRequest {
  purpose: AiPurpose;
  system?: string;
  /** The user turn: text and file parts, in order. */
  input: AiInputPart[];
  schema: AiJsonSchema;
  /** Omitted = the provider's default. A provider may drop it for models that must not set it. */
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/**
 * Normalised finish:
 * - `stop`: complete;
 * - `max_tokens`: cut off by the output ceiling;
 * - `blocked`: refused by a safety or content filter, on input or output;
 * - `no_output`: no candidate or choice came back at all;
 * - `other`: anything else (`providerFinishReason` has the raw value).
 */
export type AiFinish = 'stop' | 'max_tokens' | 'blocked' | 'no_output' | 'other';

export interface AiUsage {
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
}

export interface AiJsonResponse {
  /** The model's text (the JSON, unparsed). Empty when there was none. */
  text: string;
  finish: AiFinish;
  /** The provider's own finish reason, verbatim. */
  providerFinishReason?: string;
  finishMessage?: string;
  /** Set when the provider refused the prompt itself (Gemini `promptFeedback`). */
  blockReason?: string;
  blockReasonMessage?: string;
  usage: AiUsage;
  model: string;
  modelVersion?: string;
  /** Tokens in the returned candidate, when the provider reports it. */
  outputTokenCount?: number;
}

export interface AiClientCapabilities {
  /** `uploadFile` works and `file` input parts are accepted (audio, for transcription). */
  fileInput: boolean;
}

export interface AiClient {
  readonly provider: AiProvider;
  readonly model: string;
  readonly capabilities: AiClientCapabilities;
  /** One request for a JSON answer that should match `req.schema`. */
  generateJson(req: AiJsonRequest): Promise<AiJsonResponse>;
  /**
   * Upload a file and wait until the provider can use it. Throws `unsupported_operation`
   * unless `capabilities.fileInput`. The caller owns deleting it.
   */
  uploadFile(data: Buffer, mimeType: string): Promise<AiFile>;
  deleteFile(file: AiFile): Promise<void>;
}

/**
 * - `rate_limited`: 429 or quota exhaustion; the caller should back off, not count a failure;
 * - `timeout`: a deadline this layer enforces passed (an uploaded file never became usable);
 * - `unsupported_input`: the provider could not process the input (a file it rejected);
 * - `unsupported_operation`: this provider or config cannot do what was asked;
 * - `invalid_config`: the client config is missing something required;
 * - `request_failed`: everything else.
 */
export type AiErrorKind =
  | 'rate_limited'
  | 'timeout'
  | 'unsupported_input'
  | 'unsupported_operation'
  | 'invalid_config'
  | 'request_failed';

/** Kinds that asking again moments later cannot fix (rate limits want a longer backoff). */
const NOT_RETRIED_IN_PLACE: ReadonlySet<AiErrorKind> = new Set([
  'rate_limited', 'unsupported_input', 'unsupported_operation', 'invalid_config',
]);

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    readonly provider: AiProvider,
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AiError';
  }

  /** Read by `utils/retry.ts`: these kinds are not retried in place. */
  get nonRetryable(): boolean {
    return NOT_RETRIED_IN_PLACE.has(this.kind);
  }
}
