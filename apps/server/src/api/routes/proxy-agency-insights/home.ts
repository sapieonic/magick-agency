/*
 * Home's board (decision B28a): `GET /proxy/agency/home`. Part of `proxy-agency-insights.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import type { AgencyHomeBoard } from '@magick-agency/contracts/api/agency/home';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { computeHomeBoard } from '../../../agency/home-board.js';
import { callbacksOverdueByCampaign } from '../../../agency/insights/allocation.js';
import { liveStats } from '../helpers/live-stats.js';
import { dialerEnabled } from '../helpers/dialer-gate.js';
import { accountOrRefuse } from '../helpers/account-scope.js';

/**
 * The board as a caller below `agency.supervise` may read it: every campaign's `callbacks_overdue`
 * is null (withheld, not failed). It is the insights allocation's count, which floors at
 * `agency.supervise`; everything else on the board is the list's and `/stats`' own.
 */
export function withoutOverdue(board: AgencyHomeBoard): AgencyHomeBoard {
  return { ...board, campaigns: board.campaigns.map((c) => ({ ...c, callbacks_overdue: null })) };
}

export async function registerHomeBoardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /home — the active campaigns of the request's account, at most 25, each with the fields of
   * `/stats` Home reads and its overdue callbacks (`agency/home-board.ts`; the wire is
   * `contracts/api/agency/home.ts`). One request for what was a list read plus two reads per
   * campaign; read by Home every 10 s, by the sidebar's Home badge every 60 s, and by the
   * Campaigns page's Active cards every 10 s while any campaign is active (B28a, amended
   * 2026-11-12).
   *
   * Gated as the reads it replaces: `agency.campaigns.read`, the floor of the campaign list and of
   * `/stats` (a viewer may watch the live strip; `proxy-agency-campaigns/stats.ts`), so a viewer or
   * operator, who lands on the Campaigns page, reads the board too. The one part that floors
   * higher is the overdue count (the insights allocation's, `agency.supervise`): below that floor
   * it is served null ({@link withoutOverdue}). Then the account scope (a 400, never a
   * tenant-wide board), then the dialer flag (`403 feature_disabled`, the campaign reads'
   * refusal). Each campaign's stats go through the internal stats handler under that campaign's
   * own account, which applies its gate and ownership again; the overdue counts are the
   * allocation's own predicate, one read for the board.
   */
  app.get('/home', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    if (!(await dialerEnabled(request, reply))) return reply;
    const board = await computeHomeBoard({ tenantId: request.tenantId!, accountId }, {
      liveStats,
      callbacksOverdue: callbacksOverdueByCampaign,
    });
    const supervises = hasPermission(request.membership?.role, 'agency.supervise');
    return reply.code(200).send(supervises ? board : withoutOverdue(board));
  });
}
