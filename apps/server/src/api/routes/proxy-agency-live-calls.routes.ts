import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { trackListenGrant, type ListenGrantResult } from '@magick-agency/observability/metrics/agency';
import { hasPermission } from '@magick-agency/contracts/rbac';
import type {
  AgencyListenGrant,
  AgencyLiveCall,
  AgencyLiveCallNotListenableReason,
  AgencyLiveCallNumberResponse,
  AgencyLiveCallsResponse,
} from '@magick-agency/contracts/api/agency/live-calls';
import type { AgencyCallOrigin, AgencyClientKind } from '@magick-agency/contracts/agency';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { ACCOUNT_HEADER } from '../middleware/headers.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore, type CoreCallRequest, type CoreCallResult } from '../core-dispatch.js';
import { readListenFlags, type ListenFlags } from '../../agency/listen/listen-access.js';
import { agentNamesOrNone } from '../../agency/agency-agent-identity.js';
import { maskPhone } from '../../agency/reports/datasets/shared.js';
import { config } from '../../config/index.js';
import {
  LIVE_CALL_NUMBER_WITHHELD_BODY,
  LIVE_LISTEN_DISABLED_BODY,
  isUuid,
  isWithheldNumber,
  listenRefusalCode,
  sendListenRefusal,
} from './helpers/listen.js';
import type { ListenGrantRequest } from './agency/live-calls.js';

const log = createChildLogger({ component: 'proxy-agency-live-calls' });

/*
 * Live calls and listening, served at the console's paths under `/proxy/agency`
 * (docs/listening.md §4; contracts `api/agency/live-calls.ts`). The public layer of B16: the
 * session, the tenant context, the permission (`agency.supervise` for the list and the number,
 * `agency.calls.listen` for the grant), then the consent flag `agency_live_listen_enabled` for the
 * request's account (`403 feature_disabled`, LS1), the ids checked at the edge (a malformed call
 * id is the uniform `404 listen_call_not_live`, never a `22P02`), and the account scope (every
 * read is the internal handler's for the request's tenant and account).
 *
 *  - `GET /live-calls?campaign_id=`: the internal list, with agent and listener names, the
 *    customer's number masked (`maskPhone`, LS9) and each row's `listenable` /
 *    `not_listenable_reason` computed for the caller (their permission, the call's own agent,
 *    LS4's flag for an unrecorded call, the per-call cap).
 *  - `GET /live-calls/:callId/number`: one live call's full number, on demand (not audited, LS9); a
 *    number the caller withheld `404 live_call_number_withheld` (the row says `customer_phone_withheld`).
 *  - `POST /live-calls/:callId/listen`: the call loaded in scope, live and bridged; LS4; the own-call
 *    rule (LS3); then `callCore` to the grant handler of the process that owns the agent's session,
 *    which checks its bridge and caps and mints the socket token. Every outcome is counted in
 *    `agency_listen_grants_total{result}`.
 * The routes need an account (`X-Account-Id`): the live list is an account's.
 */

/** What the routes read besides the request. Tests replace it. */
export interface LiveCallRouteDeps {
  /** Both listening flags for the account; REJECTS when they cannot be read (`readListenFlags`). */
  listenFlags(tenantId: string, accountId: string): Promise<ListenFlags>;
  callCore(req: CoreCallRequest): Promise<CoreCallResult>;
  names(ids: Iterable<string | null>, tenantId: string): Promise<Map<string, string | null>>;
  maxPerCall(): number;
  trackGrant(result: ListenGrantResult): void;
}

export const defaultLiveCallRouteDeps: LiveCallRouteDeps = {
  listenFlags: readListenFlags,
  callCore,
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'live calls'),
  maxPerCall: () => config.agency.listen.maxPerCall,
  trackGrant: (result) => { try { trackListenGrant(result); } catch { /* never worth the answer */ } },
};

/** One live call as the internal handler answers it (`agency/live-calls.ts`). */
interface CoreLiveCall {
  call_id: string;
  origin: AgencyCallOrigin;
  correlation_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  inbound_route_name: string | null;
  agent_user_id: string;
  agent_session_id: string;
  client_kind: AgencyClientKind;
  customer_name: string | null;
  customer_phone: string;
  connected_at: string;
  recording: boolean;
  aht_seconds: number | null;
  listeners: Array<{ listen_id: string; user_id: string; started_at: string }>;
}

function isCoreLiveCalls(body: unknown): body is { calls: CoreLiveCall[]; as_of: string } {
  return !!body && typeof body === 'object' && Array.isArray((body as { calls?: unknown }).calls)
    && typeof (body as { as_of?: unknown }).as_of === 'string';
}

/**
 * Why `userId` may not listen to `call` now, or null when they may (their permission is the
 * caller's to check). The grant's own order: their own call, LS4, then the cap. A supervisor
 * already listening to the call is not refused by their own session (a new listen supersedes it).
 */
export function notListenableReason(
  call: Pick<CoreLiveCall, 'agent_user_id' | 'recording' | 'listeners'>,
  userId: string,
  unrecordedAllowed: boolean,
  maxPerCall: number,
): AgencyLiveCallNotListenableReason | null {
  if (call.agent_user_id === userId) return 'listen_own_call';
  if (!call.recording && !unrecordedAllowed) return 'listen_recording_off';
  if (call.listeners.filter((l) => l.user_id !== userId).length >= maxPerCall) return 'listen_limit_call';
  return null;
}

export interface ProxyAgencyLiveCallsOptions {
  deps?: LiveCallRouteDeps;
}

export async function proxyAgencyLiveCallsRoutes(app: FastifyInstance, opts: ProxyAgencyLiveCallsOptions = {}): Promise<void> {
  const deps = opts.deps ?? defaultLiveCallRouteDeps;
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);

  /**
   * The account and the consent flag, or a reply. Runs after the permission. The flags are read
   * strictly (a flag store that cannot be read is not "off"): for the grant an outage is
   * `503 listen_unavailable` (LS16 d: no answer, no listen; nothing about the account's consent is
   * claimed); for the list and the number, which grant nothing, it is the flag's default (off:
   * `403 feature_disabled`), as before.
   */
  async function gate(
    request: FastifyRequest,
    reply: FastifyReply,
    onOutage: 'feature_disabled' | 'listen_unavailable',
  ): Promise<{ tenantId: string; accountId: string; flags: ListenFlags } | null> {
    if (!request.accountId) {
      await reply.code(400).send({ error: 'Bad Request', message: `Missing required header: ${ACCOUNT_HEADER}` });
      return null;
    }
    const tenantId = request.tenantId!.toLowerCase();
    const accountId = request.accountId.toLowerCase();
    let flags: ListenFlags;
    try {
      flags = await deps.listenFlags(tenantId, accountId);
    } catch (err) {
      log.warn({ err, tenantId }, 'live calls: the listening flags could not be read');
      if (onOutage === 'listen_unavailable') {
        deps.trackGrant('listen_unavailable');
        sendListenRefusal(reply, 'listen_unavailable');
      } else {
        await reply.code(403).send(LIVE_LISTEN_DISABLED_BODY);
      }
      return null;
    }
    if (!flags.enabled) {
      await reply.code(403).send(LIVE_LISTEN_DISABLED_BODY);
      return null;
    }
    return { tenantId, accountId, flags };
  }

  /** The live list for the scope (one campaign's, one call's), or null when the handler refused. */
  async function readLive(
    scope: { tenantId: string; accountId: string },
    query: Record<string, string>,
  ): Promise<{ calls: CoreLiveCall[]; as_of: string } | { status: number; body: unknown }> {
    const result = await deps.callCore({ method: 'GET', path: '/agency/live-calls', query, tenantId: scope.tenantId, accountId: scope.accountId });
    if (result.status !== 200 || !isCoreLiveCalls(result.body)) {
      if (result.status === 200) log.error({ tenantId: scope.tenantId }, 'live calls: the internal handler answered an unrecognised body');
      return { status: result.status === 200 ? 502 : result.status, body: result.status === 200 ? { error: 'Bad Gateway', message: 'Live calls could not be read.' } : result.body };
    }
    return result.body;
  }

  // ── GET /live-calls ───────────────────────────────────────────────────────
  app.get<{ Querystring: { campaign_id?: string } }>(
    '/live-calls',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const scope = await gate(request, reply, 'feature_disabled');
      if (!scope) return reply;
      const campaignId = request.query.campaign_id;
      if (campaignId !== undefined && campaignId !== '' && !isUuid(campaignId)) {
        return reply.code(400).send({ error: 'Validation Error', message: 'Invalid campaign_id: expected a UUID' });
      }
      const live = await readLive(scope, campaignId ? { campaign_id: campaignId.toLowerCase() } : {});
      if ('status' in live) return reply.code(live.status).send(live.body);
      const me = request.user!.id;
      const canListen = hasPermission(request.membership!.role, 'agency.calls.listen');
      const unrecorded = scope.flags.unrecordedAllowed;
      const maxPerCall = deps.maxPerCall();
      const names = await deps.names(
        live.calls.flatMap((c) => [c.agent_user_id, ...c.listeners.map((l) => l.user_id)]), scope.tenantId,
      );
      const calls: AgencyLiveCall[] = live.calls.map((c) => {
        const reason = canListen ? notListenableReason(c, me, unrecorded, maxPerCall) : null;
        return {
          call_id: c.call_id,
          origin: c.origin,
          correlation_id: c.correlation_id,
          campaign_id: c.campaign_id,
          campaign_name: c.campaign_name,
          inbound_route_name: c.inbound_route_name,
          agent_user_id: c.agent_user_id,
          agent_name: names.get(c.agent_user_id) ?? null,
          agent_session_id: c.agent_session_id,
          client_kind: c.client_kind,
          customer_name: c.customer_name,
          customer_phone_masked: maskPhone(c.customer_phone) ?? '****',
          customer_phone_withheld: isWithheldNumber(c.customer_phone),
          connected_at: c.connected_at,
          aht_seconds: c.aht_seconds,
          recording: c.recording,
          listenable: canListen && reason === null,
          not_listenable_reason: reason,
          listeners: c.listeners.map((l) => ({ user_id: l.user_id, name: names.get(l.user_id) ?? null, started_at: l.started_at })),
        };
      });
      const body: AgencyLiveCallsResponse = { calls, as_of: live.as_of };
      return reply.send(body);
    },
  );

  // ── GET /live-calls/:callId/number ───────────────────────────────────────
  app.get<{ Params: { callId: string } }>(
    '/live-calls/:callId/number',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const scope = await gate(request, reply, 'feature_disabled');
      if (!scope) return reply;
      if (!isUuid(request.params.callId)) return sendListenRefusal(reply, 'listen_call_not_live');
      const callId = request.params.callId.toLowerCase();
      const live = await readLive(scope, { call_id: callId });
      if ('status' in live) return reply.code(live.status).send(live.body);
      const call = live.calls[0];
      if (!call) return sendListenRefusal(reply, 'listen_call_not_live');
      if (isWithheldNumber(call.customer_phone)) return reply.code(404).send(LIVE_CALL_NUMBER_WITHHELD_BODY);
      const body: AgencyLiveCallNumberResponse = { call_id: call.call_id, customer_phone: call.customer_phone };
      return reply.send(body);
    },
  );

  // ── POST /live-calls/:callId/listen ──────────────────────────────────────
  app.post<{ Params: { callId: string } }>(
    '/live-calls/:callId/listen',
    { preHandler: [requirePermission('agency.calls.listen')] },
    async (request, reply) => {
      const gated = await gate(request, reply, 'listen_unavailable');
      if (!gated) return reply;
      const { flags, ...scope } = gated;
      const refuse = (code: Exclude<ListenGrantResult, 'granted'>): FastifyReply => {
        deps.trackGrant(code);
        return sendListenRefusal(reply, code);
      };
      if (!isUuid(request.params.callId)) return refuse('listen_call_not_live');
      const callId = request.params.callId.toLowerCase();
      const me = request.user!.id;
      let live: Awaited<ReturnType<typeof readLive>>;
      try {
        live = await readLive(scope, { call_id: callId });
      } catch (err) {
        log.error({ err, callId }, 'listen grant: the live call could not be read');
        return refuse('listen_unavailable');
      }
      if ('status' in live) return refuse(live.status >= 500 ? 'listen_unavailable' : 'listen_call_not_live');
      const call = live.calls[0];
      if (!call) return refuse('listen_call_not_live');
      if (call.agent_user_id === me) return refuse('listen_own_call');
      if (!call.recording && !flags.unrecordedAllowed) return refuse('listen_recording_off');

      const grantBody: ListenGrantRequest = {
        session_id: call.agent_session_id, call_id: call.call_id, origin: call.origin, campaign_id: call.campaign_id, correlation_id: call.correlation_id,
        agent_user_id: call.agent_user_id, listener_user_id: me, recording: call.recording,
      };
      let result: CoreCallResult;
      try {
        result = await deps.callCore({
          method: 'POST', path: '/agency/listen-grants', body: grantBody, ...scope,
        });
      } catch (err) {
        // The process that owns the session did not answer (a worker restarting).
        log.warn({ err, callId, sessionId: call.agent_session_id }, 'listen grant: the owning process did not answer');
        return refuse('listen_unavailable');
      }
      if (result.status === 201 && isGrant(result.body)) {
        deps.trackGrant('granted');
        return reply.code(201).send(result.body);
      }
      const code = listenRefusalCode(result.body);
      if (code) {
        deps.trackGrant(code);
        return sendListenRefusal(reply, code, result.status);
      }
      log.warn({ callId, status: result.status }, 'listen grant: the owning process answered something other than a grant');
      return refuse('listen_unavailable');
    },
  );
}

function isGrant(body: unknown): body is AgencyListenGrant {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return typeof b['listen_id'] === 'string' && typeof b['ws_url'] === 'string' && typeof b['expires_at'] === 'string';
}
