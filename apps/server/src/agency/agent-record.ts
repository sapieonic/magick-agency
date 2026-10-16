/**
 * ─── AGENCY DIALER — THE AGENT'S OWN RECORD, PARSED AND BUCKETED ────────────
 *
 * Everything `GET /api/v1/agency-agents/:agentUserId/stats` needs that is neither
 * SQL nor a Fastify handler: the bucket vocabulary, the query parsing, the ONE
 * spelling of the bucket expression both aggregates use, and the fold from
 * (state, seconds) rows to an occupancy block.
 *
 * A near-leaf module — types from `contracts.ts`, and the parsing primitives
 * from `spine-filters.ts`, imported rather than re-spelled so this surface cannot
 * end up with a second opinion about what an ISO date is. It exists apart from the
 * routes so the rules can be exercised without a Fastify instance, and apart from
 * the repository so the SQL builder receives a shape it can trust.
 *
 * The three reads live in `agent-record/` — `stats.ts` (the agent's own record),
 * `roster.ts` (the supervisor's roster) and `grouped.ts` (the grouped read) — and
 * this module re-exports all of them, so it stays the one import path.
 */

export * from './agent-record/stats.js';
export * from './agent-record/roster.js';
export * from './agent-record/grouped.js';
