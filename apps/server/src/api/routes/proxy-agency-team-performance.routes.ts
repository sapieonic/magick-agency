import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  AGENCY_TEAM_PERFORMANCE_ERROR_STATUS,
  TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS,
  type AgencyTeamPerformanceErrorCode,
} from '@magick-agency/contracts/api/agency/team-performance';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../feature-flags/index.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { agencyCampaignRepository } from '../../db/repositories/agency.repository.js';
import { TeamAborted, TeamPerformanceReads, TeamRefusal } from '../../agency/team-performance/read.js';
import { checkTeamWindow, TEAM_ERROR_MESSAGES, teamPerformanceQuerySchema } from '../../agency/team-performance/validate.js';
import { localDateOf } from '../../agency/reports/schedule.js';
import { isRequestZone, postgresZoneName } from '../../agency/zone.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { accountOrRefuse } from './helpers/account-scope.js';
import { noStoreHook } from './helpers/no-store.js';
import { parseOr400 } from './helpers/parse-or-400.js';
import { sendRefusal } from './helpers/refusal.js';
import { CLIENT_CLOSED_STATUS, clientGoneSignal } from './proxy-agency-compare/shared.js';

/** The flag gate's refusal: the dialer gate's body shape (`helpers/dialer-gate.ts`), for this page. */
export const TEAM_PERFORMANCE_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Team performance is not enabled for this account.',
} as const;

/** Everything the route reads, injectable for tests. */
export interface TeamPerformanceRouteDeps {
  reads: Pick<TeamPerformanceReads, 'read' | 'clear'>;
  /** `agency_team_performance_enabled` for the request's tenant and account. A throw propagates (fails closed). */
  enabled(request: FastifyRequest): Promise<boolean>;
  /** Whether the campaign is the tenant's AND the account's. `campaignId` is a lower-cased UUID. */
  campaignInAccount(tenantId: string, accountId: string, campaignId: string): Promise<boolean>;
  /** The name Postgres cuts the zone's days in (`postgresZoneName`), or null when it knows none. */
  databaseZone(zone: string): Promise<string | null>;
  /** Today's local date in `zone`. */
  today(zone: string): string;
}

/** The production dependencies; `reads` is one per registration (cleared when the app closes). */
export function defaultTeamPerformanceRouteDeps(): TeamPerformanceRouteDeps {
  return {
    reads: new TeamPerformanceReads(),
    enabled: (request) => getFeatureFlagService().isEnabled(FLAGS.agency_team_performance_enabled, {
      tenantId: request.tenantId!,
      ...(request.accountId ? { accountId: request.accountId } : {}),
    }),
    async campaignInAccount(tenantId, accountId, campaignId) {
      const row = await agencyCampaignRepository.findById(campaignId);
      return row !== null && row.tenant_id === tenantId && row.account_id === accountId;
    },
    databaseZone: postgresZoneName,
    today: (zone) => localDateOf(new Date(), zone),
  };
}

/**
 * `{ error, code, message }` with the code's status (`AGENCY_TEAM_PERFORMANCE_ERROR_STATUS`), through
 * `sendRefusal`, as Compare's refusals: `team_busy` also carries when to try again
 * (`TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS`, the error mask's policy for an authored 429), and
 * `team_timed_out` (503) is a fixed, reviewed body sent through the mask's reviewed opt-out
 * (`preserveReviewedUpstreamError`) so it is not masked as "contact support".
 */
export function sendTeamRefusal(reply: FastifyReply, code: AgencyTeamPerformanceErrorCode): FastifyReply {
  const status = AGENCY_TEAM_PERFORMANCE_ERROR_STATUS[code];
  if (status >= 500) reply.request.preserveReviewedUpstreamError = true;
  return sendRefusal<AgencyTeamPerformanceErrorCode>(
    reply, status, code, TEAM_ERROR_MESSAGES[code],
    code === 'team_busy' ? { retryAfterSeconds: TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS } : {},
  );
}

export interface ProxyAgencyTeamPerformanceOptions {
  deps?: Partial<TeamPerformanceRouteDeps>;
}

/**
 * Team performance (docs/team-performance.md, rulings TP1–TP20; the wire is
 * `packages/contracts/src/api/agency/team-performance.ts`): `GET /team-performance` under
 * `/proxy/agency/`. The public layer of B16, SQL only (no `callCore`): the read composes the
 * roster's statements and Compare's sources for the whole cohort (`agency/team-performance/`).
 *
 * Guards, in Compare's order: the session and the tenant context (the hooks below); the RBAC floor
 * `agency.supervise` (TP3, the RBAC 403) and the `agency_team_performance_enabled` flag (`403
 * feature_disabled`, the dialer gate's body shape), as preHandlers; then the account scope (`400
 * account_scope_required`), the query's shape (the generic agency 400), the campaign
 * (`team_campaign_not_found`), the zone (`team_timezone_invalid`), the window
 * (`team_window_invalid`), and the read's own guards (`team_busy`, `team_timed_out`;
 * `agency/team-performance/read.ts`). Never cached by a browser (`Cache-Control: no-store`): the
 * answer names agents.
 *
 * One read cache and limiter per registration (`TeamPerformanceReads`), cleared when the app closes.
 */
export async function proxyAgencyTeamPerformanceRoutes(app: FastifyInstance, opts: ProxyAgencyTeamPerformanceOptions = {}): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  app.addHook('onRequest', noStoreHook);
  const deps: TeamPerformanceRouteDeps = { ...defaultTeamPerformanceRouteDeps(), ...opts.deps };
  app.addHook('onClose', async () => { deps.reads.clear(); });

  const flagGate: preHandlerAsyncHookHandler = async (request, reply) => {
    if (!(await deps.enabled(request))) return reply.code(403).send(TEAM_PERFORMANCE_DISABLED_BODY);
  };

  app.get('/team-performance', { preHandler: [requirePermission('agency.supervise'), flagGate] }, async (request, reply) => {
    const gone = clientGoneSignal(reply);
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    const parsed = parseOr400(teamPerformanceQuerySchema, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const q = parsed.data;
    const tenantId = request.tenantId!;

    const campaignId = q.campaign_id ?? null;
    if (campaignId !== null && !(await deps.campaignInAccount(tenantId, accountId, campaignId))) {
      return sendTeamRefusal(reply, 'team_campaign_not_found');
    }
    // The cheap rules first: Postgres is asked only about a zone that passes them.
    const databaseZone = isRequestZone(q.timezone) ? await deps.databaseZone(q.timezone) : null;
    const window = checkTeamWindow({ from: q.from, to: q.to, timezone: q.timezone }, databaseZone, deps.today);
    if (!window.ok) return sendTeamRefusal(reply, window.code);

    try {
      return reply.send(await deps.reads.read({
        tenantId, accountId, campaignId,
        // The answer echoes the request's zone; the reads cut days in Postgres's name for it.
        from: q.from, to: q.to, timezone: window.timezone, databaseTimezone: window.databaseTimezone,
      }, gone));
    } catch (err) {
      // The client closed the request first: its slot is back and its statement cancelled.
      if (err instanceof TeamAborted) return reply.code(CLIENT_CLOSED_STATUS).send();
      if (err instanceof TeamRefusal) return sendTeamRefusal(reply, err.code);
      throw err;
    }
  });
}
