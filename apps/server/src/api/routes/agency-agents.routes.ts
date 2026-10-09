import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { authMiddleware, getTenantId, getAccountId } from '../middleware/auth.middleware.js';
import { getFeatureFlagService, FLAGS } from '../../feature-flags/index.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  agencyAgentStatsRepository,
  agencyAttemptRepository,
} from '../../db/repositories/agency.repository.js';
import {
  parseAgentAttemptFilters,
  parseAgentStatsQuery,
  parseGroupedStatsQuery,
  parseRosterQuery,
} from '../../agency/agent-record.js';
import { clampLimit } from '../../agency/spine-filters.js';
import { decodeKeysetCursor, type AgencyKeysetPosition } from '@magick-agency/domain/keyset-cursor';
import type {
  AgencyAgentStats,
  AgencyAttemptsPage,
  AgencyGroupPage,
  AgencyRosterPage,
} from '@magick-agency/contracts/agency';

const log = createChildLogger({ component: 'agency-agent-routes' });

/**
 * `agency_agent_sessions.agent_user_id` is a `UUID`, and the public API layer
 * validates the id before it calls here. This guard refuses a blank or over-long
 * value rather than truncating it: a longer value can only ever match nothing,
 * and answering an empty record for it would look like a fact about an agent
 * instead of a malformed request.
 *
 * Note the length arm is currently unreachable over HTTP — Fastify's own
 * `maxParamLength` defaults to 100, the same width, and answers 404 for a longer
 * path segment before any handler runs. Kept as defence in depth (and because
 * `maxParamLength` is a server option someone may raise); the blank arm catches
 * a whitespace-only id, which is what a broken link produces.
 */
const MAX_AGENT_USER_ID_LENGTH = 100;

/**
 * ─── THE AGENT'S OWN RECORD ─────────────────────────────────────────────────
 *
 * Four reads. Two are keyed on a PERSON rather than on a campaign, one is keyed on
 * the FLOOR, and one is keyed on whatever the caller asks for:
 *
 *   * `GET /api/v1/agency-agents/:agentUserId/stats`    — the aggregate record
 *   * `GET /api/v1/agency-agents/:agentUserId/attempts` — the attempt spine,
 *                                                         cross-campaign
 *   * `GET /api/v1/agency-agents/stats`                 — the ROSTER: every
 *                                                         agent's line, plus the
 *                                                         cohort they are read
 *                                                         against
 *   * `GET /api/v1/agency-agents/grouped-stats`         — one GENERAL grouped
 *                                                         aggregate, 1..2
 *                                                         caller-chosen dimensions
 *
 * The roster and the grouped read are on THIS plugin and not their own for the
 * reason the section below is about: it is the same two-hop join, the same opaque
 * `agent_user_id`
 * vocabulary and the same tenant-and-account-predicate-instead-of-ownership-check,
 * so putting it anywhere else would mean a second copy of the auth wiring that has
 * already been shipped wrong once here.
 *
 * ── Why this is a separate plugin and not two more routes on the campaign one ─
 *
 * Everything on `agency-campaigns` starts by resolving a campaign the caller owns
 * (`requireOwned`) and scoping to it. These cannot: an agent works several
 * campaigns, and their record is the union across them. The attempt row points at
 * a SESSION (`reserved_agent_id`), sessions are per shift per campaign, and
 * `agent_user_id` — a user id, opaque to these handlers — lives on the session.
 * So the person is two joins away from their own work, and every query here is
 * driven from the far side of those joins. `GET /agency-campaigns/:id/attempts`
 * structurally cannot answer "what did I do this week"; it can only ever answer it
 * one campaign at a time.
 *
 * ── AUTH AND THE FLAG ARE ON THIS PLUGIN, and that is the whole risk here ────
 *
 * **Auth middleware is registered PER ROUTE PLUGIN, not globally**, so a plugin
 * mounted as a sibling inherits none of its neighbours' hooks and a route on it
 * ships unauthenticated. These routes serve every phone number, note and
 * disposition an agent has touched, across campaigns, so getting it wrong here
 * ships a great deal.
 *
 * Hence: `addHook('preHandler', authMiddleware)` on the plugin, `gate()` inside
 * every handler, and `test/unit/agency/agent-record-routes.test.ts` asserting both
 * actually run rather than trusting this comment. The test asserts the MIDDLEWARE
 * WAS CALLED, not a status code — a route that does not exist also answers 404,
 * which would make a status-code assertion vacuous.
 *
 * ── The tenant scope is a PREDICATE, not an ownership check ──────────────────
 *
 * There is no campaign in these paths to own, and `agent_user_id` is opaque: these
 * handlers cannot tell a real user id from a guessed one. So both repository reads scope on
 * `agency_agent_sessions.tenant_id`/`account_id` — an id from another tenant
 * resolves to no sessions and therefore to an empty record, never to someone
 * else's. An empty record is deliberately indistinguishable from an agent who has
 * never worked here, so these routes cannot be used to probe whether a user id is
 * real.
 */
export async function agencyAgentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware);

  /**
   * Every route here is behind `agency_dialer_enabled`.
   *
   * No exceptions, unlike `agencyCampaignRoutes` — whose `/stop` and `/pause` are
   * deliberately ungated so that turning the kill switch off does not also remove
   * the off button. That reasoning is about controls that reduce dialing volume;
   * these are pure reads and change nothing, so the flag's other job applies
   * unqualified: make the feature ABSENT for a tenant who has not bought it, and
   * answer 403 on a surface they should not be able to see.
   */
  async function gate(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const enabled = await getFeatureFlagService().isEnabled(FLAGS.agency_dialer_enabled, {
      tenantId: getTenantId(request), accountId: getAccountId(request),
    });
    if (!enabled) {
      reply.code(403).send({
        error: 'Feature Not Enabled',
        code: 'feature_disabled',
        message: 'Agency dialer is not enabled for this account.',
      });
      return false;
    }
    return true;
  }

  /** The path's agent id, or `null` once it has replied. */
  function readAgentUserId(
    request: FastifyRequest<{ Params: { agentUserId: string } }>,
    reply: FastifyReply,
  ): string | null {
    const raw = request.params.agentUserId ?? '';
    const agentUserId = raw.trim();
    if (agentUserId.length === 0 || agentUserId.length > MAX_AGENT_USER_ID_LENGTH) {
      reply.code(400).send({
        error: 'Validation failed',
        code: 'invalid_agent_user_id',
        details: { agentUserId: `must be 1..${MAX_AGENT_USER_ID_LENGTH} characters` },
      });
      return null;
    }
    return agentUserId;
  }

  /**
   * Parse `?cursor=` into a keyset position.
   *
   * A malformed cursor is **400, not a silent reset to page one** — a list that
   * quietly restarts from the top reads as duplicate rows to whoever is scrolling
   * it, and there is no way to tell that from real duplicates. Same rule, same
   * words, as the campaign spine's own `readCursor`; the decoder is imported so
   * there is one definition of what a cursor is.
   */
  function readCursor(
    request: FastifyRequest,
    reply: FastifyReply,
  ): AgencyKeysetPosition | null | undefined {
    const raw = (request.query as { cursor?: unknown } | undefined)?.cursor;
    if (raw === undefined || raw === null || String(raw).length === 0) return undefined;
    const decoded = decodeKeysetCursor(String(raw));
    if (!decoded) {
      reply.code(400).send({
        error: 'Validation failed',
        code: 'malformed_cursor',
        details: { cursor: 'not a cursor this API issued' },
      });
      return null;
    }
    return decoded;
  }

  /**
   * ── GET /api/v1/agency-agents/stats — THE ROSTER ──────────────────────────
   *
   * `?from=&to=&campaign_id=&sort=&order=&limit=`. `from` inclusive, `to`
   * EXCLUSIVE, both required — the same window rules as the per-agent record
   * below, parsed by the same imported primitives.
   *
   * One row per agent who dialled in the window, plus a `benchmark` describing the
   * cohort those rows were drawn from. It exists because a supervisor's first
   * question is never "what did this person do" — it is "who is my floor and how
   * do they compare", and fanning the per-agent read out over thirty agents cannot
   * answer the second half: a median has to be computed over the whole floor at
   * once, so it has to be one read.
   *
   * ── ROUTE PRECEDENCE, and why it gets its own test ────────────────────────
   *
   * This path has one FEWER segment than `/:agentUserId/stats`, so Fastify's
   * radix tree separates them with no ambiguity — a static segment also wins over
   * a parametric one at the same position, so `/stats` could not be captured as an
   * `:agentUserId` even if the depths matched. None of that is asserted by the
   * routes existing, which is the point: `agent-record-routes.test.ts` pins BOTH
   * directions (`/stats` reaches the roster, `/<uuid>/stats` still reaches the
   * per-agent record), because an assertion can pass vacuously against a route
   * that does not exist. A 404 and a
   * wrong-handler-answered-200 are both invisible to a status-code assertion on
   * the OTHER route.
   *
   * ── What this route deliberately does NOT accept ──────────────────────────
   *
   * No `bucket` — there are no date buckets here, so none of the
   * per-campaign-timezone machinery below applies; a duration and a count are
   * zone-independent. No `agent_user_id` — the subject is the whole roster, and
   * narrowing to named agents is a later compare surface; accepting it would make
   * `benchmark` mean something different per request under the same name. No
   * `include_inactive` either: these handlers do not read memberships, so that
   * filter belongs to the public API layer and never reaches here.
   *
   * ── `sort`/`order`/`limit` are applied SERVER-side, and echoed back ────────
   *
   * A console that sorted locally would be sorting one page of a ranked list,
   * which is a different and wrong answer — so the ranking and the truncation
   * happen here and the response echoes all three. `total_agents` is the
   * pre-`limit`, post-scope count, so the console can say "showing 100 of 137"
   * rather than implying the floor is whatever fitted on the page.
   *
   * An unknown `sort` or `order`, or a `limit` outside 1..200, is a **400 naming
   * the valid set** — never a silent default. That is a deliberate divergence from
   * the attempt spine's `clampLimit`, which pins the value: a clamped page size on
   * a cursor-paged list still returns the next rows, whereas a silently changed
   * limit on a RANKED list with no cursor changes which agents are on the page.
   *
   * ── ⚠️ `limit` BOUNDS THE PAYLOAD, NOT THE WORK ───────────────────────────
   *
   * Raised in review, and stated here because the parameter's name implies the
   * opposite. `?limit=1` costs the same as `?limit=200`: both of the roster's
   * statements are FULL-COHORT scans by construction, and neither can be narrowed
   * by a page size.
   *
   *   * `rosterAttemptTotals` carries **no `LIMIT` at all**, deliberately, and a
   *     test pins its absence. The benchmark's percentiles describe "the middle half
   *     of the floor", so they have to be computed over every agent who dialled
   *     BEFORE the slice — a benchmark drawn from the page would be a different
   *     number under the same name, moving as the caller changed `limit`. The
   *     truncation is therefore applied in TypeScript, to the payload, after the
   *     cohort has already been aggregated.
   *   * `rosterOccupancyTotals` then walks `agency_agent_session_events` for every
   *     agent in that cohort — a table whose `session_id` is indexed by nothing. It
   *     is bounded by headcount times events-per-shift rather than by the page.
   *
   * So the only thing bounding this route's work is the **92-day window cap**
   * (`ROSTER_MAX_WINDOW_DAYS`), plus the account scope. That is accepted rather than
   * overlooked: the roster's row count is a HEADCOUNT, which is what makes the
   * unlimited aggregate affordable at all — the same reasoning that refuses
   * occupancy on `/grouped-stats`, whose cardinality is a product of dimensions and
   * which therefore does push its `limit` into SQL.
   *
   * **No `statement_timeout`, and that is filed rather than done.** None is set
   * anywhere in this server — there is no precedent to follow and no place to put
   * a per-route budget without introducing the concept, which is a server-wide
   * change and outside this route's scope. Nothing else bounds it either:
   * `callCore` runs in-process and ignores `timeoutMs`, and a cancelled request
   * leaves the scan running. Anyone tightening this should add the timeout on both
   * statements.
   *
   * ── Occupancy degrades ALONE ──────────────────────────────────────────────
   *
   * `shift_seconds`, `break_seconds` and `occupancy_pct` come from the transition
   * log (migration 105) in a second statement. If that read fails the repository
   * catches, warns, and serves every row with occupancy at zero and
   * `occupancy_pct` at `null` rather than 500ing the attempt totals — the same
   * precedent as the per-agent record, and the row SET is unaffected because the
   * rows are driven by who dialled. So a zeroed occupancy column has three causes
   * (no events, no events in the window, or a failed read) and only the log tells
   * them apart; every attempt number is unaffected either way.
   */
  app.get('/stats', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;

    const parsed = parseRosterQuery((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }

    const payload: AgencyRosterPage = await agencyAgentStatsRepository.roster(
      { tenantId: getTenantId(request), accountId: getAccountId(request) },
      parsed.filters,
    );
    // The window width, the cohort size and the ranking — never an agent id. This
    // is thirty people's performance in one response, so the operational signal is
    // the shape of the request, not who is in it.
    log.debug(
      {
        sort: parsed.filters.sort,
        order: parsed.filters.order,
        totalAgents: payload.total_agents,
        rows: payload.rows.length,
      },
      'Agent roster served',
    );
    return reply.send(payload);
  });

  /**
   * ── GET /api/v1/agency-agents/grouped-stats — THE GENERAL GROUPED READ ─────
   *
   * `?from=&to=&campaign_id=&group_by=&sort=&order=&limit=`. `from` inclusive, `to`
   * EXCLUSIVE, both required, capped at the SAME 92 days as the roster — the same
   * constant, not a second one holding the same value.
   *
   * One row per group over 1..2 caller-chosen dimensions (`agent`, `campaign`,
   * `disposition`, `day`, `day_of_week`, `hour_of_day`). It exists so the console
   * can answer "who drove this campaign", "which hours connect" and "how does this
   * agent's week trend" without a route per question — and it is a NEW route rather
   * than `group_by` bolted onto the roster because the roster payload is frozen:
   * `AgencyRosterAgentRow` is keyed on `agent_user_id`, so an hour-grouped row is
   * not that shape, and a polymorphic frozen payload is the worst of both.
   *
   * ── ROUTE PRECEDENCE, tested rather than reasoned about ────────────────────
   *
   * `/grouped-stats` is a static single segment, as `/stats` is, so Fastify's radix
   * tree separates all three of these from `/:agentUserId/stats` with no ambiguity
   * — a static segment also beats a parametric one at the same position. None of
   * that is asserted by the route existing, which is the point: an assertion can
   * pass vacuously against a route that does not exist, and a 404 and a
   * wrong-handler 200 are both invisible to a status-code assertion on a sibling
   * route. `agent-record-routes.test.ts` pins WHICH
   * repository method ran.
   *
   * ── The two refusals that are not typos, and why they carry a `code` ───────
   *
   * A well-formed request whose every value is in its vocabulary can still be
   * unanswerable, so those two 400s name themselves:
   *
   *   * `too_many_dimensions` — 3+ dimensions. The row count is the PRODUCT of
   *     their cardinalities, so a third turns a bounded read into an unbounded one,
   *     and no screen in scope needs one.
   *   * `timezone_ambiguous` — a time dimension without an unambiguous zone.
   *     Buckets are cut in the CAMPAIGN's own `default_timezone`, so across
   *     campaigns in different zones "the 18:00 row" is not one thing. Legal when
   *     `campaign` is also grouped, or exactly one `campaign_id` is filtered; the
   *     message names both remedies. **There is deliberately no implicit UTC
   *     fallback and no `tz` parameter** — silently bucketing an `Asia/Kolkata`
   *     account as UTC puts the real connect peak six columns to the left, and the
   *     only symptom is a rostering decision that is quietly wrong.
   *
   * Everything else is the generic validation 400 with `details`, and an unknown
   * `group_by`/`sort`/`order` echoes the valid set rather than defaulting.
   *
   * ── What this route deliberately does NOT serve ────────────────────────────
   *
   * No `occupancy` — it comes from a second statement over
   * `agency_agent_session_events`, and this read's cardinality is a product where
   * the roster's is a headcount; worse, occupancy cannot be attributed to a
   * `disposition` or an `hour_of_day` without inventing an apportionment rule. No
   * `benchmark` — a cohort of dispositions or of hours is not a peer group, so a
   * median over them would be a number with no meaning that a console would
   * nonetheless render. Both stay on the roster. No `agent_user_id` filter, same
   * reason as the roster: it is opaque here, so only the public API layer can validate it.
   *
   * ── `limit` IS pushed into SQL here, unlike the roster ─────────────────────
   *
   * The roster may carry no `LIMIT` at all (its benchmark needs the whole
   * pre-`limit` cohort, and a test pins the absence). This read has no benchmark
   * and no second statement, so nothing outside the page depends on the rows the
   * page omits — and the slice belongs where the rows are. `total_groups` is still
   * the PRE-`limit`, post-scope count, from a window function in the same statement
   * rather than a second scan.
   */
  app.get('/grouped-stats', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;

    const parsed = parseGroupedStatsQuery((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      // The first coded issue becomes the body's `code`, and `details` still
      // carries every message. Lifted rather than replaced: a request can be both
      // unanswerable AND have a bad `limit`, and dropping the rest of the list
      // would send the caller round the loop twice.
      const code = parsed.issues.find((issue) => issue.code !== undefined)?.code;
      return reply.code(400).send({
        error: 'Validation failed',
        ...(code ? { code } : {}),
        details: parsed.issues,
      });
    }

    const payload: AgencyGroupPage = await agencyAgentStatsRepository.groupedStats(
      { tenantId: getTenantId(request), accountId: getAccountId(request) },
      parsed.filters,
    );
    // The shape of the question, never who is in the answer — same rule as the
    // roster's line. `group_by` is the canonical list, so two spellings of the same
    // read log identically and the cardinality below is comparable across them.
    log.debug(
      {
        groupBy: payload.group_by.join(','),
        sort: parsed.filters.sort,
        order: parsed.filters.order,
        totalGroups: payload.total_groups,
        rows: payload.rows.length,
      },
      'Agent grouped stats served',
    );
    return reply.send(payload);
  });

  /**
   * ── GET /api/v1/agency-agents/:agentUserId/stats ──────────────────────────
   *
   * `?from=&to=&bucket=day|week|month&campaign_id=`. `from` inclusive, `to`
   * EXCLUSIVE, both required.
   *
   * ── BUCKETS ARE CUT IN EACH CAMPAIGN'S OWN TIMEZONE, PER ATTEMPT ───────────
   *
   * This is the first thing a reader will think is a bug, so it is stated here as
   * well as on the contract type and in the repository.
   *
   * The bucket for an attempt is `date_trunc(<bucket>, dialed_at AT TIME ZONE
   * <that attempt's campaign's default_timezone>)`. Not the query's timezone —
   * **there is deliberately no `tz` parameter** — and not UTC. So a call dialled at
   * 23:30 on an `Asia/Kolkata` campaign lands in that local day, and a call dialled
   * an hour later on an `America/New_York` campaign lands in the previous local
   * day, and both are right.
   *
   * *Why:* for an agent's own record, "the day it was for that call" is the correct
   * reading. It is the day the customer was in, the day the campaign's calling
   * window was drawn against, and the day the shift was rostered to. Cutting in one
   * chosen zone instead makes every bucket a function of a parameter the reader
   * supplied, so the same call moves between days depending on who is looking —
   * and on a record someone's performance is discussed against, that is worse than
   * an unusual day boundary.
   *
   * *What it buys:* because the zone comes off the attempt's own campaign, every
   * attempt lands in exactly ONE bucket. So `totals`, `buckets[]` and
   * `by_campaign[]` sum exactly — no double-counting, no gaps — and `totals` is
   * computed by summing the buckets rather than by a second aggregate, which makes
   * that structural rather than a claim two queries have to keep agreeing on.
   *
   * *What it costs, accepted:* a "day" is not one contiguous 24-hour window when an
   * agent works campaigns in different zones. Two buckets with the same label can
   * cover overlapping wall-clock instants, and the union of a day's buckets can be
   * wider than 24 hours. That is the accepted trade.
   *
   * Bucketing is on `dialed_at` — never `created_at` (a dispatch hop earlier, so it
   * can bucket an attempt into a day nothing was dialled in) and never `ended_at`
   * (which pushes a call straddling midnight into the later day and leaves a live
   * one in no day at all). `bucket_start` is a `YYYY-MM-DD` string formatted in
   * SQL, not a timestamp: node-pg parses a bare `timestamp` into a LOCAL-time
   * `Date`, which would put the server's zone back on a value the query went to
   * some trouble to remove. `hourlyBuckets` states both reasons and this follows
   * it.
   *
   * `attempts` and `connected` are BOTH reported, with `connect_rate_pct` between
   * them — a product decision, not a redundancy. Every rate is `null` (never `0`)
   * on a zero denominator, and `success_rate_pct`'s denominator is `connected`
   * rather than `attempts`: a call that never bridged had no conversation to
   * convert. `occupancy` comes from the transition log (migration 105) and is only
   * meaningful from that migration forward — sessions with no events read as zeros
   * rather than as anything inferred. It also DEGRADES to those same zeros if its
   * read fails (the repository catches and warns rather than failing the whole
   * record), so a zeroed occupancy block has two causes and only the log tells
   * them apart; the attempt numbers are unaffected either way.
   */
  app.get<{ Params: { agentUserId: string } }>('/:agentUserId/stats', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const agentUserId = readAgentUserId(request, reply);
    if (!agentUserId) return reply;

    const parsed = parseAgentStatsQuery((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }

    const payload: AgencyAgentStats = await agencyAgentStatsRepository.stats(
      { tenantId: getTenantId(request), accountId: getAccountId(request), agentUserId },
      parsed.filters,
    );
    // Logged at debug rather than counted: this is a person's own record, so the
    // interesting operational signal is the window width, not the identity.
    log.debug({ bucket: parsed.filters.bucket, buckets: payload.buckets.length }, 'Agent record served');
    return reply.send(payload);
  });

  /**
   * ── GET /api/v1/agency-agents/:agentUserId/attempts ───────────────────────
   *
   * The attempt spine, agent-scoped and CROSS-campaign — which
   * `/agency-campaigns/:id/attempts` structurally cannot be.
   *
   * `?outcome=&state=&disposition_code=&campaign_id=&from=&to=&cursor=&limit=`,
   * plus `phone=` and `contact_id=` because the filter vocabulary is IMPORTED
   * rather than forked: `parseAgentAttemptFilters` delegates to
   * `parseAttemptFilters`, so `ATTEMPT_STATES` / `ATTEMPT_OUTCOMES` have one
   * definition and the 400 that echoes them says the same thing on both routes.
   * `?agent_user_id=` parses and is ignored — the path is the agent.
   *
   * Paged by the same opaque keyset cursor, minted by the same `keyset-cursor.ts`,
   * ordered `created_at DESC, id DESC`. `from`/`to` bound `created_at` here (the
   * column the cursor orders by) rather than `dialed_at`: an attempt that never
   * left the building has no `dialed_at`, and dropping those rows from a
   * date-filtered LIST would hide exactly the failures a complaint is about. The
   * stats endpoint above buckets on `dialed_at` for the opposite reason — it is
   * aggregating dials. The divergence is deliberate.
   */
  app.get<{ Params: { agentUserId: string } }>('/:agentUserId/attempts', async (request, reply) => {
    if (!(await gate(request, reply))) return reply;
    const agentUserId = readAgentUserId(request, reply);
    if (!agentUserId) return reply;

    const parsed = parseAgentAttemptFilters((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.issues });
    }
    const cursor = readCursor(request, reply);
    if (cursor === null) return reply;

    const page: AgencyAttemptsPage = await agencyAttemptRepository.listForAgent({
      tenantId: getTenantId(request),
      accountId: getAccountId(request),
      agentUserId,
      filters: parsed.filters,
      ...(cursor ? { after: cursor } : {}),
      limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
    });
    return reply.send(page);
  });
}
