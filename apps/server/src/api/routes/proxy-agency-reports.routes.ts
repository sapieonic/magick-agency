import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../../app-context.js';
import { agencyConfigSchema } from '../../config/blocks/agency.js';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { registerReportRunRoutes } from './proxy-agency-reports/runs.js';
import { registerReportSubscriptionRoutes } from './proxy-agency-reports/subscriptions.js';
import { defaultReportRouteDeps, type ReportRouteDeps } from './proxy-agency-reports/shared.js';

export { registerReportRunRoutes, registerReportSubscriptionRoutes };

export interface ProxyAgencyReportsOptions {
  ctx: AppContext | null;
  /** Tests replace any dependency (`./proxy-agency-reports/shared.ts`). */
  deps?: Partial<ReportRouteDeps>;
}

/**
 * Reports (docs/reports.md; the wire is `packages/contracts/src/api/agency/reports.ts`), at the
 * console's paths under `/proxy/agency/`:
 *
 *  - runs (`./proxy-agency-reports/runs.ts`): `POST /reports` (202), `GET /reports` (the history),
 *    `GET /reports/:id`, `GET /reports/:id/files/:format` (a 5-minute presigned URL, audited
 *    `agency_report.downloaded`), `POST /reports/:id/retry` (a NEW run with the same parameters,
 *    202). Floor `agency.station.connect` (every member: an agent may export their OWN review,
 *    RP5); the reach over each subject is checked per kind (`resolveReportTarget`).
 *  - subscriptions (`./subscriptions.ts`): `GET|POST /report-subscriptions`,
 *    `PATCH|DELETE /report-subscriptions/:id`, `POST /report-subscriptions/:id/run-now` (an ad hoc
 *    run of the latest complete period, 202). Floor `agency.supervise`.
 *
 * Guards, in this order, on every route: session and tenant context (the hooks below); the RBAC
 * floor; the `agency_reports_enabled` flag (`403 feature_disabled`, the dialer gate's body shape),
 * before any id or body is looked at; then the ids (a malformed or foreign id is the family's
 * not-found, never a `22P02` or an oracle), the body (the generic agency 400, `parseOr400`), the
 * caller's reach over the subject (403, or `404 report_subject_not_found`), the zone
 * (`report_timezone_invalid`), the window (`reportWindowProblem`), the per-user rate
 * (`AGENCY_REPORTS_USER_PER_MINUTE`, `report_rate_limited`) and the tenant's pending limit
 * (`AGENCY_REPORTS_TENANT_PENDING_LIMIT`, `report_queue_full`). Refusals are
 * `{ error, code, message }` with the contract's status per code. The routes validate their own
 * ids, so the family gets no wrapper id guard.
 *
 * The render callback is not here: it carries no session (`webhooks/report-rendered.ts`).
 */
export async function proxyAgencyReportsRoutes(app: FastifyInstance, opts: ProxyAgencyReportsOptions): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  const config = opts.ctx?.config.agency.reports ?? agencyConfigSchema.parse({}).agency.reports;
  const deps: ReportRouteDeps = { ...defaultReportRouteDeps(config), ...opts.deps };
  await registerReportRunRoutes(app, deps);
  await registerReportSubscriptionRoutes(app, deps);
}
