/*
 * `POST /customers/search` (`docs/customer-history.md` §2): one number, read with the shared
 * number rule, searched in the caller's visible accounts; answers the summary, the first page and a
 * `search_id` the timeline and the export name it by. Part of `proxy-agency-customers.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import type { CustomerSearchResponse } from '@magick-agency/contracts/api/agency/customer-history';
import { CUSTOMER_TIMELINE_PAGE_SIZE } from '@magick-agency/contracts/api/agency/customer-history';
import { parseSearchNumber, resolveSearchCountry, searchCountryByIso } from '@magick-agency/domain/customer-search-number';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { defaultPhoneCountryCode } from '../../../utils/phone-normalizer.js';
import { customerSearchRequestSchema, toTimelineFilter } from '../../../agency/customer-history/requests.js';
import { loadCustomerSummary, loadTimelinePage } from '../../../agency/customer-history/service.js';
import {
  auditCustomerHistory,
  guardCustomerRoute,
  noStore,
  parseBody,
  refusal,
  resolveDialerViewer,
  type CustomerRoutesDeps,
} from './shared.js';

export async function registerCustomerSearchRoute(app: FastifyInstance, deps: CustomerRoutesDeps): Promise<void> {
  app.post('/customers/search', {
    preHandler: requirePermission('agency.customer_history.read'),
  }, async (request, reply) => {
    if (!(await guardCustomerRoute(request, reply, deps.cap))) return reply;
    const body = await parseBody(customerSearchRequestSchema, request, reply);
    if (!body) return reply;

    // A country the picker does not list is refused, never searched as the default's number.
    if (body.country !== undefined && !searchCountryByIso(body.country)) {
      return reply.code(400).send(refusal('invalid_search_request', 'country: not a country the search offers'));
    }
    const country = resolveSearchCountry(body.country, defaultPhoneCountryCode());
    const number = parseSearchNumber(body.value, country);
    if (!number.ok) {
      return reply.code(400).send(refusal('invalid_number', number.message, number.code));
    }

    const tenantId = request.tenantId!;
    const now = new Date();
    const viewer = await resolveDialerViewer(request.user!.id, tenantId);
    const [{ summary, resultCount }, timeline] = await Promise.all([
      loadCustomerSummary(viewer, tenantId, number.e164, now),
      loadTimelinePage(viewer, tenantId, number.e164, toTimelineFilter(undefined), null, CUSTOMER_TIMELINE_PAGE_SIZE, now),
    ]);

    const { id, record } = await deps.store.save({
      tenant_id: tenantId,
      user_id: request.user!.id,
      by: body.by,
      value: number.e164,
      display: number.formatted,
    });

    auditCustomerHistory(request, {
      action: 'agency_customer_history.searched',
      searchId: id,
      record,
      viewer,
      resultCount,
    });

    const answer: CustomerSearchResponse = {
      search_id: id,
      expires_at: record.expires_at,
      key: { by: record.by, value: record.value, display: record.display },
      summary,
      timeline,
    };
    noStore(reply);
    return reply.code(200).send(answer);
  });
}
