import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Refuse a malformed id in a route param BEFORE it reaches a `$n::uuid` / `uuid[]` cast.
 *
 * The baseline types these ids `UUID`, so a non-UUID value is a Postgres `22P02` — a 500
 * for what is a caller's typo. Each route family names, per param, the answer its route
 * gives for an id it cannot find, so a malformed id is indistinguishable from an unknown one (the id is not a capability; whether a well-formed id exists is not the
 * caller's business either).
 *
 * Registered as a preHandler in the wrapper scope `agencyPlugin` gives each family, so it
 * runs ahead of that family's own session → tenant-context → RBAC hooks, and the route files
 * need no id checks of their own. An unauthenticated caller with a malformed id therefore learns only
 * that the id is malformed, which says nothing about anybody's data.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MalformedIdAnswer {
  status: number;
  body: Record<string, unknown>;
}

export function rejectMalformedIdParams(
  answers: Readonly<Record<string, MalformedIdAnswer>>,
  opts: {
    /**
     * Apply only to routes whose registered URL starts with this (e.g. the campaign routes
     * of a plugin that also serves `/ingest/jobs/:id`, where the same param name means a
     * different object with a different not-found answer).
     */
    onlyUnder?: string;
  } = {},
): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (opts.onlyUnder && !(request.routeOptions.url ?? '').startsWith(opts.onlyUnder)) return undefined;
    const params = (request.params ?? {}) as Record<string, unknown>;
    for (const [name, answer] of Object.entries(answers)) {
      const value = params[name];
      if (value === undefined) continue;
      if (typeof value !== 'string' || !UUID_RE.test(value)) {
        return reply.code(answer.status).send(answer.body);
      }
    }
    return undefined;
  };
}

/**
 * `X-Tenant-Id` must be a UUID before `tenantContextMiddleware` passes it to
 * `membershipRepository.findByUserAndTenant` (a `uuid` column; a malformed value is a
 * `22P02` → 500). Refused as the caller's error, alongside that middleware's own 400 for a
 * missing header. Absent is left to the middleware, which answers it. `X-Account-Id` needs
 * no twin: the middleware already maps its `22P02` to the ownership refusal (403).
 *
 * Scoped to the agency API (registered in `agencyPlugin`); the platform routes keep the
 * middleware's own behaviour.
 */
export function rejectMalformedTenantHeader(): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = request.headers['x-tenant-id'];
    if (tenantId === undefined || tenantId === '') return undefined;
    if (typeof tenantId !== 'string' || !UUID_RE.test(tenantId)) {
      return reply.code(400).send({ error: 'Bad Request', message: 'X-Tenant-Id must be a UUID' });
    }
    return undefined;
  };
}
