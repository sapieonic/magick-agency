import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AGENCY_CALLBACKS_QUERY_ERROR_CODE,
  type AgencyCallbacksPage,
} from '@magick-agency/contracts/api/agency/callbacks';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { agentNamesOrNone } from '../../agency/agency-agent-identity.js';
import { callbacksRow, parseCallbacksQuery } from '../../agency/callbacks-list.js';
import { localDayEnd } from '../../agency/calling-hours.js';
import {
  agencyCallbacksRepository,
  type CallbacksListCampaignRow,
  type CallbacksPageInput,
  toKeysetPage,
  type CallbacksPageRow,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { dialerEnabled } from './helpers/dialer-gate.js';
import { noStoreHook } from './helpers/no-store.js';
import { sendRefusal } from './helpers/refusal.js';

/*
 * The account's callbacks in one list (decisions LF1, LF22; contracts `api/agency/callbacks.ts`),
 * served at the console's path under `/proxy/agency`: the Live floor's Callbacks page. The public
 * layer of B16, SQL only (this layer's own read, as the promises summary and the insights reads
 * are). The session and the tenant context (the hooks below), `agency.supervise` (account admin and
 * up; tenant owners pass; agents, operators and viewers get the RBAC 403), the account scope (`400
 * account_scope_required`), the dialer flag (`403 feature_disabled`), then the query (`400
 * invalid_callbacks_query`). Never cached (`Cache-Control: no-store`, refusals included): rows name
 * customers.
 *
 *  - `GET /callbacks?due=&campaign_id=&cursor=&limit=`: the account's active campaigns
 *    (`AgencyCallbacksRepository.activeCampaigns`, or the one named among them), then one keyset
 *    page of their open callbacks overdue or due later today (`page`), each campaign's callbacks as
 *    its catalog defines them and its "today" ending at its own local midnight; the owners named.
 *    The customer's name, never the number.
 */

/** What the route reads besides the request. Tests replace it. */
export interface CallbacksRouteDeps {
  activeCampaigns(tenantId: string, accountId: string, campaignId: string | null): Promise<CallbacksListCampaignRow[]>;
  page(input: CallbacksPageInput): Promise<CallbacksPageRow[]>;
  names(ids: Iterable<string | null>, tenantId: string): Promise<Map<string, string | null>>;
  /** The dialer flag, else the 403 sent (`dialerEnabled`). */
  dialerEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  now(): Date;
}

const defaultCallbacksRouteDeps: CallbacksRouteDeps = {
  activeCampaigns: (t, a, c) => agencyCallbacksRepository.activeCampaigns(t, a, c),
  page: (input) => agencyCallbacksRepository.page(input),
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'callbacks'),
  dialerEnabled,
  now: () => new Date(),
};

export interface ProxyAgencyCallbacksOptions {
  deps?: CallbacksRouteDeps;
}

export async function proxyAgencyCallbacksRoutes(app: FastifyInstance, opts: ProxyAgencyCallbacksOptions = {}): Promise<void> {
  const deps = opts.deps ?? defaultCallbacksRouteDeps;
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);

  // ── GET /callbacks ────────────────────────────────────────────────────────
  app.get(
    '/callbacks',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      // The tenant context middleware has lower-cased both ids.
      const accountId = accountOrRefuse(request.accountId, reply);
      if (!accountId) return reply;
      if (!(await deps.dialerEnabled(request, reply))) return reply;
      const tenantId = request.tenantId!;
      const parsed = parseCallbacksQuery(request.query as Record<string, unknown> | undefined);
      if (!parsed.ok) return sendRefusal(reply, 400, AGENCY_CALLBACKS_QUERY_ERROR_CODE, parsed.message);
      const { due, campaignId, after, limit } = parsed.query;

      const now = deps.now();
      const campaigns = await deps.activeCampaigns(tenantId, accountId, campaignId);
      const byId = new Map(campaigns.map((c) => [c.id, c]));
      const rows = await deps.page({
        tenantId,
        accountId,
        campaigns: campaigns.map((c) => ({
          id: c.id,
          callbackCodes: callbackCodes(c.disposition_catalog),
          // An unreadable zone (validated at write) ends the day at UTC midnight, as Insights does.
          dayEnd: localDayEnd(c.default_timezone, now) ?? localDayEnd('UTC', now)!,
        })),
        due,
        now,
        after,
        take: limit + 1,
      });
      // The page and its cursor from the `limit + 1` read (`toKeysetPage`), keyed by the due time to
      // the microsecond and the contact; the owners' names read for the rows shown only.
      const page = toKeysetPage(rows.map((r) => ({ ...r, cursor_at: r.due_key, id: r.contact_id })), limit, (r) => r);
      const names = await deps.names(page.rows.map((r) => r.owner_id), tenantId);
      const body: AgencyCallbacksPage = {
        rows: page.rows.map((r) => callbacksRow(r, byId.get(r.campaign_id)!, names)),
        next_cursor: page.next_cursor,
        limit: page.limit,
        due,
        as_of: now.toISOString(),
      };
      return reply.send(body);
    },
  );
}
