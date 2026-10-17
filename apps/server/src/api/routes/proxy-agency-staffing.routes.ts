import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { registerMyStaffingRoutes } from './proxy-agency-staffing/my.js';
import { registerCampaignAgentRoutes } from './proxy-agency-staffing/campaign-agents.js';
// Shared with the performance plugin's `my-*` routes on this same prefix.
export { replyMissingActor, resolveMyAgentId } from './proxy-agency-staffing/my.js';

/*
 * Agent → campaign staffing, served at the console's paths under `/proxy/agency` (decision
 * B16). The rows are `agency_campaign_agents`, read and written here directly. The internal
 * handler instance is reached in-process through `callCore` for two things, both behind its
 * feature gate and `requireOwned`'s rule (tenant AND account): the best-effort labels in
 * `resolveCampaignSummaries` (`GET /agency-campaigns/summaries`, one read per hundred
 * campaigns on the page) and the ownership probe in `assertCampaignInScope`
 * (`GET /agency-campaigns/:id`). Audit rows go to `platformAuditLogger` (decision B7). There is no
 * capability gate; the RBAC floors are the gate.
 */

/**
 * Agent → campaign STAFFING: who a supervisor has put on a campaign, and the one
 * question an agent's own console asks before it can render anything.
 *
 * ── Why this file exists, distinct from `proxy-agency-agent.routes.ts` ──────
 * That file is the agent's ACTIONS on the call currently on their station — join,
 * go available, hang up, disposition. This one is the supervisor's list of PEOPLE
 * plus the agent's own lookup of it. They share a prefix and a middleware stack
 * and nothing else: one is a thin wrapper over the internal handler, the other
 * owns its rows and calls the handler only to name a campaign and prove ownership.
 *
 * **"Staffing", not "agents", and the filename is part of the guard.**
 * `proxy-agency-agents.routes.ts` would be one character from its neighbour, in
 * the same directory, serving the same prefix, which is an edit landing in the
 * wrong file waiting to happen. `staffing` is also the word the design uses to
 * separate this concept from authorization (see the next paragraph), so the name
 * carries the distinction rather than merely avoiding a collision. Note it is
 * likewise NOT `roster`: that word already means CONTACTS throughout this
 * codebase (`src/agency/agency-roster.client.ts`, the whole ingest pipeline).
 *
 * ── Staffing is NOT authorization, and nothing here should ever make it so ──
 * An assignment decides where an agent is *sent by default*. It does not gate a
 * join: that is `agency.station.connect`, on the sibling file's `POST /sessions`,
 * and it stays the only gate — a supervisor covering a shift must be able to join
 * a campaign nobody assigned them to, which the RBAC comments in
 * `packages/contracts/src/rbac.ts` protect explicitly. If a future change makes
 * the join consult `agency_campaign_agents` before allowing it, that is a
 * behaviour change to argue for on its merits, not a tidy-up.
 *
 * ── The floors, and the one that is load-bearing ────────────────────────────
 * Three supervisory routes at `agency.supervise` (`account_admin`, 30) and three
 * `my-*` routes at `agency.station.connect` (`agent`, 5). **Every `my-*` route
 * must be reachable by a bare `agent`**, which is the whole reason they exist — an
 * `agent` inherits nothing that predates the agency feature, so they must not
 * depend on any `viewer`-floored permission. In particular they must NEVER be
 * gated on `proxy.contact_lists.read`, which is what the neighbouring campaign
 * reads use: an agent does not hold it, and gating on it would make the agent
 * landing page 403 for exactly the role it was built for. `test/unit/agency/
 * proxy-agency-staffing.routes.test.ts` pins all six floors against the matrix.
 *
 * The same rule governs the agent's own performance reads in
 * `proxy-agency-performance.routes.ts` — a separate plugin on this same prefix,
 * because those are thin wrappers over the internal handler's per-agent
 * endpoints where these rows are read directly.
 *
 * Names and emails come from the user records — see
 * `src/agency/agency-agent-identity.ts` for how names are resolved and why a
 * failed lookup degrades rather than 500s.
 */

export async function proxyAgencyStaffingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // No capability gate: the app is the agency product, so the section-level `agency` gate
  // is always on. The RBAC floors below are the gate.

  // The routes (`./proxy-agency-staffing/`), on THIS instance so both hooks above
  // apply to each of them.
  await registerMyStaffingRoutes(app);
  await registerCampaignAgentRoutes(app);
}
