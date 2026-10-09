import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Q5 (Manas, 2026-10-09): the answer a REVOCATION route gives when its database change
 * committed but the cached copy could not be removed from Redis
 * (`redisCache.delForRevocation` returned false after its retries). Used only by routes
 * whose retry is idempotent — repeating the request re-applies the same change and runs
 * the cache delete again — so 503 is an instruction the admin can act on: retry until it
 * succeeds, rather than trusting a 2xx while the old access lingers for the cache TTL.
 *
 * A reviewed, fixed-shape 5xx (`preserveReviewedUpstreamError`), so the error mask passes
 * this explanation through instead of replacing it with "contact support".
 */
export function sendRevocationCacheUnavailable(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  request.preserveReviewedUpstreamError = true;
  return reply.code(503).send({
    error: 'Service Unavailable',
    code: 'cache_invalidation_failed',
    message:
      'The change was saved, but it could not yet be applied everywhere (cache unavailable). '
      + 'Please retry the same request; until it succeeds the previous access may still work for up to 30 minutes.',
  });
}
