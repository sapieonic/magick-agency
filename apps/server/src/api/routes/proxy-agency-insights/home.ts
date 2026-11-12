/*
 * Home's board (decision B28a): `GET /proxy/agency/home`. Part of `proxy-agency-insights.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { computeHomeBoard } from '../../../agency/home-board.js';
import { cachedAllocation } from '../../../agency/insights/allocation.js';
import { liveStats } from '../helpers/live-stats.js';
import { dialerEnabled } from '../helpers/dialer-gate.js';
import { accountOrRefuse } from '../helpers/account-scope.js';

export async function registerHomeBoardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /home — the active campaigns of the request's account, at most 25, each with the fields of
   * `/stats` Home reads and its overdue callbacks (`agency/home-board.ts`; the wire is
   * `contracts/api/agency/home.ts`). One request for what was a list read plus two reads per
   * campaign; read by Home every 10 s and by the sidebar's Home badge every 60 s.
   *
   * Gated as the reads it replaces, at the strictest of them: `agency.supervise` (the insights
   * allocation's floor and Home's own; the list and `/stats` floor lower), then the account scope
   * (a 400, never a tenant-wide board), then the dialer flag (`403 feature_disabled`, the campaign
   * reads' refusal). Each campaign's stats go through the internal stats handler under that
   * campaign's own account, which applies its gate and ownership again; the allocation is the
   * insights route's cached read.
   */
  app.get('/home', {
    preHandler: requirePermission('agency.supervise'),
  }, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    if (!(await dialerEnabled(request, reply))) return reply;
    const board = await computeHomeBoard({ tenantId: request.tenantId!, accountId }, {
      liveStats,
      callbacksOverdue: async (campaign) => (await cachedAllocation(campaign)).totals.callbacks_overdue,
    });
    return reply.code(200).send(board);
  });
}
