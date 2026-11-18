import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createChildLogger } from '@magick-agency/observability';
import { AGENCY_CALL_ORIGINS } from '@magick-agency/contracts/agency';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import {
  agencyListenSessionRepository,
  agencyLiveCallRepository,
} from '../../../db/repositories/agency.repository.js';
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import { matchName } from '../../../agency/inbound/match-name.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { ListenTokenUnavailableError } from '../../../agency/listen/listen-token.js';
import { sendListenRefusal } from '../helpers/listen.js';
import { isUuid } from '../../../utils/uuid.js';

const log = createChildLogger({ component: 'agency-live-calls' });

/*
 * Live call listening's internal handlers (docs/listening.md §4), on the internal instance behind
 * `callCore` (B16). The public layer (`proxy-agency-live-calls.routes.ts`) has run the session,
 * the tenant context, the permission and the flag; these answer the dialer's part.
 *
 *  - `GET /live-calls` (owner `none`, SQL only): the account's live calls on the three spines,
 *    each with its open listen sessions and its campaign's average handle time. Full numbers and
 *    no user names: the public layer masks the one and adds the other.
 *  - `POST /listen-grants` (owner `body_session`: `session_id`, the agent's session, whose process
 *    relays the call): the bridge here holds the call, the caps admit it, and a single-use token is
 *    minted for the listener socket's upgrade. Not under `/sessions/:id`: those are the session's
 *    own agent's actions (Q8, `requireOwnedSession`), and a grant is a supervisor's on someone
 *    else's session.
 */

/** Each campaign's AHT is read at most this often per process (the list is polled every 5 s). */
export const LIVE_CALL_AHT_CACHE_MS = 60_000;

/**
 * At most this many campaigns' AHT are held per process (the least recently read go first), so
 * the cache is bounded whatever the process has ever listed.
 */
export const LIVE_CALL_AHT_CACHE_MAX = 1_000;

/** Each campaign's AHT (null: none yet), keyed `<tenant>:<campaign>`. */
const ahtCache = new TtlCache<number | null>({
  ttlMs: LIVE_CALL_AHT_CACHE_MS, maxEntries: LIVE_CALL_AHT_CACHE_MAX, name: 'live-call-aht',
});

/** Tests only. */
export function clearLiveCallAhtCacheForTests(): void {
  ahtCache.clear();
}

/**
 * The campaigns' AHT: cached ones as they are, the misses read in one query. Never rejects. Also
 * the floor's (`./floor.ts`), so a call's amber on the floor is the live list's.
 */
export async function ahtFor(tenantId: string, campaignIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const missing: string[] = [];
  for (const id of new Set(campaignIds)) {
    const hit = ahtCache.get(`${tenantId}:${id}`);
    if (hit !== undefined) out.set(id, hit);
    else missing.push(id);
  }
  if (missing.length > 0) {
    try {
      const read = await agencyLiveCallRepository.campaignAhtSeconds(tenantId, missing);
      for (const id of missing) {
        const value = read.get(id) ?? null;
        ahtCache.set(`${tenantId}:${id}`, value);
        out.set(id, value);
      }
    } catch (err) {
      // The AHT colours a timer; it never fails the list.
      log.warn({ err, tenantId }, 'Could not read the live calls\' campaign AHT — answering null');
      for (const id of missing) out.set(id, null);
    }
  }
  return out;
}

const grantBodySchema = z.object({
  session_id: z.string().uuid(),
  call_id: z.string().uuid(),
  origin: z.enum(AGENCY_CALL_ORIGINS),
  campaign_id: z.string().uuid().nullable(),
  correlation_id: z.string().uuid(),
  agent_user_id: z.string().uuid(),
  listener_user_id: z.string().uuid(),
  recording: z.boolean(),
}).strict();

/** The body the public layer sends to `POST /listen-grants`. */
export type ListenGrantRequest = z.infer<typeof grantBodySchema>;

export async function registerLiveCallRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── GET /live-calls?campaign_id=&call_id= ────────────────────────────────
  sub.get('/live-calls', async (request: FastifyRequest<{ Querystring: { campaign_id?: string; call_id?: string } }>, reply: FastifyReply) => {
    // The public layer sends the tenant context's ids and the query's, lower-cased.
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    const campaignId = request.query.campaign_id || null;
    const callId = request.query.call_id || null;
    if ((campaignId && !isUuid(campaignId)) || (callId && !isUuid(callId)) || !isUuid(tenantId) || !isUuid(accountId)) {
      return reply.code(400).send({ error: 'Bad Request', message: 'campaign_id and call_id must be UUIDs.' });
    }
    const rows = await agencyLiveCallRepository.listLive({ tenantId, accountId, campaignId, callId });
    const [open, aht] = await Promise.all([
      agencyListenSessionRepository.listOpenForCalls(tenantId, accountId, rows.map((r) => r.call_id)),
      ahtFor(tenantId, rows.map((r) => r.campaign_id).filter((id): id is string => id !== null)),
    ]);
    const listeners = new Map<string, Array<{ listen_id: string; user_id: string; started_at: string }>>();
    for (const o of open) {
      const listener = { listen_id: o.id, user_id: o.listener_user_id, started_at: new Date(o.started_at).toISOString() };
      const onCall = listeners.get(o.call_id);
      if (onCall) onCall.push(listener);
      else listeners.set(o.call_id, [listener]);
    }
    return reply.send({
      calls: rows.map((r) => ({
        call_id: r.call_id,
        origin: r.origin,
        correlation_id: r.correlation_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        inbound_route_name: r.inbound_route_name,
        agent_user_id: r.agent_user_id,
        agent_session_id: r.agent_session_id,
        client_kind: r.client_kind,
        customer_name: matchName(r.contact_context) ?? null,
        customer_phone: r.customer_phone,
        connected_at: new Date(r.connected_at).toISOString(),
        recording: r.recording,
        aht_seconds: r.campaign_id ? aht.get(r.campaign_id) ?? null : null,
        listeners: listeners.get(r.call_id) ?? [],
      })),
      as_of: new Date().toISOString(),
    });
  });

  // ── POST /listen-grants ───────────────────────────────────────────────────
  sub.post('/listen-grants', async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    const parsed = grantBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', message: 'A listen grant needs the call it is for.' });
    }
    const body = parsed.data;
    const sessionId = body.session_id.toLowerCase();
    // The bridge in this process must hold the call: this is the process its tap would run in.
    if (!runtime.holdsCall(body.call_id)) return sendListenRefusal(reply, 'listen_call_not_live');
    const refused = runtime.listen.check(body.call_id, tenantId, body.listener_user_id);
    if (refused) return sendListenRefusal(reply, refused);
    const listenId = crypto.randomUUID();
    let minted: { token: string; expiresAt: Date };
    try {
      minted = await runtime.listenTokens.mint({
        listenId, sessionId, tenantId, accountId, callId: body.call_id, origin: body.origin, campaignId: body.campaign_id,
        correlationId: body.correlation_id, agentUserId: body.agent_user_id, listenerUserId: body.listener_user_id,
        recording: body.recording,
        // A revocation of this supervisor here before the upgrade refuses it (LS16 n).
        revocationGen: runtime.listen.generation(tenantId, body.listener_user_id),
      });
    } catch (err) {
      if (err instanceof ListenTokenUnavailableError) return sendListenRefusal(reply, 'listen_unavailable');
      throw err;
    }
    return reply.code(201).send({
      listen_id: listenId,
      ws_url: `/proxy/agency/listen/${sessionId}/${listenId}?token=${minted.token}`,
      expires_at: minted.expiresAt.toISOString(),
    });
  });
}
