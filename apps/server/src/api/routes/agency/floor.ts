import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyCallOrigin, AgencyClientKind, AgencyAgentLiveState } from '@magick-agency/contracts/agency';
import type { AgencyFloorTotals } from '@magick-agency/contracts/api/agency/floor';
import type { AgencySessionHelp } from '@magick-agency/contracts/agency';
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import {
  agencyFloorRepository,
  agencyListenSessionRepository,
  agencyLiveCallRepository,
  type AgencyFloorRow,
  type AgencyLiveCallRow,
} from '../../../db/repositories/agency.repository.js';
import { matchName } from '../../../agency/inbound/match-name.js';
import { floorBreak, floorTotals, parseFloorFrom } from '../../../agency/floor.js';
import { toSessionHelp } from '../../../agency/floor-assist.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { isUuid } from '../../../utils/uuid.js';
import { ahtFor } from './live-calls.js';

const log = createChildLogger({ component: 'agency-floor' });

/*
 * The Live floor's internal handler (decision B28b), on the internal instance behind `callCore`
 * (B16). The public layer (`proxy-agency-floor.routes.ts`) has run the session, the tenant context,
 * `agency.supervise`, the account scope, the dialer flag and the query's validation; this answers
 * what the dialer runtime knows, and leaves names and listening to it.
 *
 *  - `GET /floor?from=` (owner `none`: SQL and the station registry's Redis keys, nothing a
 *    session's process holds): the account's rows (`AgencyFloorRepository.floorRows`), the call
 *    in progress on each open session (the live calls list's own read, `listLive`, keyed by the
 *    agent's session; not the live calls ROUTE, which refuses while listening is off), each call's
 *    open listen sessions and campaign AHT (the live list's, `ahtFor`), each session's station
 *    liveness (`StationRegistry.connectedBySession`, best-effort: unknown is `null`, never
 *    `false`), and each agent's conversations since `from` (`callsToday`, kept
 *    {@link FLOOR_CALLS_TODAY_CACHE_MS} per account and `from`).
 *    The call carries the customer's name, never the number: the floor shows no numbers.
 *    Each open session's open Need help (LF4, read with the rows, the expiry applied in the read),
 *    whatever the floor assist flag says: the public layer reads it.
 */

/**
 * How long an account's conversations since `from` are kept per process. The floor is polled
 * every 5 s by every supervisor; the count is the read's cost (the account's attempts dialled
 * since `from`, `floor.repository.ts`), and a card's "calls today" a few seconds behind is fine.
 */
export const FLOOR_CALLS_TODAY_CACHE_MS = 30_000;

/** At most this many (account, `from`) counts are kept per process; the least recently read go first. */
const FLOOR_CALLS_TODAY_CACHE_MAX = 1_000;

const callsTodayCache = new TtlCache<Map<string, number>>({
  ttlMs: FLOOR_CALLS_TODAY_CACHE_MS, maxEntries: FLOOR_CALLS_TODAY_CACHE_MAX, name: 'floor-calls-today',
});

/** Tests only. */
export function clearFloorCallsTodayCacheForTests(): void {
  callsTodayCache.clear();
}

/** The call in progress on a session, as this handler answers it: the public layer computes listenability from `recording` and `listener_user_ids`. */
export interface CoreFloorCall {
  call_id: string;
  origin: AgencyCallOrigin;
  correlation_id: string;
  customer_name: string | null;
  connected_at: string;
  aht_seconds: number | null;
  recording: boolean;
  /** Who is listening now. */
  listener_user_ids: string[];
}

/** One person on the floor, as this handler answers it: everything but the name and listenability. */
export interface CoreFloorAgent {
  agent_user_id: string;
  session_id: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  state: AgencyAgentLiveState;
  state_since: string | null;
  connected: boolean | null;
  client_kind: AgencyClientKind | null;
  break_reason: string | null;
  break_label: string | null;
  break_limit_minutes: number | null;
  on_inbound_call: boolean;
  inbound_outcome_owed: boolean;
  wrapup_window_seconds: number | null;
  call: CoreFloorCall | null;
  calls_today: number;
  left_at: string | null;
  /** The open session's open Need help (LF4), whatever the flag says: the public route nulls it while the flag is off. */
  help: AgencySessionHelp | null;
}

/** `GET /api/v1/agency/floor`. */
export interface CoreFloorResponse {
  agents: CoreFloorAgent[];
  totals: AgencyFloorTotals;
  as_of: string;
}

/** Each session's station liveness, or an empty map (every agent `null`, "unknown") when Redis could not answer. */
async function connectedFor(runtime: AgencyRuntime, sessionIds: string[]): Promise<Map<string, boolean>> {
  if (sessionIds.length === 0) return new Map();
  try {
    return await runtime.stations.connectedBySession(sessionIds);
  } catch (err) {
    log.warn({ err, sessions: sessionIds.length }, 'Floor: station liveness could not be read; serving connected: null');
    return new Map();
  }
}

/** The open sessions among the floor's rows. */
function sessionIdsOf(rows: readonly AgencyFloorRow[]): string[] {
  return rows.flatMap((r) => (r.session_id ? [r.session_id] : []));
}

/**
 * `promise`, with a no-op handler attached so a rejection before it is awaited is not reported
 * unhandled. The promise returned is the same one: awaiting it still throws its error.
 */
function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

export async function registerFloorRoutes(sub: FastifyInstance, runtime: AgencyRuntime): Promise<void> {
  // ── GET /floor?from= ──────────────────────────────────────────────────────
  sub.get('/floor', async (request: FastifyRequest<{ Querystring: { from?: string } }>, reply: FastifyReply) => {
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    if (!isUuid(tenantId) || !isUuid(accountId)) {
      return reply.code(400).send({ error: 'Bad Request', message: 'The floor is one account\'s.' });
    }
    const now = new Date();
    const parsed = parseFloorFrom(request.query.from, now);
    if (!parsed.ok) return reply.code(400).send({ error: 'Bad Request', message: parsed.message });
    const { from } = parsed;

    // Each agent's calls today: started now and awaited only where the response is built, since no
    // other read needs them. Each promise started ahead of its await is observed at once
    // (`observed`), so one that rejects before it is awaited is never an unhandled rejection; the
    // request still fails with its error, as it did when all three were in one `Promise.all`.
    const callsToday = observed(callsTodayCache.getOrLoad(`${tenantId}:${accountId}:${from.toISOString()}`,
      () => agencyFloorRepository.callsToday(tenantId, accountId, from, now)));
    const rowsRead = agencyFloorRepository.floorRows(tenantId, accountId, from);
    // Liveness needs only the rows, not the live calls: started as soon as they are in.
    const connectedRead = observed(rowsRead.then((rows) => connectedFor(runtime, sessionIdsOf(rows))));
    const [rows, live] = await Promise.all([rowsRead, agencyLiveCallRepository.listLive({ tenantId, accountId })]);

    // The call in progress per session: the live list's rows, keyed by the agent's session.
    const onFloor = new Set(sessionIdsOf(rows));
    const callBySession = new Map<string, AgencyLiveCallRow>();
    for (const call of live) {
      // Longest on call first: should a session ever hold two, the first (the oldest) is kept.
      if (onFloor.has(call.agent_session_id) && !callBySession.has(call.agent_session_id)) {
        callBySession.set(call.agent_session_id, call);
      }
    }
    const calls = [...callBySession.values()];
    const [listens, aht, connected, callsTodayByAgent] = await Promise.all([
      agencyListenSessionRepository.listOpenForCalls(tenantId, accountId, calls.map((c) => c.call_id)),
      ahtFor(tenantId, calls.map((c) => c.campaign_id).filter((id): id is string => id !== null)),
      connectedRead,
      callsToday,
    ]);
    const listenersByCall = new Map<string, string[]>();
    for (const l of listens) {
      const onCall = listenersByCall.get(l.call_id);
      if (onCall) onCall.push(l.listener_user_id);
      else listenersByCall.set(l.call_id, [l.listener_user_id]);
    }

    const agents: CoreFloorAgent[] = rows.map((r) => {
      const call = r.session_id ? callBySession.get(r.session_id) : undefined;
      const onBreak = floorBreak(r.break_reason, r.break_reasons);
      return {
        agent_user_id: r.agent_user_id,
        session_id: r.session_id,
        campaign_id: r.campaign_id,
        campaign_name: r.campaign_name,
        state: r.state,
        state_since: r.state_since ? new Date(r.state_since).toISOString() : null,
        connected: r.session_id ? connected.get(r.session_id) ?? null : null,
        client_kind: r.client_kind,
        break_reason: r.break_reason,
        break_label: onBreak.label,
        break_limit_minutes: onBreak.limit_minutes,
        on_inbound_call: r.on_inbound_call,
        inbound_outcome_owed: r.inbound_outcome_owed,
        wrapup_window_seconds: r.wrapup_seconds,
        call: call
          ? {
            call_id: call.call_id,
            origin: call.origin,
            correlation_id: call.correlation_id,
            customer_name: matchName(call.contact_context) ?? null,
            connected_at: new Date(call.connected_at).toISOString(),
            aht_seconds: call.campaign_id ? aht.get(call.campaign_id) ?? null : null,
            recording: call.recording,
            listener_user_ids: listenersByCall.get(call.call_id) ?? [],
          }
          : null,
        calls_today: callsTodayByAgent.get(r.agent_user_id) ?? 0,
        left_at: r.left_at ? new Date(r.left_at).toISOString() : null,
        help: r.help_raised_at ? toSessionHelp({ raised_at: r.help_raised_at, call_id: r.help_call_id, state: r.help_state }) : null,
      };
    });
    const body: CoreFloorResponse = { agents, totals: floorTotals(rows), as_of: now.toISOString() };
    return reply.send(body);
  });
}
