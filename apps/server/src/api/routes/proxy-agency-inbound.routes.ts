import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';
import { registerInboundRouteRoutes } from './proxy-agency-inbound/routes.js';
import { registerInboundMissedRoutes } from './proxy-agency-inbound/missed.js';
import { registerInboundCallRoutes } from './proxy-agency-inbound/calls.js';

/*
 * Inbound calls in the console (docs/inbound.md §7, §8.1; the wire is
 * `packages/contracts/src/api/agency/inbound.ts`), served at the console's paths under
 * `/proxy/agency/inbound/` (decision B16):
 *
 *  - `./proxy-agency-inbound/routes.ts`: the account's inbound routes (list, read, create, change,
 *    delete) and the route editor's choices (numbers, clips), `agency.inbound.write`;
 *  - `./proxy-agency-inbound/missed.ts`: the Missed inbound list and Mark handled,
 *    `agency.inbound.read` (an agent's own rows; the account's with `agency.supervise`);
 *  - `./proxy-agency-inbound/calls.ts` (P2): the answered call's finish (read, notes, hang up, the
 *    outcome, Mark DNC), `agency.inbound.read`: the agent who took it, or `agency.supervise`.
 *
 * Guards, in this order, on every route: session and tenant context (the hooks below); the
 * route's permission; `agency_inbound_enabled` (`403 inbound_disabled`, `./shared.ts`), except on
 * the finish routes, which are never gated (an agent the flag is switched off under can still
 * finish a call they took, as on the soft phone). Each runs
 * the internal handler (`agency/inbound.ts`) in-process through `callCore`, which validates,
 * checks the account's references and writes; this layer audits and fills names.
 *
 * Ids: the agency plugin's wrapper scope answers a malformed `:id` with this family's not-found
 * body (`inbound_route_not_found` / `inbound_missed_call_not_found`) before any `uuid` cast.
 */
export async function proxyAgencyInboundRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // Defence in depth on the ids interpolated into internal paths, as on the soft phone.
  app.addHook('preHandler', rejectPathEscapingParams());

  await registerInboundRouteRoutes(app);
  await registerInboundMissedRoutes(app);
  await registerInboundCallRoutes(app);
}
