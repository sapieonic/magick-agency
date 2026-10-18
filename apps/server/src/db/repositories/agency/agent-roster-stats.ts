/**
 * The supervisor's agent roster read and its benchmark. Body of
 * `AgencyAgentStatsRepository.roster`, which delegates here.
 */
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
// The roster's rate-reportability floor. Imported rather than restated because it
// is a SHARED number: the console renders "not enough calls" from the same
// threshold, and a second copy here is how these percentiles come to exclude a
// row the console still labels reportable.
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyRosterAgentRow,
  type AgencyRosterBenchmark,
  type AgencyRosterPage,
} from '@magick-agency/contracts/agency';
// THE null-not-zero rate rule, in one place. Imported rather than re-expressed at
// each of the five call sites below — see the module for why a `0` on an empty
// denominator is the failure this exists to prevent.
import { ratePct, ratio } from '@magick-agency/domain/rates';
// The roster read adds its own three: the ranking rule (nulls last both ways,
// `agent_user_id` as the tiebreaker), the percentile rule, and the parsed params.
// All three are pure and live there so they can be exercised without a pool — see
// `roster()` for why the ranking cannot happen in SQL at all.
import {
  foldOccupancy,
  rosterPercentiles,
  sortRosterRows,
  zeroOccupancy,
  type AgentRosterParams,
} from '../../../agency/agent-record.js';
import { AGENCY_ATTEMPT_METRICS_SQL, occupancyIntervalsCtes, readAttemptMetrics } from './sql-fragments.js';
import { params } from './query-builders.js';
import { hasRateDenominator } from './projections.js';

const log = createChildLogger({ component: 'agency-repository' });

/**
 * ── THE ROSTER: every agent's performance in ONE read ─────────────────────
 *
 * `GET /api/v1/agency-agents/stats`. This is {@link stats} grouped one level
 * UP — per agent instead of per bucket — over the same half-open window, the
 * same two-hop join and the same scope predicate. There is no bucket on this
 * route, so there is no `date_trunc`, no `generate_series`, and **no campaign
 * timezone to resolve**: the `pg_timezone_names` LEFT JOIN both statements above
 * carry exists only to keep an unresolvable zone from raising `22023` inside a
 * bucket expression, and with no bucket expression there is nothing to protect.
 *
 * ── Scope, again, and for the same reason ─────────────────────────────────
 *
 * `tenant_id` AND `account_id` on `agency_agent_sessions` in EVERY statement.
 * There is no path parameter here at all, so there is even less to run an
 * ownership check against than on the per-agent record — the only thing
 * separating one account's floor from another's is the pair of predicates below.
 * A tenant-wide roster is a separate future mode; it must not be reachable by
 * omitting a parameter, which is why `accountId` is a required field of `scope`
 * rather than an optional filter on `params`.
 *
 * ── TWO READS, SEQUENTIAL — the one place this diverges from `stats()` ────
 *
 * `stats()` issues its two statements in parallel because both are bounded by
 * one agent id it already holds. This one cannot, and the reason is an index:
 * `idx_agency_session_events_agent` is `(agent_user_id, at)`, and **the index is only reachable because the reader
 * predicates on `agent_user_id`** — `session_id` is deliberately not indexed at
 * all. A roster-shaped occupancy read has no single agent, so issued in parallel
 * it would range on `e.at` with nothing on the index's leading column and drive
 * the join from an unindexed `session_id`: a sequential scan of the table
 * written on every state transition.
 *
 * So the attempts aggregate runs FIRST and its agent ids are bound into the
 * occupancy read as an array. That restores the exact predicate the index needs,
 * costs one round trip in series instead of two in parallel, and needs no new
 * index on a hot table. It also stops the occupancy read fetching agents the
 * roster is about to discard — see the row-set note below — and it lets the
 * second statement be skipped outright when nobody dialled.
 *
 * ── OCCUPANCY DEGRADES ALONE ─────────────────────────────────────────────
 *
 * Identical precedent to `stats()`, and the sequential order does not weaken it:
 * an occupancy-read failure is caught, warned, and serves the roster with every
 * agent's `shift_seconds`/`break_seconds` at 0 and `occupancy_pct` at `null`.
 * The supervisor asked who dialled what; answering with a 500 because a second
 * statement about where the floor's time went could not run discards numbers
 * that were already in hand. The mirror case is deliberately NOT caught: if the
 * attempts read fails there is no roster to serve.
 *
 * ── The row set is ATTEMPTS-driven, which is a correctness property ────────
 *
 * One row per agent who DIALLED in the window — the cohort
 * `AgencyRosterBenchmark` defines. An agent with occupancy and no dials gets no
 * line, unlike the per-agent record which deliberately emits their empty bucket.
 * Beyond matching the frozen cohort definition, this is what makes the degrade
 * above safe: if occupancy could ADD rows, a failed events-table read would
 * silently DELETE agents from the page, which is far worse than serving their
 * occupancy as zero. The row set must not change shape when a subsidiary read
 * fails.
 *
 * ── Why the ranking and the percentiles are NOT in SQL ────────────────────
 *
 * This is the design decision most likely to be read as laziness, so it is
 * derived rather than asserted. It is forced, in two steps:
 *
 *  1. `benchmark.occupancy_pct`'s percentiles are quantiles of
 *     `(talk + wrapup) / shift_seconds` **over the whole cohort**. `talk` and
 *     `wrapup` come from the attempts statement and `shift_seconds` from the
 *     occupancy statement, so that metric exists in neither one alone. Any
 *     `LIMIT` applied inside the attempts statement therefore destroys an input
 *     the benchmark needs — the limited page carries talk/wrapup for its own
 *     rows only.
 *  2. So the attempts statement must return the whole post-scope, pre-`limit`
 *     cohort, and `limit` can only be applied after the merge. Once the slice is
 *     out of SQL, so is the `ORDER BY` it slices: sorting in SQL and slicing in
 *     TypeScript would be two spellings of one comparator that must agree
 *     exactly on nulls and on the tiebreaker, and one of them would eventually
 *     be edited alone.
 *
 * The cohort is bounded by an account's HEADCOUNT (one row per agent, and
 * `limit`'s ceiling is 200), not by call volume, so the rows the aggregate
 * returns are cheap to carry. The upside is that `sort` and `order` never reach
 * a query at all: {@link sortRosterRows} is the single comparator, and the
 * injection surface for the two params that arrive as free text is zero rather
 * than merely well-guarded.
 *
 * `total_agents` is that same pre-`limit`, post-scope count, so the console can
 * say "showing 100 of 137" rather than implying the floor is the page.
 */
export async function agentRoster(
  scope: { tenantId: string; accountId: string },
  query: AgentRosterParams,
): Promise<AgencyRosterPage> {
  const attemptRows = await rosterAttemptTotals(scope, query);
  const agentIds = attemptRows.map((row) => row.agent_user_id);

  // Skipped rather than issued with an empty array: nobody dialled, so there is
  // no row for an occupancy figure to attach to, and `= ANY('{}')` is a
  // statement whose answer is known.
  const occupancyRows = agentIds.length === 0
    ? []
    : await rosterOccupancyTotals(scope, query, agentIds).catch((err: unknown) => {
      // Same catch, same warning, same reasoning as `stats()`: the realistic
      // failure is the event table being unreadable, which is
      // the drift the WRITE path already swallows in `recordTransitions`. Both
      // sides of the transition log are non-fatal and the warn line is the only
      // symptom either produces.
      log.warn(
        {
          err,
          tenantId: scope.tenantId,
          accountId: scope.accountId,
          agents: agentIds.length,
          from: query.from.toISOString(),
          to: query.to.toISOString(),
        },
        'Agent roster occupancy read failed — serving the roster with occupancy at zero',
      );
      return [] as { agent_user_id: string; state: string; seconds: number }[];
    });

  // Folded through `foldOccupancy` per agent rather than summed here, so the
  // unknown-state drop, the negative-interval clamp and the "shift excludes
  // offline" rule keep exactly one definition across both read surfaces.
  const byAgent = new Map<string, { state: string; seconds: number }[]>();
  for (const row of occupancyRows) {
    const existing = byAgent.get(row.agent_user_id);
    if (existing) existing.push(row);
    else byAgent.set(row.agent_user_id, [row]);
  }

  const rows: AgencyRosterAgentRow[] = attemptRows.map((row) => {
    const occupancy = byAgent.has(row.agent_user_id)
      ? foldOccupancy(byAgent.get(row.agent_user_id) as { state: string; seconds: number }[])
      : zeroOccupancy();
    const handled = row.talk_seconds + row.wrapup_seconds;
    return {
      agent_user_id: row.agent_user_id,
      attempts: row.attempts,
      connected: row.connected,
      successes: row.successes,
      talk_seconds: row.talk_seconds,
      wrapup_seconds: row.wrapup_seconds,
      // `null`, never `0`, on a zero denominator — the imported rule, and the
      // same helper every other rate on this surface uses. Nothing dialled is
      // not a 0% connect rate.
      connect_rate_pct: ratePct(row.connected, row.attempts),
      // The denominator is CONNECTED, not attempts: a call that never bridged
      // had no conversation to convert, so charging it here would make an
      // agent's conversion a function of the list's answer rate.
      success_rate_pct: ratePct(row.successes, row.connected),
      aht_seconds: ratio(handled, row.connected),
      campaigns: row.campaigns,
      shift_seconds: occupancy.shift_seconds,
      break_seconds: occupancy.by_state.break,
      // This route PICKS a denominator where `AgencyAgentOccupancy` deliberately
      // does not, because a roster column has to be one number. Break time is
      // INCLUDED; `shift_seconds - break_seconds` is the other reading and both
      // parts are on the row, so nothing is lost. `null` — never 0 — on a zero
      // shift, which is also what a degraded occupancy read produces.
      //
      // ── And `null` when the numerator EXCEEDS the denominator ───────────
      //
      // Nothing constrains this ratio to <= 1, because its two halves are
      // measured on two INDEPENDENT tables: the numerator (talk + wrapup) on
      // `agency_call_attempts`, which every settled attempt writes
      // transactionally, and the denominator on `agency_agent_session_events`,
      // whose writes are BEST-EFFORT — `recordTransitions` swallows a failed
      // INSERT with a warn and no rethrow. A dropped transition shortens the
      // shift while the calls it contained stay counted, so the ratio can pass
      // 100% by an arbitrary factor; 716% has been observed on a real read.
      //
      // NOT clamped to 100. A clamp hands the reader a plausible number computed
      // from an inconsistency, and "fully occupied" is a claim this data cannot
      // support. `null` is the value this column already documents for
      // "unmeasured", and reusing it drops the row from the percentile pools for
      // free — they filter nulls — which is the half that actually matters: an
      // impossible value left in the pool drags `occupancy_pct.p75` upward and
      // every other agent is then flagged against a cohort containing it, and
      // the same row ranks #1 under `?sort=occupancy_pct&order=desc`.
      //
      // `>=` rather than `>` so the equal case — including 0/0 — still goes
      // through `ratePct`, which is what keeps the zero-shift null a property of
      // one helper rather than of two branches.
      occupancy_pct: occupancy.shift_seconds >= handled
        ? ratePct(handled, occupancy.shift_seconds)
        : null,
      last_dialed_at: row.last_dialed_at,
      // The row's HEADLINE denominator. A row that fails this contributes to no
      // percentile pool, which is what makes the flag usable as the single gate
      // its contract doc promises. The rates are still served either way.
      rates_reportable: row.attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
      // The CONNECTED floor, from the same predicate the `success_rate` and `aht`
      // pools are admitted by — so a console gating on this flag withholds
      // exactly the rows the benchmark refused to rank, rather than a set that
      // agrees with it by coincidence.
      success_rate_reportable: hasRateDenominator(row),
    };
  });

  return {
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    campaign_id: query.campaignId ?? null,
    sort: query.sort,
    order: query.order,
    limit: query.limit,
    // PRE-`limit`, post-scope. Taken from `rows` rather than from a third
    // `COUNT(*)` statement, which is what makes it structurally equal to
    // `benchmark.agents` instead of a number two reads have to keep agreeing on.
    total_agents: rows.length,
    rows: sortRosterRows(rows, query.sort, query.order).slice(0, query.limit),
    // Computed over EVERY row, before the slice. A benchmark drawn from the page
    // would move when the caller changed `limit` — a different number under the
    // same name, which is the failure its own doc comment names about
    // `include_inactive`.
    benchmark: rosterBenchmark(rows),
  };
}

/**
 * One row per agent who dialled, over `[from, to)` on `dialed_at`.
 *
 * `stats()`'s `attemptBuckets` with the bucket removed and the agent id moved
 * from a predicate into the `GROUP BY`. Every column definition is the same,
 * character for character, and for the reasons stated there — the AGENT's leg for talk time
 * rather than the persisted column, orphans excluded because the reaper stamps
 * `ended_at` at sweep time, MEASURED wrap-up rather than the campaign's
 * allotment — because the roster and the per-agent record are read side by side
 * and a supervisor will subtract one from the other.
 *
 * ── The index this drives, and why it is the BILLING one ──────────────────
 *
 * Not `idx_agency_attempts_agent_dialed`. That index is
 * `(reserved_agent_id, dialed_at DESC) WHERE dialed_at IS NOT NULL` and its
 * leading column is a session id this statement has no predicate on — the whole
 * point of a roster is that it does not name an agent. What fits exactly is
 * `idx_agency_attempts_billing`:
 * `(dialed_at, campaign_id) WHERE dialed_at IS NOT NULL`, whose own comment says
 * `dialed_at` MUST lead because the billing sweep "is a time range across all
 * campaigns and has no campaign_id to filter on". That is this statement's shape
 * too, and `?campaign_id=` narrows on the index's second column when supplied.
 * The sessions and campaigns then join by primary key.
 *
 * So the roster's attempt aggregate needs no new index, and `idx_agency_attempts_agent_dialed` stays the single-agent read's index,
 * not this one's.
 */
async function rosterAttemptTotals(
  scope: { tenantId: string; accountId: string },
  p: AgentRosterParams,
): Promise<{
  agent_user_id: string;
  attempts: number; connected: number; successes: number;
  talk_seconds: number; wrapup_seconds: number;
  campaigns: number; last_dialed_at: string | null;
}[]> {
  const bind = params();
  for (const value of [p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
  const campaignFilter = p.campaignId
    ? `\n          AND a.campaign_id = ${bind.add(p.campaignId)}::uuid`
    : '';

  const { rows } = await getPool().query<{
    agent_user_id: string;
    attempts: string; connected: string; successes: string;
    talk_seconds: string; wrapup_seconds: string;
    campaigns: string; last_dialed_at: string | null;
  }>(
    `SELECT s.agent_user_id,
              ${AGENCY_ATTEMPT_METRICS_SQL},
              -- Distinct CAMPAIGNS dialled, not sessions joined: a session is per
              -- shift, so an agent who worked one campaign across three days would
              -- otherwise read as three campaigns.
              COUNT(DISTINCT a.campaign_id)::text AS campaigns,
              -- Formatted in SQL for the same reason every other instant on this
              -- surface is: node-pg's parsing of a bare timestamp reintroduces the
              -- server's zone. Never NULL in practice -- the WHERE clause requires
              -- dialed_at -- but typed nullable rather than asserted.
              to_char(MAX(a.dialed_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_dialed_at
         FROM agency_call_attempts a
         JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
         JOIN agency_campaigns c ON c.id = a.campaign_id
        WHERE s.tenant_id = $3
          AND s.account_id = $4
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $1
          AND a.dialed_at < $2${campaignFilter}
        GROUP BY s.agent_user_id
        ORDER BY s.agent_user_id`,
    bind.values,
  );

  return rows.map((r) => ({
    agent_user_id: r.agent_user_id,
    ...readAttemptMetrics(r),
    campaigns: Number(r.campaigns),
    last_dialed_at: r.last_dialed_at,
  }));
}

/**
 * Seconds per (agent, state) over the window, for a KNOWN set of agents.
 *
 * `stats()`'s `occupancyBuckets` with the bucket machinery removed and the
 * single agent id widened to an array. The interval clips it documents at length
 * are all still here and still load-bearing — the open final interval running to
 * `LEAST(now(), to, left_at)`, the event that CARRIES IN from before `from`, and
 * the `sess` CTE bounded to sessions overlapping the window (which is what keeps
 * `carried` from handing every closed session in an agent's tenure a full-window
 * interval). Read that method's header for why each exists; nothing about them
 * changes when the read covers a floor instead of a person, and the two
 * statements are kept BYTE-COMPARABLE on all of it — same clips, same tiebreaks,
 * same parameter positions — because they must agree and a divergence between
 * them is worse than either bug alone.
 *
 * What DOES go away is bucket splitting. With no buckets there is no
 * `generate_series`, no `CROSS JOIN LATERAL`, and no campaign timezone —
 * `bucketTruncSql` is the only thing that ever needed the zone, and the
 * `pg_timezone_names` LEFT JOIN existed only to stop an unresolvable one raising
 * `22023` inside it. A duration is zone-independent, so the whole apparatus
 * drops out rather than being carried along unused.
 *
 * ── `agent_user_id = ANY($1)` is not a filter, it is the driving predicate ──
 *
 * It appears on BOTH event reads, exactly as `stats()` carries `= $1` on both,
 * and for the identical reason spelled out above:
 * `idx_agency_session_events_agent` is `(agent_user_id, at)` and `session_id` is
 * deliberately not indexed, so without a predicate on the leading column the
 * planner has nothing to drive the range on `at` from. The ids come from the
 * attempts aggregate, which is why the two reads are sequential here where the
 * per-agent record runs them in parallel.
 *
 * It also carries the scope a second time over: the ids are already the output
 * of a tenant-and-account-scoped statement, and `sess` re-applies both
 * predicates anyway. That is deliberate belt-and-braces on a surface where the
 * WHERE clause is the only thing separating two accounts' floors — an
 * `agent_user_id` is opaque to the dialer tables and could legitimately collide across
 * tenants.
 */
async function rosterOccupancyTotals(
  scope: { tenantId: string; accountId: string },
  p: AgentRosterParams,
  agentUserIds: readonly string[],
): Promise<{ agent_user_id: string; state: string; seconds: number }[]> {
  // Bound in the SAME ORDER as `occupancyBuckets`: the agent selector first,
  // then from, to, tenant, account. The two statements are ~90% identical text
  // and a future editor will diff or copy between them, so binding the same five
  // values at different positions is a trap -- a swapped from/to survives review
  // because `WHERE i.ended > i.started` absorbs an inverted window as an empty
  // result rather than as an error. One convention across both: the selector, if
  // the statement has one, is $1.
  const bind = params();
  for (const value of [[...agentUserIds], p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
  const campaignFilter = p.campaignId
    ? `\n            AND s.campaign_id = ${bind.add(p.campaignId)}::uuid`
    : '';

  const { rows } = await getPool().query<{
    agent_user_id: string; state: string; seconds: string;
  }>(
    `${occupancyIntervalsCtes('roster', campaignFilter)}       SELECT i.agent_user_id,
              i.state,
              SUM(EXTRACT(EPOCH FROM (i.ended - i.started)))::text AS seconds
         FROM intervals i
        WHERE i.ended > i.started
        GROUP BY i.agent_user_id, i.state
        ORDER BY i.agent_user_id, i.state`,
    bind.values,
  );

  return rows.map((r) => ({
    agent_user_id: r.agent_user_id,
    state: r.state,
    seconds: Number(r.seconds),
  }));
}

/**
 * The cohort the roster's rows are read against.
 *
 * A free function rather than a method because it is a pure fold over rows the
 * repository has already produced — it issues no statement, and computing it from
 * the rows rather than from a third aggregate is what makes `benchmark.agents` and
 * `AgencyRosterPage.total_agents` the same number by construction instead of two
 * counts that have to keep agreeing.
 *
 * ── Pooled rates and percentiles are DIFFERENT numbers, both on the payload ──
 *
 * `connect_rate_pct` here is the floor's actual rate: total connected over total
 * attempts. `connect_rate.median` is the middle AGENT's rate. They diverge exactly
 * when agents differ in volume, which is always, and a consumer handed one cannot
 * derive the other — so both are served.
 *
 * The pooled rates are computed over EVERY row, thin ones included; the
 * percentiles are not. That is not an inconsistency. A pooled rate is a ratio of
 * two sums, so a row contributes in proportion to its own size — eleven calls move
 * it by eleven calls' worth. A median is a ratio of ratios, where those same
 * eleven calls cast one full vote alongside an agent's four hundred. The asymmetry
 * is the whole reason `AGENCY_ROSTER_MIN_RATE_DENOMINATOR` gates one and not the
 * other.
 *
 * ── Which rows enter each percentile pool ─────────────────────────────────────
 *
 * `rates_reportable` is the row-level gate and a row that fails it enters NONE of
 * the three pools — that is what makes the flag mean what its contract comment
 * promises. On top of it:
 *
 *   * `success_rate` additionally requires `connected >=` the threshold, because
 *     that rate's own denominator is `connected`. 400 dials with three connects is
 *     a reportable row whose 33% conversion is three calls of evidence. That extra
 *     floor is `hasRateDenominator`, the same predicate the row's own
 *     `success_rate_reportable` is set from, so the flag on the wire and the pool
 *     admission cannot disagree. Note it makes the `rated` prefilter REDUNDANT for
 *     this pool and for `aht`: `connected <= attempts` always, so `connected >= 20`
 *     already implies `attempts >= 20`. The prefilter is kept anyway — it costs
 *     nothing and it states the rule that governs all three pools — but a reader
 *     hunting for the case where the two floors disagree will not find one.
 *   * `occupancy_pct` takes every reportable row with a non-null value. Its
 *     denominator is a DURATION and the threshold counts CALLS, so the same
 *     integer cannot gate it; the exclusion that matters there is the `null` a zero
 *     `shift_seconds` already produces — which is also what a degraded occupancy
 *     read produces, so a failed events-table read empties this pool rather than
 *     filling it with zeros.
 *
 * A `null` rate is never passed through in any pool. `rosterPercentiles` ranks
 * numbers, and JavaScript sorts `null` as 0 — one agent who connected nobody would
 * otherwise sit at the bottom of the distribution as a hard 0% and drag p25 down
 * with them, which is the exact false reading the null exists to prevent.
 */
function rosterBenchmark(rows: readonly AgencyRosterAgentRow[]): AgencyRosterBenchmark {
  const pooled = rows.reduce(
    (acc, row) => {
      acc.attempts += row.attempts;
      acc.connected += row.connected;
      acc.successes += row.successes;
      acc.talk += row.talk_seconds;
      acc.wrapup += row.wrapup_seconds;
      // Pooled in the SAME reduce as the counters, over the SAME rows, rather than
      // in a second pass — which is what makes it impossible for the cohort's
      // shift to describe a different agent set from the cohort's talk time. Both
      // are 0 when the occupancy read degraded, exactly as every row's is.
      acc.shift += row.shift_seconds;
      acc.break_ += row.break_seconds;
      return acc;
    },
    { attempts: 0, connected: 0, successes: 0, talk: 0, wrapup: 0, shift: 0, break_: 0 },
  );

  const rated = rows.filter((row) => row.rates_reportable);
  /** Non-null values of one metric, over the rows that qualified for its pool. */
  const pool = (
    qualifies: (row: AgencyRosterAgentRow) => boolean,
    read: (row: AgencyRosterAgentRow) => number | null,
  ): number[] => rated
    .filter(qualifies)
    .map(read)
    .filter((value): value is number => value !== null);

  return {
    agents: rows.length,
    agents_rated: rated.length,
    attempts: pooled.attempts,
    connected: pooled.connected,
    successes: pooled.successes,
    talk_seconds: pooled.talk,
    wrapup_seconds: pooled.wrapup,
    connect_rate_pct: ratePct(pooled.connected, pooled.attempts),
    success_rate_pct: ratePct(pooled.successes, pooled.connected),
    aht_seconds: ratio(pooled.talk + pooled.wrapup, pooled.connected),
    // `rates_reportable` IS `attempts >= threshold`, so the pool needs no further
    // predicate: connect_rate's denominator is exactly the one the flag gates.
    connect_rate: rosterPercentiles(pool(() => true, (row) => row.connect_rate_pct)),
    // `hasRateDenominator`, the SAME function object both of these are handed and
    // the same one that sets the row's `success_rate_reportable` — not two copies
    // of one comparison that happen to agree today. `aht_seconds` divides by
    // `connected` exactly as `success_rate_pct` does, so the two pools take the
    // same floor, and passing the predicate rather than restating it is what makes
    // them unable to drift when the threshold is next argued about.
    success_rate: rosterPercentiles(pool(hasRateDenominator, (row) => row.success_rate_pct)),
    occupancy_pct: rosterPercentiles(pool(() => true, (row) => row.occupancy_pct)),
    shift_seconds: pooled.shift,
    break_seconds: pooled.break_,
    aht: rosterPercentiles(pool(hasRateDenominator, (row) => row.aht_seconds)),
  };
}
