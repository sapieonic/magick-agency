/*
 * `POST /customers/export` (`docs/customer-history.md` §2): every timeline entry the filters keep,
 * newest first, as a `text/csv` attachment, at most `exportMaxRows` rows
 * (`AGENCY_CUSTOMER_EXPORT_MAX_ROWS`, default 10,000); past the cap the file is cut and answers
 * `X-Export-Truncated: true`. `X-Export-Rows` is the row count written. Charged to the search cap
 * and audited (CH10, CH11). The file name carries the date, never the number.
 * Part of `proxy-agency-customers.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { customerExportRequestSchema, toTimelineFilter } from '../../../agency/customer-history/requests.js';
import { countCustomerEntries, loadTimelinePage, resolveViewer } from '../../../agency/customer-history/service.js';
import { customerHistoryCsv } from '../../../agency/customer-history/csv.js';
import { csvAttachmentHeader } from '../helpers/csv-attachment.js';
import { boundedSelector } from '../helpers/audit-bounds.js';
import { settledValue } from '../helpers/settled.js';
import {
  auditCustomerHistory,
  guardCustomerRoute,
  noStore,
  ownSearch,
  parseBody,
  type CustomerRoutesDeps,
} from './shared.js';

/** `customer-history-2026-11-06`: the export's file name (no number in it, CH6). */
function customerExportFileName(now: Date): string {
  return `customer-history-${now.toISOString().slice(0, 10)}`;
}

export async function registerCustomerExportRoute(app: FastifyInstance, deps: CustomerRoutesDeps): Promise<void> {
  app.post('/customers/export', {
    preHandler: requirePermission('agency.customer_history.read'),
  }, async (request, reply) => {
    if (!(await guardCustomerRoute(request, reply, deps.cap))) return reply;
    const body = await parseBody(customerExportRequestSchema, request, reply);
    if (!body) return reply;
    const tenantId = request.tenantId!;
    // The search and the viewer are read together, then answered in the sequential order: the
    // search's 404 first, then a viewer read that threw.
    const [recordRead, viewerRead] = await Promise.allSettled([
      ownSearch(deps.store, body.search_id, request, reply),
      resolveViewer(request.user!.id, tenantId),
    ]);
    const record = settledValue(recordRead);
    if (!record) return reply;
    const viewer = settledValue(viewerRead);

    const now = new Date();
    // One keyset page as large as the cap: each source reads at most `exportMaxRows + 1` rows.
    const [page, resultCount] = await Promise.all([
      loadTimelinePage(viewer, tenantId, record.value, toTimelineFilter(body.filters), null, deps.exportMaxRows, now),
      countCustomerEntries(viewer, tenantId, record.value),
    ]);
    const truncated = page.next_cursor !== null;
    const rows = page.entries;

    auditCustomerHistory(request, {
      action: 'agency_customer_history.exported',
      searchId: body.search_id,
      record,
      viewer,
      resultCount,
      extra: { rows: rows.length, filters: boundedSelector(body.filters ?? {}), truncated },
    });

    const csv = customerHistoryCsv(
      rows,
      record.value,
      (id) => (id ? viewer.accounts.get(id)?.name ?? null : null),
    );
    noStore(reply);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', csvAttachmentHeader(customerExportFileName(now)));
    reply.header('X-Export-Rows', String(rows.length));
    if (truncated) reply.header('X-Export-Truncated', 'true');
    return reply.code(200).send(csv);
  });
}
