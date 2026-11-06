import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { agencyConfigSchema } from '../../config/blocks/agency.js';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { createUserRateLimit, type ChargeUserRateLimit } from '../middleware/rate-limit.middleware.js';
import { memorySearchStore, redisSearchStore } from '../../agency/customer-history/search-store.js';
import { registerCustomerSearchRoute } from './proxy-agency-customers/search.js';
import { registerCustomerTimelineRoute } from './proxy-agency-customers/timeline.js';
import { registerCustomerExportRoute } from './proxy-agency-customers/export.js';
import type { CustomerRoutesDeps } from './proxy-agency-customers/shared.js';

export { registerCustomerSearchRoute, registerCustomerTimelineRoute, registerCustomerExportRoute };

export interface ProxyAgencyCustomersOptions {
  ctx: AppContext | null;
}

/**
 * Customer history (`docs/customer-history.md`, CH1–CH12; the wire is
 * `packages/contracts/src/api/agency/customer-history.ts`): search one number and see every
 * interaction with it across the tenant's campaigns and the soft phone, in the accounts the caller
 * can see. Served at the console's paths under `/proxy/agency/customers/`, all `POST` so the number
 * travels in a body, never a URL (CH6). Read-only; the reads are this layer's own
 * (`src/agency/customer-history/` over `db/repositories/agency/customer-history.repository.ts`).
 *
 *  - `search` (`./proxy-agency-customers/search.ts`): the number → the summary, the first page
 *    and a `search_id` bound to the tenant and the user (Redis, `searchTtlMinutes`).
 *  - `timeline` (`./timeline.ts`): a page by `search_id`, filters and keyset cursor.
 *  - `export` (`./export.ts`): the filtered timeline as CSV, capped at `exportMaxRows`.
 *
 * Guards, in this order, on every route: session and tenant context (the hooks below);
 * `agency.customer_history.read` (floor `agent`, CH1); the dialer flag (`403 feature_disabled`);
 * for search and export the per-user search cap (`chs:<user id>`, `searchesPerMinute` a minute,
 * its own bucket besides the general per-user one, CH11: a 429 with `retryAfter`); then the body
 * (`400 invalid_search_request`), the number (`400 invalid_number`) or the search id (`404
 * search_expired`), and the cursor (`400 invalid_cursor`). No path params, so no id guard.
 *
 * Config: `agency.customerHistory` (`config/blocks/agency.ts`); without a context (route-table
 * tests) the block's defaults and an in-process search store.
 */
export async function proxyAgencyCustomersRoutes(app: FastifyInstance, opts: ProxyAgencyCustomersOptions): Promise<void> {
  const ctx = opts.ctx;
  const settings = ctx?.config.agency.customerHistory ?? agencyConfigSchema.parse({}).agency.customerHistory;
  // The cap is built on the first charge, not at registration: the agent-reach suite registers
  // this plugin on a bare Fastify (no rate limiter) only to enumerate its routes. On the real app
  // `buildApp` registers the limiter first, and a request on an app without one throws (a masked
  // 500), so the cap still cannot be silently missing. Built synchronously, so two first requests
  // share one limiter.
  let cap: ChargeUserRateLimit | null = null;
  const deps: CustomerRoutesDeps = {
    store: ctx
      ? redisSearchStore(ctx.redis, ctx.config.redis.keyPrefix, settings.searchTtlMinutes)
      : memorySearchStore(settings.searchTtlMinutes),
    cap: (request, reply) => {
      cap ??= createUserRateLimit(app, { namespace: 'chs', max: settings.searchesPerMinute, timeWindow: '1 minute' });
      return cap(request, reply);
    },
    exportMaxRows: settings.exportMaxRows,
  };

  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  await registerCustomerSearchRoute(app, deps);
  await registerCustomerTimelineRoute(app, deps);
  await registerCustomerExportRoute(app, deps);
}
