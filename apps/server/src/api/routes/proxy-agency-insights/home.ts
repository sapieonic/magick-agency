/*
 * Home's board (decision B28a): `GET /proxy/agency/home`. Part of `proxy-agency-insights.routes.ts`.
 */
import type { FastifyInstance } from 'fastify';
import { hasPermission } from '@magick-agency/contracts/rbac';
import { attentionAllocation } from '@magick-agency/contracts/api/agency/home';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { computeHomeBoard, type HomeInsightsDeps } from '../../../agency/home-board.js';
import { cachedAllocation, campaignStaffing } from '../../../agency/insights/allocation.js';
import { rangeAttentionFigures } from '../../../agency/insights/health.js';
import { liveStats } from '../helpers/live-stats.js';
import { dialerEnabled } from '../helpers/dialer-gate.js';
import { accountOrRefuse } from '../helpers/account-scope.js';

/** The insights reads the board makes for a supervisor: the insights routes' own, all `agency.supervise`. */
const INSIGHTS: HomeInsightsDeps = {
  staffing: campaignStaffing,
  allocation: async (campaign) => attentionAllocation(await cachedAllocation(campaign)),
  today: rangeAttentionFigures,
};

export async function registerHomeBoardRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /home — the active campaigns of the request's account, at most 25, each with the fields of
   * `/stats` Home and the Campaigns page's Active cards read and, for a supervisor, what the
   * campaign Overview's attention rules read: the allocation's staffing and attention figures,
   * today's carrier failures and recording, and the settings (`agency/home-board.ts`; the wire is
   * `contracts/api/agency/home.ts`). One request for what would be a list read plus four reads per
   * campaign; read by Home every 10 s, by the sidebar's Home badge every 60 s, and by the
   * Campaigns page's Active cards every 10 s while any campaign is active (B28a).
   *
   * Gated as the reads it replaces: `agency.campaigns.read`, the floor of the campaign list and of
   * `/stats` (a viewer may watch the live strip; `proxy-agency-campaigns/stats.ts`), so a viewer or
   * operator, who lands on the Campaigns page, reads the board too. The insights parts floor
   * higher (every insights route is `agency.supervise`): below that floor the board is built
   * without them (`insights: null`), so `staffing`, `allocation`, `today` and `settings` are null
   * (withheld, not failed) and none of their reads is made. Then the account scope (a 400, never
   * a tenant-wide board), then the dialer flag (`403 feature_disabled`, the campaign reads'
   * refusal). Each campaign's stats go through the internal stats handler under that campaign's
   * own account, which applies its gate and ownership again; the allocation, the staffing and
   * today's figures are the insights reads' own, for campaigns `listForHome` read under this
   * account.
   */
  app.get('/home', {
    preHandler: requirePermission('agency.campaigns.read'),
  }, async (request, reply) => {
    const accountId = accountOrRefuse(request.accountId, reply);
    if (!accountId) return reply;
    if (!(await dialerEnabled(request, reply))) return reply;
    const supervises = hasPermission(request.membership?.role, 'agency.supervise');
    const board = await computeHomeBoard({ tenantId: request.tenantId!, accountId }, {
      liveStats,
      insights: supervises ? INSIGHTS : null,
    });
    return reply.code(200).send(board);
  });
}
