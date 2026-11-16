import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { encodeKeysetCursor } from '@magick-agency/domain/keyset-cursor';
import {
  AGENCY_LISTEN_HISTORY_DEFAULT_LIMIT,
  AGENCY_LISTEN_HISTORY_MERGE_GAP_MS,
} from '@magick-agency/contracts/api/agency/listen-history';
import type { AgencyCallOrigin, AgencyListenEndReason } from '@magick-agency/contracts/agency';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import { agencyListenHistoryRepository } from '../../../db/repositories/agency.repository.js';
import { matchName } from '../../../agency/inbound/match-name.js';
import { listenHistoryQuerySchema } from '../helpers/listen-history-query.js';
import { readKeysetCursor } from '../helpers/read-cursor.js';
import { isUuid } from '../helpers/listen.js';

/*
 * The listening history's internal handler (docs/listening.md §12, LS19), on the internal
 * instance behind `callCore` (B16). The public layer (`proxy-agency-listen-history.routes.ts`) has
 * run the session, the tenant context, `agency.supervise` and the flag; this answers the account's
 * visits, newest first, one keyset page at a time.
 *
 *  - `GET /listen-history` (owner `none`, SQL only): `?listener_user_id=&agent_user_id=&from=&to=
 *    &limit=&cursor=` → `{ entries, next_cursor }`. Full numbers (`customer_phone`: E.164, `''`
 *    for a withheld caller, null when the call's row is gone) and no user names: the public layer
 *    masks the one and adds the other.
 */

/** One visit as this handler answers it. */
export interface CoreListenHistoryEntry {
  id: string;
  listen_ids: string[];
  call_id: string;
  origin: AgencyCallOrigin;
  correlation_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  inbound_route_name: string | null;
  listener_user_id: string;
  agent_user_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  started_at: string;
  ended_at: string | null;
  listened_seconds: number | null;
  end_reason: AgencyListenEndReason | null;
}

export interface CoreListenHistoryPage {
  entries: CoreListenHistoryEntry[];
  next_cursor: string | null;
}

export async function registerListenHistoryRoutes(sub: FastifyInstance): Promise<void> {
  sub.get('/listen-history', async (request: FastifyRequest, reply: FastifyReply) => {
    const tenantId = getTenantId(request).toLowerCase();
    const accountId = getAccountId(request).toLowerCase();
    if (!isUuid(tenantId) || !isUuid(accountId)) {
      return reply.code(400).send({ error: 'Bad Request', message: 'The listening history needs an account.' });
    }
    const parsed = listenHistoryQuerySchema.safeParse(request.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation Error', message: parsed.error.issues[0]?.message ?? 'Invalid query' });
    }
    const before = readKeysetCursor(request, reply);
    if (before === null) return reply;
    const q = parsed.data;
    const limit = q.limit ?? AGENCY_LISTEN_HISTORY_DEFAULT_LIMIT;
    const { rows, hasMore } = await agencyListenHistoryRepository.listVisits({
      tenantId,
      accountId,
      listenerUserId: q.listener_user_id?.toLowerCase() ?? null,
      agentUserId: q.agent_user_id?.toLowerCase() ?? null,
      from: q.from ? new Date(q.from) : null,
      to: q.to ? new Date(q.to) : null,
      before: before ?? null,
      limit,
      mergeGapMs: AGENCY_LISTEN_HISTORY_MERGE_GAP_MS,
    });
    const last = rows[rows.length - 1];
    const body: CoreListenHistoryPage = {
      entries: rows.map((r) => ({
        id: r.id,
        listen_ids: r.listen_ids,
        call_id: r.call_id,
        origin: r.origin,
        correlation_id: r.correlation_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        inbound_route_name: r.inbound_route_name,
        listener_user_id: r.listener_user_id,
        agent_user_id: r.agent_user_id,
        customer_name: matchName(r.contact_context) ?? null,
        customer_phone: r.customer_phone,
        started_at: new Date(r.started_at).toISOString(),
        ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
        listened_seconds: r.listened_seconds === null ? null : Math.round(Number(r.listened_seconds)),
        end_reason: r.end_reason,
      })),
      next_cursor: hasMore && last ? encodeKeysetCursor({ at: last.started_at_key, id: last.id }) : null,
    };
    return reply.send(body);
  });
}
