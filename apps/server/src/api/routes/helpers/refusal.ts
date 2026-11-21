/*
 * The refusal body the contact-assignment routes send (`AgencyAssignmentErrorResponse`,
 * `AgencyAgentRetryErrorResponse`), and Compare agents' (`AgencyCompareErrorResponse`):
 * `{ error: <title>, code, message, details?, retry_after_seconds? }`.
 */
import type { FastifyReply } from 'fastify';

/** The `error` title of each refusal status. */
const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** The `error` a 400 carries in the agent-retry vocabulary, as the internal handlers' 400s do. */
export const VALIDATION_FAILED_TITLE = 'Validation failed';

export interface RefusalOptions {
  details?: Record<string, unknown>;
  /** The `error` of a 400 in place of `Bad Request` (the agent-retry vocabulary's {@link VALIDATION_FAILED_TITLE}). */
  badRequestTitle?: string;
  /**
   * When to try again, as the error mask's policy asks of an authored 429: the `Retry-After` header
   * and `retry_after_seconds` in the body.
   */
  retryAfterSeconds?: number;
}

export interface RefusalBody<C extends string = string> {
  error: string;
  code: C;
  message: string;
  details?: Record<string, unknown>;
  retry_after_seconds?: number;
}

/** Send `{ error: <title>, code, message, details?, retry_after_seconds? }` with `status`. */
export function sendRefusal<C extends string>(
  reply: FastifyReply,
  status: number,
  code: C,
  message: string,
  opts: RefusalOptions = {},
): FastifyReply {
  const error = status === 400 && opts.badRequestTitle !== undefined
    ? opts.badRequestTitle
    : STATUS_TITLES[status] ?? 'Error';
  const body: RefusalBody<C> = {
    error, code, message,
    ...(opts.details ? { details: opts.details } : {}),
    ...(opts.retryAfterSeconds !== undefined ? { retry_after_seconds: opts.retryAfterSeconds } : {}),
  };
  if (opts.retryAfterSeconds !== undefined) reply.header('Retry-After', String(opts.retryAfterSeconds));
  return reply.code(status).send(body);
}
