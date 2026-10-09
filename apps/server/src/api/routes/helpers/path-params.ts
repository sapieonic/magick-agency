import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Guards for route params that get interpolated into an internal handler path
 * (the path a public route hands to `callCore`).
 *
 * ## Why this is its own module
 *
 * The hand-written public routes build their internal handler path by string
 * interpolation. Two definitions of "may this param reach an internal path" is
 * how they come to disagree, so there is one, here.
 *
 * ## What `callCore`'s chokepoint already covers, and what it does not
 *
 * `callCore` calls `isUnsafeCorePath` (`src/proxy/safe-core-path.ts`) on the
 * assembled path, and that guard is strictly stronger than any character check
 * against the DOT-SEGMENT family: it runs a WHATWG parse and refuses anything the
 * parser rewrites. So the textbook traversal —
 *
 *   GET /proxy/agency/campaigns/x%2F..%2F..%2Fknowledge-bases/attempts/a
 *
 * — is a 400 from `callCore`, along with the `%2e%2e`, `.%2e`, `.<TAB>.`, `#` and
 * `\` variants. **That is not the hole this module closes.**
 *
 * What the parse-based chokepoint deliberately does not refuse is a **bare extra
 * slash**. A path with no dot segments survives the parse byte-for-byte, so
 * `/agency-campaigns/c/attempts/a` is allowed — and it must be, because that is
 * an ordinary internal path. It is only dangerous when a caller put those extra
 * segments there through a param, and the public routes do not all share one
 * gate:
 *
 *   GET /proxy/agency/campaigns/:id       → `agency.campaigns.read`  (viewer, 10)
 *   GET .../campaigns/:id/attempts/:aId   → `agency.supervise` (account_admin, 30)
 *                                           + `allow_recording` for the media
 *
 * The first interpolates `:id` as the LAST segment of its internal path, so
 * without a guard a `viewer` sending `:id = c%2Fattempts%2Fa` would build the
 * agency attempt read through a route floored two levels below it, and
 * `:id = c%2Fattempts%2Fa%2Frecording` would reach the recording bytes with no
 * recording gate anywhere in the request — the gate on *hearing* a recording, not
 * just *enabling* it, reopened by a slash. RBAC is per public route, so that is
 * privilege escalation across features. It is not cross-tenant: the internal
 * handler still scopes by the caller's tenant context.
 *
 * Proven, not asserted: `test/unit/agency/agency-proxy-path-traversal.test.ts`
 * drives a real `viewer` through the campaign-detail route with the plugin hook
 * removed and gets a 200 on both.
 *
 * The secondary gain: the caller gets an error naming their own param instead of
 * `callCore`'s generic refusal.
 *
 * ## Reject, never encode
 *
 * A decision rather than a shortcut. `encodeURIComponent` would also close the
 * hole, but it changes the bytes of the path for every route it touches and only
 * stays correct while the internal handler percent-decodes its path params. A
 * reject-guard changes behaviour for exactly the requests that are exploits: no
 * uuid, numeric id, slug, hex digest or E.164 number contains any of these
 * characters.
 */

/** Characters that let an interpolated param escape its own path segment. */
export const PATH_ESCAPING_CHARS = /[/?#\\]/;

/** Thrown when an interpolated param would break out of its segment. */
export class UnsafePathParamError extends Error {
  constructor(readonly param: string) {
    super(`Path parameter :${param} contains a path separator or delimiter`);
    this.name = 'UnsafePathParamError';
  }
}

/**
 * The 400 body for a rejected param.
 *
 * Deliberately carries **no** `code`, because one buys nothing: the error mask
 * passes every 4xx through as it is (see `api/middleware/error-mask.middleware.ts`),
 * and the only caller that can produce this response is one probing for a
 * traversal.
 */
export function pathEscapingParamRejection(param: string): { error: string; message: string } {
  return {
    error: 'Bad Request',
    message: `Invalid ${param}: path separators are not allowed`,
  };
}

/**
 * The shape a route param must have to be a uuid.
 *
 * Same class as `AGENCY_UUID_RE` in `src/notifications/agency-campaign-completion.ts`;
 * kept separate because that one is a shape check on an account id before an
 * email is addressed and this one is about a *path segment*, and collapsing them
 * would tie a route guard's fate to an unrelated module.
 */
const UUID_PATH_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plugin-level hook: refuse any route param that could escape its path segment.
 *
 * Registered on a plugin rather than written into each handler on purpose. A
 * per-handler check is a guard a new route can forget. A plugin hook is
 * inherited by every route the plugin registers, so the next one is covered
 * before anybody reviews it.
 *
 * It runs BEFORE the route's own `requirePermission`, because instance-level
 * `preHandler` hooks precede route-level ones. That ordering is fine: whether a
 * caller's own id contains a slash is a fact they already know, so answering 400
 * ahead of 403 discloses nothing. What matters is that it runs before the
 * handler calls `callCore`, so a traversal attempt is refused with an error
 * naming the param.
 */
export function rejectPathEscapingParams(): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    for (const [name, value] of Object.entries((request.params ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string' && PATH_ESCAPING_CHARS.test(value)) {
        request.log.warn({ param: name, url: request.url }, 'Rejected path-escaping route parameter');
        return reply.code(400).send(pathEscapingParamRejection(name));
      }
    }
    return undefined;
  };
}

/**
 * Plugin-level hook: refuse any route param that is not uuid-shaped.
 *
 * The tighter guard, for a plugin whose every param is a uuid on every real call
 * path. Preferred over {@link rejectPathEscapingParams} where it applies, for two
 * reasons: it refuses the whole space of malformed ids rather than the four
 * characters that happen to be exploitable today, and it gives the caller an
 * error about their id instead of an error about path separators.
 *
 * It is *not* the right guard for a plugin whose ids are also slugs, hex digests
 * or E.164 numbers — there the character class is the only thing that can be
 * tightened without changing behaviour for requests that are not exploits.
 */
export function requireUuidPathParams(): preHandlerHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    for (const [name, value] of Object.entries((request.params ?? {}) as Record<string, unknown>)) {
      if (typeof value !== 'string' || !UUID_PATH_PARAM.test(value)) {
        request.log.warn({ param: name, url: request.url }, 'Rejected non-uuid route parameter');
        return reply.code(400).send({
          error: 'Validation Error',
          message: `Invalid ${name}: expected a UUID`,
        });
      }
    }
    return undefined;
  };
}
