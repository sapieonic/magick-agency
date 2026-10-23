import type { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { redactUrl } from '../../utils/redact-url.js';

const log = createChildLogger({ component: 'error-handler' });

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
  const statusCode = error.statusCode || 500;
  const requestId = (request as any).requestId || request.id;
  // `redactUrl`, not `request.url`: this handler fires for ANY route, and the
  // two public `/invites/*` routes carry a bearer credential in their path. A
  // 500 during a claim (a database blip is enough) would otherwise write that
  // token to centralised logging — see `src/utils/redact-url.ts`.
  const url = redactUrl(request.url);

  if (statusCode >= 500) {
    log.error({
      err: error,
      requestId,
      method: request.method,
      url,
    }, 'Internal server error');
  } else {
    log.warn({
      statusCode,
      message: error.message,
      requestId,
      method: request.method,
      url,
    }, 'Client error');
  }

  // A 429 is the rate limiter's authored body (`errorResponseBuilder` in
  // `rate-limit.middleware.ts`), which `@fastify/rate-limit` THROWS as a plain object, so it
  // arrives here with no `name`. Rebuilt from `name` alone it reached every client as
  // `error: 'Error'` without `retryAfter`, the field the console's poll backoff reads
  // first. Its label and `retryAfter` are kept; nothing else about the shape changes.
  const limiter = statusCode === 429 ? (error as unknown as { error?: unknown; retryAfter?: unknown }) : null;

  reply.code(statusCode).send({
    error: error.name || (typeof limiter?.error === 'string' ? limiter.error : 'Error'),
    message: error.message,
    statusCode,
    requestId,
    ...(typeof limiter?.retryAfter === 'number' ? { retryAfter: limiter.retryAfter } : {}),
  });
}
