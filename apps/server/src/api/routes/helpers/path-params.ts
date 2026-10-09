import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';

/**
 * Guards for route params that get interpolated into a core path.
 *
 * ## Why this is its own module
 *
 * The character class and the refusal below started life inside
 * {@link import('./passthrough.js').passthrough}, where they cover the 99
 * declarative proxy routes. They cover nothing else — and the hand-written proxy
 * routes are precisely the ones that build a core path by string interpolation,
 * so the guard the shared helper enforces was the guard the hand-written routes
 * bypassed. Two definitions of "may this param reach a core path" is how they
 * come to disagree, so there is one, here, and `passthrough.ts` reads it from
 * this file.
 *
 * ## What the pre-existing chokepoint already covers, and what it does not
 *
 * `proxyToCore` and `coreInternalRequest` both call `isUnsafeCorePath`
 * (`src/proxy/safe-core-path.ts`) on the assembled path, and that guard is
 * strictly stronger than any character check against the DOT-SEGMENT family: it
 * runs the same WHATWG parse `fetch` will run and refuses anything the parser
 * rewrites. So the textbook traversal —
 *
 *   GET /proxy/agency/campaigns/x%2F..%2F..%2Fknowledge-bases/attempts/a
 *
 * — was already a 400 from inside the proxy client, along with the `%2e%2e`,
 * `.%2e`, `.<TAB>.`, `#` and `\` variants. **Do not describe that as the hole
 * this module closes; it was closed before this module existed.**
 *
 * What the parse-based chokepoint deliberately does not refuse is a **bare extra
 * slash**. A path with no dot segments survives the parse byte-for-byte, so
 * `/agency-campaigns/c/attempts/a` is allowed — and it must be, because that is
 * an ordinary core path. It is only dangerous when a caller put those extra
 * segments there through a param, and master's routes do not all share one gate:
 *
 *   GET /proxy/agency/campaigns/:id       → `proxy.contact_lists.read`  (viewer, 10)
 *   GET .../campaigns/:id/attempts/:aId   → `agency.supervise` (account_admin, 30)
 *                                           + `agency.recording` for the media
 *
 * The first interpolates `:id` as the LAST segment of its core path, so a
 * `viewer` sending `:id = c%2Fattempts%2Fa` built core's agency attempt read
 * through a route floored two levels below it, and
 * `:id = c%2Fattempts%2Fa%2Frecording` reached the recording bytes with no
 * `agency.recording` anywhere in the request — the C2 gap this surface exists to
 * close ("the capability gated *enabling* recording, not *hearing* it"), reopened
 * by a slash. Master's governance is path-based, so that is privilege escalation
 * across features. It is not cross-tenant: core still scopes by the tenant's own
 * API key.
 *
 * Proven, not asserted: `test/unit/agency/agency-proxy-path-traversal.test.ts`
 * drives a real `viewer` through the campaign-detail route with the plugin hook
 * removed and gets a 200 on both.
 *
 * The secondary gain is cheaper and still worth having: the hand-written routes
 * resolve the tenant's core API key BEFORE calling `proxyToCore`, so without a
 * guard they AES-decrypt a credential for a request the proxy client is about to
 * refuse, and the caller gets the client's generic refusal instead of an error
 * naming their own param.
 *
 * ## Reject, never encode
 *
 * Inherited verbatim from `passthrough.ts`, and it is a decision rather than a
 * shortcut. `encodeURIComponent` would also close the hole, but it changes the
 * bytes on the wire for every route it touches and only stays correct while core
 * percent-decodes its path params — a cross-service assumption this repository
 * cannot verify. A reject-guard changes behaviour for exactly the requests that
 * are currently exploits: no uuid, numeric id, slug, hex digest or E.164 number
 * contains any of these characters.
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
 * The 400 body for a rejected param. Shared so both the declarative and the
 * hand-written surfaces refuse in the same words.
 *
 * Deliberately carries **no** `code`. A machine-readable code would have to be
 * allow-listed in `errorMaskHook` and registered in
 * `error-mask.route-emissions.test.ts`, and neither buys anything: the guard
 * fires before any core call, so no core status is recorded and the mask leaves
 * the body alone (see `api/middleware/error-mask.middleware.ts`). The only
 * caller that can produce this response is one probing for a traversal.
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
 * Same class as `AGENCY_UUID_RE` in `src/agency/agency-billing-contract.ts`,
 * which exists for the settlement payloads; kept separate because that one is
 * documented as the shape a value must have before it reaches a `UUID` *column*
 * and this one is about a *path segment*, and collapsing them would tie a route
 * guard's fate to a billing contract.
 */
const UUID_PATH_PARAM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plugin-level hook: refuse any route param that could escape its path segment.
 *
 * Registered on a plugin rather than written into each handler on purpose. The
 * finding this closes is that a hand-written route *forgot* a guard the shared
 * helper applies, and a per-handler check is a guard a new route can forget
 * again. A plugin hook is inherited by every route the plugin registers, so the
 * next one is covered before anybody reviews it.
 *
 * It runs BEFORE the route's own `requirePermission`, because instance-level
 * `preHandler` hooks precede route-level ones. That ordering is fine: whether a
 * caller's own id contains a slash is a fact they already know, so answering 400
 * ahead of 403 discloses nothing. What matters is that it runs before the handler
 * resolves a core API key or issues a core call — a traversal attempt has to be
 * *our* 4xx, or `errorMaskHook` reads it as core-forwarded and masks it.
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
