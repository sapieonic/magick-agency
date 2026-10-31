import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { rejectPathEscapingParams } from './helpers/path-params.js';
import { registerSoftphoneSessionRoutes } from './proxy-agency-softphone/sessions.js';
import { registerSoftphoneCallRoutes } from './proxy-agency-softphone/calls.js';
import { registerSoftphoneReadRoutes } from './proxy-agency-softphone/reads.js';
import { registerSoftphoneSettingsRoutes } from './proxy-agency-softphone/settings.js';

/*
 * The soft phone (docs/softphone.md §6), served at the console's paths under
 * `/proxy/agency` (decision B16): `/softphone/*` and the two switch routes on a campaign
 * session (`/sessions/:id/softphone`, `/sessions/:id/softphone/return`, §4.2). Each route
 * authenticates (session, tenant context) and applies its RBAC floor; a route that STARTS
 * work (open a session, dial, switch) or reads the recording or settings then requires
 * `agency_softphone_enabled` (`softphone_disabled`, 403), while the routes that FINISH a
 * call already started do not (`shared.ts`, `requireSoftphoneEnabled`). Each validates its
 * body or query and runs the internal handler (`agency/softphone.ts`) in-process through
 * `callCore`.
 *
 * The floors:
 *  - `agency.softphone.dial` (agent) on every route but two: the agent's own session and
 *    calls. Reading or acting on ANOTHER agent's call, listing the account's calls, and
 *    tagging a campaign one is not staffed on need `agency.supervise` as well, which this
 *    layer derives from the caller's role (`shared.ts`, `resolveSoftphoneActor`) and the
 *    internal handler applies; it is never taken from the body. So does a call's media
 *    (the detail's `media`, withheld from an agent even on their own call).
 *  - `agency.supervise` on `GET /softphone/calls/:id/recording`: no recordings for agents,
 *    their own calls included, as for a campaign call (`rbac.ts`).
 *  - `agency.softphone.manage` (account admin) on `PUT /softphone/settings`.
 *
 * Ids: the agency plugin's wrapper scope answers a malformed `:id` with this family's
 * not-found body (`call_not_found` / `session_not_found`) before any `uuid` cast (22P02).
 */
export async function proxyAgencySoftphoneRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // Defence in depth on the ids interpolated into internal paths, as on the agent plugin.
  app.addHook('preHandler', rejectPathEscapingParams());

  await registerSoftphoneSessionRoutes(app);
  await registerSoftphoneCallRoutes(app);
  await registerSoftphoneReadRoutes(app);
  await registerSoftphoneSettingsRoutes(app);
}
