import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { noStoreHook } from './helpers/no-store.js';
import { registerCompareReadRoutes } from './proxy-agency-compare/read.js';
import { registerCompareViewRoutes } from './proxy-agency-compare/views.js';
import { defaultCompareRouteDeps, type CompareRouteDeps } from './proxy-agency-compare/shared.js';

export interface ProxyAgencyCompareOptions {
  /** Tests replace any dependency (`./proxy-agency-compare/shared.ts`). */
  deps?: Partial<CompareRouteDeps>;
}

/**
 * Compare agents (docs/compare-agents.md, rulings CP1–CP18; the wire is
 * `packages/contracts/src/api/agency/compare.ts`), at the console's paths under `/proxy/agency/`.
 * The public layer of B16, SQL only (no `callCore`): the read composes the roster's own statements
 * and the other screens' reads (`agency/compare/`).
 *
 *  - read (`./proxy-agency-compare/read.ts`): `POST /compare/query` (the comparison) and
 *    `GET /compare/options` (the cohort, the outcome codes, the starting lens, the campaign's
 *    default view), both under the read's guards (`agency/compare/read.ts`: one snapshot under
 *    `COMPARE_READ_TIMEOUT_MS`, `COMPARE_TENANT_CONCURRENT_READS` per tenant, the query cached
 *    `COMPARE_CACHE_TTL_MS`);
 *  - saved views (`./views.ts`): `GET|POST /compare/views`, `PATCH|DELETE /compare/views/:id`.
 *
 * Guards, in this order, on every route: the session and the tenant context (the hooks below), then
 * the route's own preHandlers (`compareGuards`): the RBAC floor `agency.supervise` (CP3: an agent
 * never sees other agents' figures here; the RBAC 403) and the `agency_compare_enabled` flag (`403
 * feature_disabled`, the dialer gate's body shape) before any body is read; then the account scope (`400 account_scope_required`), then the body (the generic
 * agency 400) and the compare refusals in the contract's order, `{ error, code, message }` with the
 * contract's status per code. The routes validate their own ids, so the family gets no wrapper id
 * guard. Never cached by a browser (`Cache-Control: no-store`): answers name agents.
 *
 * One read cache and limiter per registration (`CompareReads`), cleared when the app closes.
 */
export async function proxyAgencyCompareRoutes(app: FastifyInstance, opts: ProxyAgencyCompareOptions = {}): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);
  const deps: CompareRouteDeps = { ...defaultCompareRouteDeps(), ...opts.deps };
  app.addHook('onClose', async () => { deps.reads.clear(); });
  await registerCompareReadRoutes(app, deps);
  await registerCompareViewRoutes(app, deps);
}
