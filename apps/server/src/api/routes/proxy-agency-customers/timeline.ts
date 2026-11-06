/*
 * `POST /customers/timeline` (`docs/customer-history.md` §4): a later page of a search's timeline,
 * or the first page under new filters. The search is named by its `search_id`; the number is read
 * from the search record, never from the request. Not charged to the search cap: paging through one
 * number's history is not another lookup. Part of `proxy-agency-customers.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { CustomerTimelinePage } from '@magick-agency/contracts/api/agency/customer-history';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { customerTimelineRequestSchema, pageLimit, toTimelineFilter } from '../../../agency/customer-history/requests.js';
import { decodeTimelineCursor } from '../../../agency/customer-history/cursor.js';
import { buildTimeline, filterTimeline, pageTimeline } from '../../../agency/customer-history/assemble.js';
import { loadCustomerHistory, resolveViewer } from '../../../agency/customer-history/service.js';
import {
  guardCustomerRoute,
  INVALID_CURSOR_BODY,
  noStore,
  ownSearch,
  parseBody,
  type CustomerRoutesDeps,
} from './shared.js';

export async function registerCustomerTimelineRoute(app: FastifyInstance, deps: CustomerRoutesDeps): Promise<void> {
  app.post('/customers/timeline', {
    preHandler: requirePermission('agency.customer_history.read'),
  }, async (request, reply) => {
    if (!(await guardCustomerRoute(request, reply, null))) return reply;
    const body = await parseBody(customerTimelineRequestSchema, request, reply);
    if (!body) return reply;
    const record = await ownSearch(deps.store, body.search_id, request, reply);
    if (!record) return reply;
    const cursor = body.cursor === undefined ? null : decodeTimelineCursor(body.cursor);
    if (body.cursor !== undefined && !cursor) return reply.code(400).send(INVALID_CURSOR_BODY);

    const tenantId = request.tenantId!;
    const viewer = await resolveViewer(request.user!.id, tenantId);
    const data = await loadCustomerHistory(viewer, tenantId, record.value);
    const items = filterTimeline(buildTimeline(data), toTimelineFilter(body.filters));
    const page: CustomerTimelinePage = pageTimeline(items, cursor, pageLimit(body.limit));
    noStore(reply);
    return reply.code(200).send(page);
  });
}
