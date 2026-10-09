import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import { agencyErrorHandler } from './middleware/agency-error-handler.js';
import { agencyCampaignRoutes, type AgencyCampaignRouteDeps } from './routes/agency-campaigns.routes.js';
import { agencyAgentRoutes } from './routes/agency-agents.routes.js';
import { agencyRoutes } from './routes/agency.routes.js';
import type { AgencyRuntime } from '../agency/runtime.js';

/**
 * Core's agency handler modules, as a private in-process instance (decision B16).
 *
 * In MagickVoice these plugins were mounted on core's public server under
 * `/api/v1/agency-campaigns`, `/api/v1/agency-agents` and `/api/v1/agency`
 * (core `src/index.ts:694-701`@4850d1d9), each behind `authMiddleware` (a tenant API
 * key plus the `x-mgkvc-tenant` / `x-mgkvc-account` headers), and master reached them
 * through `proxyToCore`. Here they are registered on THIS instance at the same prefixes,
 * which is never listened on and never joins the app's route table: the only way in is
 * `callCore` (`core-dispatch.ts`), called by master's handlers after lane A's session,
 * tenant-context and RBAC chain has run. So none of them is a separately exposed URL
 * surface, and the API key is gone.
 *
 * Kept from core's server, because they change what a handler sees or answers:
 *  - `maxParamLength: 200` (core `index.ts:589`; find-my-way's default is 100, and a
 *    longer param would 404 where core answered);
 *  - the error handler (core's `errorHandler`; master's verbatim twin is used — it only
 *    adds URL redaction to the log line — because the two files share one path here),
 *    wrapped with the 22P02 → 400 backstop (`agency-error-handler.ts`): core's own id
 *    columns were text, so a malformed id that core matched against nothing is a `22P02`
 *    on agency's UUID columns, and it must not come back through `callCore` as a 500.
 * Not carried: CORS, multipart, the rate limiter and the WebSocket plugin (the outer app
 * owns those), the request-id middleware and the request metrics (the outer request is
 * the one that is logged and measured).
 */
export interface CoreHandlerDeps {
  campaigns: AgencyCampaignRouteDeps;
  /**
   * Core's `agencyRoutes` (sessions and attempts) took `agencyRuntime` (core `index.ts:694`).
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
  // core `src/index.ts:694-700`. Each plugin takes its own `authMiddleware` hook.
  if (deps.agency) {
    const runtime = deps.agency.runtime;
    await app.register((a) => agencyRoutes(a, runtime), { prefix: '/api/v1/agency' });
  }
  await app.register((a) => agencyCampaignRoutes(a, deps.campaigns), { prefix: '/api/v1/agency-campaigns' });
  await app.register(agencyAgentRoutes, { prefix: '/api/v1/agency-agents' });
  await app.ready();
  return app;
}
