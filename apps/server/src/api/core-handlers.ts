import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { agencyErrorHandler } from './middleware/agency-error-handler.js';
import { agencyCampaignRoutes, type AgencyCampaignRouteDeps } from './routes/agency-campaigns.routes.js';
import { agencyAgentRoutes } from './routes/agency-agents.routes.js';
import { agencyRoutes } from './routes/agency.routes.js';
import type { AgencyRuntime } from '../agency/runtime.js';

/**
 * The internal handler instance: the agency handler modules on a private Fastify instance
 * (decision B16).
 *
 * The plugins are registered under `/api/v1/agency-campaigns`, `/api/v1/agency-agents` and
 * `/api/v1/agency`, each behind its own `authMiddleware` (the `x-mgkvc-tenant` /
 * `x-mgkvc-account` headers). This instance is never listened on and never joins the app's
 * route table: the only way in is `callCore` (`core-dispatch.ts`), called by the public API
 * layer's handlers after the session, tenant-context and RBAC chain has run. So none of
 * them is a separately exposed URL surface, and there is no API key.
 *
 * Server options that change what a handler sees or answers:
 *  - `maxParamLength: 200` (find-my-way's default is 100, and a longer param would 404);
 *  - the shared error handler (it also redacts URLs in its log line), wrapped with the
 *    22P02 → 400 backstop (`agency-error-handler.ts`): the id columns are UUIDs, so a
 *    malformed id is a `22P02` from Postgres, and it must not come back through `callCore`
 *    as a 500.
 * Not registered here: CORS, multipart, the rate limiter and the WebSocket plugin (the outer
 * app owns those), the request-id middleware and the request metrics (the outer request is
 * the one that is logged and measured).
 */
export interface CoreHandlerDeps {
  campaigns: AgencyCampaignRouteDeps;
  /**
   * `agencyRoutes` (sessions and attempts) needs the agency runtime.
   * Omitted (tests that do not exercise them): the routes are not registered, and a
   * `callCore` to them is Fastify's 404.
   */
  agency?: { runtime: AgencyRuntime };
  /** Tests only: collects every route the private instance registers (enumerated, never grepped). */
  onRoute?: (route: RouteOptions) => void;
}

export async function buildCoreHandlers(deps: CoreHandlerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, routerOptions: { maxParamLength: 200 } });
  app.setErrorHandler(agencyErrorHandler);
  if (deps.onRoute) app.addHook('onRoute', deps.onRoute);
  // Each plugin takes its own `authMiddleware` hook.
  if (deps.agency) {
    const runtime = deps.agency.runtime;
    await app.register((a) => agencyRoutes(a, runtime), { prefix: '/api/v1/agency' });
  }
  await app.register((a) => agencyCampaignRoutes(a, deps.campaigns), { prefix: '/api/v1/agency-campaigns' });
  await app.register(agencyAgentRoutes, { prefix: '/api/v1/agency-agents' });
  await app.ready();
  return app;
}
