import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { agencyConfigSchema } from '../../config/blocks/agency.js';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { createUserRateLimit } from '../middleware/rate-limit.middleware.js';
import { memorySearchStore, redisSearchStore } from '../../agency/customer-history/search-store.js';
import { registerCustomerSearchRoute } from './proxy-agency-customers/search.js';
import { registerCustomerTimelineRoute } from './proxy-agency-customers/timeline.js';
import { registerCustomerExportRoute } from './proxy-agency-customers/export.js';
import { registerCustomerOptionsRoute } from './proxy-agency-customers/options.js';
import { useFamilyJsonParser, type CustomerRoutesDeps } from './proxy-agency-customers/shared.js';

export interface ProxyAgencyCustomersOptions {
  ctx: AppContext | null;
}

/**
 * Customer history (`docs/customer-history.md`, CH1–CH12; the wire is
 * `packages/contracts/src/api/agency/customer-history.ts`): search one number and see every
 * interaction with it across the tenant's campaigns and the soft phone, in the accounts the caller
 * can see. Served at the console's paths under `/proxy/agency/customers/`; the three that carry a
 * number are `POST` so it travels in a body, never a URL (CH6). Read-only; the reads are this layer's own
 * (`src/agency/customer-history/` over `db/repositories/agency/customer-history.repository.ts`).
 *
 *  - `search` (`./proxy-agency-customers/search.ts`): the number → the summary, the first page
 *    and a `search_id` bound to the tenant and the user (Redis, `searchTtlMinutes`).
 *  - `timeline` (`./timeline.ts`): a page by `search_id`, filters and keyset cursor.
 *  - `export` (`./export.ts`): the filtered timeline as CSV, capped at `exportMaxRows`.
 *  - `GET options` (`./options.ts`): the search box's default calling code; no number, no audit.
 *
 * Guards, in this order, on every route: session and tenant context (the hooks below);
 * `agency.customer_history.read` (floor `agent`, CH1); the dialer flag (`403 feature_disabled`);
 * for search and export the per-user search cap (`chs:<user id>`, `searchesPerMinute` a minute,
 * its own bucket besides the general per-user one, CH11: a 429 with `retryAfter` and the message
 * "You've searched a lot of numbers in a short time. Try again in N seconds."); then the body
 * (`400 invalid_search_request`, a body that is not JSON included: the family parses JSON itself,
 * `useFamilyJsonParser`), the country and the number (`400 invalid_search_request` /
 * `invalid_number`) or the search id (`404 search_expired`), and the cursor (`400
 * invalid_cursor`). No path params, so no id guard.
 *
 * Config: `agency.customerHistory` (`config/blocks/agency.ts`); without a context (route-table
 * tests) the block's defaults and an in-process search store.
 */
/** The search cap's 429 message (CH11), worded as the console's own. British English. */
function customerSearchRateLimitMessage(seconds: number): string {
  return seconds > 0
    ? `You've searched a lot of numbers in a short time. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
    : "You've searched a lot of numbers in a short time. Try again in a minute.";
}

export async function proxyAgencyCustomersRoutes(app: FastifyInstance, opts: ProxyAgencyCustomersOptions): Promise<void> {
  const ctx = opts.ctx;
  const settings = ctx?.config.agency.customerHistory ?? agencyConfigSchema.parse({}).agency.customerHistory;
  const deps: CustomerRoutesDeps = {
    store: ctx
      ? redisSearchStore(ctx.redis, ctx.config.redis.keyPrefix, settings.searchTtlMinutes)
      : memorySearchStore(settings.searchTtlMinutes),
    // Built at registration, on the limiter `buildApp` registers first (it refuses without one).
    cap: createUserRateLimit(app, {
      namespace: 'chs',
      max: settings.searchesPerMinute,
      timeWindow: '1 minute',
      message: customerSearchRateLimitMessage,
    }),
    exportMaxRows: settings.exportMaxRows,
  };

  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  useFamilyJsonParser(app);
  await registerCustomerOptionsRoute(app);
  await registerCustomerSearchRoute(app, deps);
  await registerCustomerTimelineRoute(app, deps);
  await registerCustomerExportRoute(app, deps);
}
