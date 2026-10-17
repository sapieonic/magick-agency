import type { FastifyInstance } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { registerPerAgentPerformanceRoutes } from './proxy-agency-performance/per-agent.js';
import { registerFloorPerformanceRoutes } from './proxy-agency-performance/floor.js';

/*
 * Agent performance reads, served at the console's paths under `/proxy/agency` (decision
 * B16). Each route runs the internal handler instance's body (`agency-agents.routes.ts`)
 * in-process through `callCore` (`../core-dispatch.ts`) with the request's tenant and
 * account. `callCore` has no transport to time out, and nothing bounds the roster and
 * grouped reads' wall clock (no `statement_timeout` is set; the handler's 92-day window
 * cap bounds how much work a caller can ask for). There are no platform API keys in v1 (`docs/decisions.md`, open question 5),
 * so `request.user` is always the Firebase-verified person; `resolveMyAgentId` is the
 * staffing plugin's. This plugin adds the query whitelists, `include_inactive`, the account
 * predicate, the membership filter, both omission counters, `assertAgentInTenant`'s 404 and
 * the name enrichment.
 */

/**
 * AGENT performance: an agent's own numbers, a supervisor's view of one agent's
 * numbers, and the supervisor's view of the whole roster.
 *
 * ── Why this is its own plugin on a shared prefix ──────────────────────────
 * Four of the six routes are two pairs, and the pairs differ only in whose id
 * goes in the path and which floor guards it. That symmetry is the whole point of
 * the plugin: the `my-*` and supervisory halves of one question live next to each
 * other (`./proxy-agency-performance/per-agent.ts`, one file for both pairs) so a
 * change to the shape of the answer cannot land on one and miss the other. The other two ask the same question about EVERYBODY at once —
 * `GET /agents/stats`, the roster, and `GET /agents/grouped-stats`, the general
 * grouped aggregate — and they belong here for the same reason: they are the
 * whole-floor siblings of `/agents/:userId/stats`, and all of them must agree
 * about the gate, the tenancy check and the name lookup. The two whole-floor
 * reads also share the three facts this route layer adds over the handler's
 * page — the account predicate, the departed-agent filter and the two omission
 * counters — which is precisely the code two copies would let drift, so it is
 * written once (`scopeRowsToMembers`, `./proxy-agency-performance/floor.ts`).
 *
 * It is NOT in `proxy-agency-staffing.routes.ts` (which serves `/my-assignments`
 * and `/my-campaigns` on this same prefix) because that file owns its rows: its
 * degradation story is about courtesy labels on an answer already in hand. These
 * six are thin wrappers over the internal handler, where the numbers are the
 * answer and this layer owns only the gate, the actor and one name lookup. It
 * is not in `proxy-agency-campaigns.routes.ts` either: that file is keyed on a
 * CAMPAIGN and has the handler prove ownership of one. These are keyed on a
 * PERSON, whose scoping is a `memberships` row.
 *
 * ── The floor is the critical detail, and it is the one that gets this wrong ──
 * `agency.station.connect` (`agent`, hierarchy level 5) on both `my-*` routes.
 * The role hierarchy puts `agent` BELOW `viewer`, so an `agent` holds exactly the four
 * `agency.*` permissions and nothing that predates the feature. The obvious-looking
 * gate for a stats read is `proxy.contact_lists.read` — it is what the neighbouring
 * campaign stats route uses — and it floors at `viewer` (10). Using it here would
 * 403 the only role these two routes exist for, while reading as entirely
 * reasonable in review. `proxy-agency-staffing.routes.ts` states this rule for its
 * own `my-*` routes; it applies here unchanged, and
 * `test/unit/agency/proxy-agency-my-surfaces.routes.test.ts` pins all four floors
 * against `PERMISSION_MATRIX` rather than trusting inspection.
 *
 * Both whole-floor reads floor at `agency.supervise` like the supervisory pair,
 * and the temptation there runs the other way: a whole-floor read looks like an
 * "analytics" surface, and `proxy.analytics.read` / `proxy.stats.read` both floor
 * at `viewer` — which would hand every viewer in the tenant a per-person
 * scorecard for the entire roster. `agency.supervise` stays at `account_admin`
 * (a locked product decision: no new role, no matrix change, no migration), and
 * `proxy-agency-roster.routes.test.ts` / `proxy-agency-grouped-stats.routes.test.ts`
 * pin that floor against `PERMISSION_MATRIX` too.
 *
 * ── The agent id is SERVER-SIDE on the `my-*` routes. Always. ──────────────
 * `request.user.id` and nothing else. There is no param, no query key and no body
 * field through which a caller can name another agent, and the whitelists (in
 * `./proxy-agency-performance/`) are the mechanism rather than a convention: `forwardAllowedQuery` copies only
 * the named params and REFUSES anything else, so an `?agent_user_id=` a client
 * appends is a **400** — the request is never built at all, let alone sent to the
 * handler with the param ignored. Stronger than a silent drop, and deliberately
 * so: a silently discarded param is a request that succeeded while doing
 * something other than what was asked. That is the same discipline the agent-action schemas use
 * (`proxy-agency-agent.routes.ts`: "a browser that could name the agent could go
 * available as a colleague"), and it matters more here, because reading another
 * agent's dispositions and talk time is a peer-surveillance surface the product
 * deliberately does not offer.
 *
 * A supervisor reading a named agent is the SUPERVISORY pair, floored at
 * `agency.supervise` (`account_admin`, 30) and tenant-scoped below.
 *
 * ── Names are added on the supervisory pair only ──────────────────────────
 * The internal handler serves `agent_user_id` as a bare UUID. This layer turns
 * that into a person from the user records, exactly as it does for the agent
 * floor and the attempt spine. The `my-*` pair is deliberately NOT enriched:
 * the caller is the subject, they know their own name, and a database read on a
 * route a console polls is cost with no answer attached. Both halves keep the
 * degrade-never-500 rule — a failed lookup yields `agent_name: null`, never a 500.
 */

export async function proxyAgencyPerformanceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // No capability gate: the app is the agency product, so the section-level `agency` gate
  // is always on. The RBAC floors below are the gate.

  // The routes (`./proxy-agency-performance/`), on THIS instance so both hooks above
  // apply to each of them.
  await registerPerAgentPerformanceRoutes(app);
  await registerFloorPerformanceRoutes(app);
}
