import type OpenAI from 'openai';
import {
  AiError,
  type AiFinish,
  type AiJsonRequest,
  type AiJsonResponse,
  type AiProvider,
  type AiRateLimitDetail,
  type AiStructuredOutputMode,
} from './types.js';

/**
 * The Chat Completions request and response mapping shared by every client built on
 * the `openai` SDK (OpenAI-compatible endpoints and Azure OpenAI). Each client owns
 * its SDK construction; this owns what is sent and how the answer is read.
 */
export async function chatCompletionJson(
  client: OpenAI,
  args: {
    provider: AiProvider;
    model: string;
    structuredOutput: AiStructuredOutputMode;
    defaultTimeoutMs?: number;
  },
  req: AiJsonRequest,
): Promise<AiJsonResponse> {
  const userText = req.input.map((part) => {
    if (part.type !== 'text') {
      throw new AiError('unsupported_operation', args.provider, `${args.provider} does not accept file input`);
    }
    return part.text;
  }).join('\n\n');

  const system = args.structuredOutput === 'json_object'
    ? [req.system, jsonObjectInstruction(req.schema.schema)].filter(Boolean).join('\n\n')
    : req.system;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userText });

  const timeoutMs = req.timeoutMs ?? args.defaultTimeoutMs;
  let response: OpenAI.Chat.ChatCompletion;
  try {
    response = await client.chat.completions.create(
      {
        model: args.model,
        messages,
        response_format: args.structuredOutput === 'json_object'
          ? { type: 'json_object' }
          : {
            type: 'json_schema',
            json_schema: {
              name: req.schema.name,
              schema: req.schema.schema,
              ...(req.schema.strict !== undefined ? { strict: req.schema.strict } : {}),
            },
          },
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
      },
      timeoutMs !== undefined ? { signal: AbortSignal.timeout(timeoutMs) } : undefined,
    );
  } catch (err) {
    throw toAiError(args.provider, err);
  }

  const choice = response.choices?.[0];
  const usage = response.usage;
  return {
    text: choice?.message?.content ?? '',
    finish: choice ? mapFinish(choice.finish_reason) : 'no_output',
    ...(choice?.finish_reason ? { providerFinishReason: String(choice.finish_reason) } : {}),
    usage: {
      ...(usage?.prompt_tokens != null ? { inputTokens: usage.prompt_tokens } : {}),
      ...(usage?.completion_tokens != null ? { outputTokens: usage.completion_tokens } : {}),
      ...(usage?.completion_tokens_details?.reasoning_tokens != null
        ? { thoughtTokens: usage.completion_tokens_details.reasoning_tokens }
        : {}),
      ...(usage?.total_tokens != null ? { totalTokens: usage.total_tokens } : {}),
    },
    model: args.model,
    ...(response.model ? { modelVersion: response.model } : {}),
  };
}

function mapFinish(reason: string | null | undefined): AiFinish {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'blocked';
    default:
      // A compatible server that leaves finish_reason null still answered.
      return reason == null ? 'stop' : 'other';
  }
}

/**
 * JSON mode guarantees valid JSON, not this shape, so the shape is put in front of
 * the model. OpenAI also refuses JSON mode unless "JSON" appears in the messages,
 * which this sentence guarantees.
 */
function jsonObjectInstruction(schema: Record<string, unknown>): string {
  return `Respond with a single JSON object that conforms to this JSON Schema:\n${JSON.stringify(schema)}`;
}

function toAiError(provider: AiProvider, err: unknown): AiError {
  if (err instanceof AiError) return err;
  const message = (err as Error)?.message ?? String(err);
  const status = typeof (err as { status?: unknown })?.status === 'number'
    ? (err as { status: number }).status
    : undefined;
  if (status === 429) {
    return new AiError('rate_limited', provider, message, status, { cause: err, rateLimit: openAiRateLimitDetail(err) });
  }
  return new AiError('request_failed', provider, message, status, { cause: err });
}

/**
 * What an OpenAI-style 429 said: the SDK's `code` (`insufficient_quota` is a billing stop,
 * `rate_limit_exceeded` a short limit; Azure's bare `"429"` says nothing and is left out), the
 * body's message and the `retry-after-ms` or `retry-after` header (a `Headers` instance or a
 * plain record, depending on the SDK version; an HTTP-date is left out).
 */
export function openAiRateLimitDetail(err: unknown): AiRateLimitDetail {
  const e = err as { code?: unknown; error?: { message?: unknown } | null; headers?: unknown } | null;
  const detail: AiRateLimitDetail = {};
  if (typeof e?.code === 'string' && e.code && !/^\d+$/.test(e.code)) detail.vendorCode = e.code;
  if (typeof e?.error?.message === 'string' && e.error.message) detail.vendorMessage = e.error.message;
  const headers = e?.headers as { get?: (name: string) => unknown } | Record<string, unknown> | undefined;
  const header = (name: string): number => {
    const raw = typeof headers?.get === 'function'
      ? headers.get(name)
      : (headers as Record<string, unknown> | undefined)?.[name];
    return typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  };
  const ms = header('retry-after-ms');
  const seconds = Number.isFinite(ms) ? ms / 1000 : header('retry-after');
  if (Number.isFinite(seconds) && seconds >= 0) detail.retryAfterSeconds = Math.ceil(seconds);
  return detail;
}
