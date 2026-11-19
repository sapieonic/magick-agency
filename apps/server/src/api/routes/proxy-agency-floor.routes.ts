import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import { hasPermission } from '@magick-agency/contracts/rbac';
import {
  AGENCY_FLOOR_QUERY_ERROR_CODE,
  type AgencyFloorAgent,
  type AgencyFloorResponse,
} from '@magick-agency/contracts/api/agency/floor';
import {
  AGENCY_PROMISES_QUERY_ERROR_CODE,
  type AgencyPromisesSummaryResponse,
} from '@magick-agency/contracts/api/agency/promises';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore, type CoreCallRequest, type CoreCallResult } from '../core-dispatch.js';
import { listenFlagsFrom, type ListenFlags } from '../../agency/listen/listen-access.js';
import { agentNamesOrNone } from '../../agency/agency-agent-identity.js';
import { parseFloorFrom, parsePromisesWindow } from '../../agency/floor.js';
import { agencyPromiseSummaryRepository, type AgencyPromiseSummaryRow } from '../../db/repositories/agency.repository.js';
import { config } from '../../config/index.js';
import { FLAGS, getFeatureFlagService, type FlagSnapshot } from '../../feature-flags/index.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { dialerEnabled } from './helpers/dialer-gate.js';
import { noStoreHook } from './helpers/no-store.js';
import { sendRefusal } from './helpers/refusal.js';
import { notListenableReason } from './proxy-agency-live-calls.routes.js';
import type { CoreFloorAgent, CoreFloorResponse } from './agency/floor.js';

const log = createChildLogger({ component: 'proxy-agency-floor' });

/*
 * The Live floor's account-wide reads (decision B28b; contracts `api/agency/floor.ts` and
 * `api/agency/promises.ts`), served at the console's paths under `/proxy/agency`. The public layer
 * of B16. Every route: the session and the tenant context (the hooks below), `agency.supervise`
 * (account admin and up; tenant owners pass; agents, operators and viewers get the RBAC 403), the
 * account scope (`400 account_scope_required`: the floor is one account's), the dialer flag
 * (`403 feature_disabled`, the campaign reads' refusal), then the query (`400` with the route's
 * own code). Never cached by a browser or a proxy (`Cache-Control: no-store`, refusals included):
 * the floor names agents and customers.
 *
 *  - `GET /floor?from=`: the internal handler's floor (`agency/floor.ts`, through `callCore`),
 *    with each agent's name and, on each call, whether the reader may listen to it. Listenability
 *    is the live calls list's rule (`notListenableReason`) for a reader holding
 *    `agency.calls.listen` while the listening flag is on for the account; otherwise no call is
 *    listenable and none says why. Each row's `help` (LF4) is served only while
 *    `agency_floor_assist_enabled` is on for the account. Both flags come from ONE strict snapshot
 *    of the account's flags per poll. The floor needs neither (the live calls routes refuse without
 *    the listening flag): a flag store that cannot be read makes every call unlistenable and every
 *    row's `help` null, never the floor a 503.
 *  - `GET /promises/summary?from=&to=`: the promises to pay recorded in the window, per campaign
 *    (`AgencyPromiseSummaryRepository`, SQL only, this layer's own read as the insights reads
 *    are), and the account's active campaigns whose catalog asks for a promise.
 */

/** What the routes read besides the request. Tests replace it. */
export interface FloorRouteDeps {
  callCore(req: CoreCallRequest): Promise<CoreCallResult>;
  names(ids: Iterable<string | null>, tenantId: string): Promise<Map<string, string | null>>;
  /** The account's flags, one strict snapshot (listening, LS1, LS4; floor assist, LF11); REJECTS when they cannot be read. */
  flags(tenantId: string, accountId: string): Promise<FlagSnapshot>;
  maxPerCall(): number;
  /** The dialer flag, else the 403 sent (`dialerEnabled`). */
  dialerEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
  promiseSummary(tenantId: string, accountId: string, from: Date, to: Date): Promise<AgencyPromiseSummaryRow[]>;
  /** The account's active campaigns whose catalog asks for a promise. */
  promiseCampaignIds(tenantId: string, accountId: string): Promise<string[]>;
  now(): Date;
}

const defaultFloorRouteDeps: FloorRouteDeps = {
  callCore,
  names: (ids, tenantId) => agentNamesOrNone(ids, tenantId, 'floor'),
  flags: (tenantId, accountId) => getFeatureFlagService().strictSnapshot({ tenantId, accountId }),
  maxPerCall: () => config.agency.listen.maxPerCall,
  dialerEnabled,
  promiseSummary: (t, a, from, to) => agencyPromiseSummaryRepository.summary(t, a, from, to),
  promiseCampaignIds: (t, a) => agencyPromiseSummaryRepository.promiseCampaignIds(t, a),
  now: () => new Date(),
};

function isCoreFloor(body: unknown): body is CoreFloorResponse {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return Array.isArray(b['agents']) && typeof b['as_of'] === 'string' && !!b['totals'] && typeof b['totals'] === 'object';
}

export interface ProxyAgencyFloorOptions {
  deps?: FloorRouteDeps;
}

export async function proxyAgencyFloorRoutes(app: FastifyInstance, opts: ProxyAgencyFloorOptions = {}): Promise<void> {
  const deps = opts.deps ?? defaultFloorRouteDeps;
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);

  /** The account, then the dialer flag; null once it has replied. */
  async function scope(request: FastifyRequest, reply: FastifyReply): Promise<{ tenantId: string; accountId: string } | null> {
    // The tenant context middleware has lower-cased both ids.
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return null;
    if (!(await deps.dialerEnabled(request, reply))) return null;
    return { tenantId: request.tenantId!, accountId };
  }

  /** The account's flags for this poll (one strict snapshot), or null when they cannot be read. */
  async function accountFlags(tenantId: string, accountId: string): Promise<FlagSnapshot | null> {
    try {
      return await deps.flags(tenantId, accountId);
    } catch (err) {
      log.warn({ err, tenantId }, 'floor: the account flags could not be read; no call is listenable and no row carries help');
      return null;
    }
  }

  /** Whether the floor carries Need help (LF11): false while the flag is off, or when it cannot be read. */
  function floorAssist(flags: FlagSnapshot | null, tenantId: string): boolean {
    try {
      return flags?.isEnabled(FLAGS.agency_floor_assist_enabled) ?? false;
    } catch (err) {
      log.warn({ err, tenantId }, 'floor: the floor assist flag could not be read; no row carries help');
      return false;
    }
  }

  /** The listening flags, or null when listening is not offered on this floor (off, or unreadable). */
  function listening(flags: FlagSnapshot | null, tenantId: string): ListenFlags | null {
    if (!flags) return null;
    try {
      const listen = listenFlagsFrom(flags);
      return listen.enabled ? listen : null;
    } catch (err) {
      log.warn({ err, tenantId }, 'floor: the listening flags could not be read; no call is listenable');
      return null;
    }
  }

  // ── GET /floor ────────────────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string } }>(
    '/floor',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const scoped = await scope(request, reply);
      if (!scoped) return reply;
      const parsed = parseFloorFrom(request.query.from, deps.now());
      if (!parsed.ok) return sendRefusal(reply, 400, AGENCY_FLOOR_QUERY_ERROR_CODE, parsed.message);

      const me = request.user!.id;
      const canListen = hasPermission(request.membership!.role, 'agency.calls.listen');
      const [result, snapshot] = await Promise.all([
        deps.callCore({
          method: 'GET', path: '/agency/floor', query: { from: parsed.from.toISOString() }, ...scoped,
        }),
        accountFlags(scoped.tenantId, scoped.accountId),
      ]);
      const flags = canListen ? listening(snapshot, scoped.tenantId) : null;
      const assist = floorAssist(snapshot, scoped.tenantId);
      if (result.status !== 200) return reply.code(result.status).send(result.body);
      if (!isCoreFloor(result.body)) {
        log.error({ tenantId: scoped.tenantId }, 'floor: the internal handler answered an unrecognised body');
        return reply.code(502).send({ error: 'Bad Gateway', message: 'The floor could not be read.' });
      }
      const core = result.body;
      const names = await deps.names(core.agents.map((a) => a.agent_user_id), scoped.tenantId);
      const maxPerCall = deps.maxPerCall();
      const agents: AgencyFloorAgent[] = core.agents.map((a: CoreFloorAgent) => {
        const { call, ...rest } = a;
        let floorCall: AgencyFloorAgent['call'] = null;
        if (call) {
          // Listenability is offered only to a reader who may listen, while listening is on.
          const reason = flags
            ? notListenableReason(
              { agent_user_id: a.agent_user_id, recording: call.recording, listeners: call.listener_user_ids.map((user_id) => ({ user_id })) },
              me, flags.unrecordedAllowed, maxPerCall,
            )
            : null;
          floorCall = {
            call_id: call.call_id,
            origin: call.origin,
            correlation_id: call.correlation_id,
            customer_name: call.customer_name,
            connected_at: call.connected_at,
            aht_seconds: call.aht_seconds,
            listenable: flags !== null && reason === null,
            not_listenable_reason: reason,
          };
        }
        return {
          agent_user_id: rest.agent_user_id,
          agent_name: names.get(rest.agent_user_id) ?? null,
          session_id: rest.session_id,
          campaign_id: rest.campaign_id,
          campaign_name: rest.campaign_name,
          state: rest.state,
          state_since: rest.state_since,
          connected: rest.connected,
          client_kind: rest.client_kind,
          break_reason: rest.break_reason,
          break_label: rest.break_label,
          break_limit_minutes: rest.break_limit_minutes,
          on_inbound_call: rest.on_inbound_call,
          inbound_outcome_owed: rest.inbound_outcome_owed,
          wrapup_window_seconds: rest.wrapup_window_seconds,
          call: floorCall,
          calls_today: rest.calls_today,
          left_at: rest.left_at,
          // Need help (LF4), only while the floor assist flag is on (LF11).
          help: assist ? rest.help ?? null : null,
        };
      });
      const body: AgencyFloorResponse = {
        agents,
        totals: { on_shift: core.totals.on_shift, assigned: core.totals.assigned },
        as_of: core.as_of,
      };
      return reply.send(body);
    },
  );

  // ── GET /promises/summary ─────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>(
    '/promises/summary',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const scoped = await scope(request, reply);
      if (!scoped) return reply;
      const parsed = parsePromisesWindow(request.query.from, request.query.to);
      if (!parsed.ok) return sendRefusal(reply, 400, AGENCY_PROMISES_QUERY_ERROR_CODE, parsed.message);
      const [rows, promiseCampaignIds] = await Promise.all([
        deps.promiseSummary(scoped.tenantId, scoped.accountId, parsed.from, parsed.to),
        deps.promiseCampaignIds(scoped.tenantId, scoped.accountId),
      ]);
      const body: AgencyPromisesSummaryResponse = {
        campaigns: rows.map((r) => ({
          campaign_id: r.campaign_id, promises: r.promises, with_amount: r.with_amount, amount_total: r.amount_total,
        })),
        promise_campaign_ids: promiseCampaignIds,
        from: parsed.from.toISOString(),
        to: parsed.to.toISOString(),
      };
      return reply.send(body);
    },
  );
}
