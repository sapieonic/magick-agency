/**
 * The grouped agent read: the group dimensions, sorts and key readers, and the
 * statement. Body of `AgencyAgentStatsRepository.groupedStats`, which delegates
 * here.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
// BEGIN / COMMIT / ROLLBACK / release, and joining a caller's transaction (decision
// B8). A leaf too: the pool is passed in, so the `getPool` mock stays in charge.
import { withTransaction } from '@magick-agency/db/utils/transaction';
import {
  AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
  type AgencyGroupDimension,
  type AgencyGroupKey,
  type AgencyGroupPage,
  type AgencyGroupRow,
  type AgencyGroupSort,
} from '@magick-agency/contracts/agency';
// THE null-not-zero rate rule, in one place. Imported rather than re-expressed at
// each of the five call sites below — see the module for why a `0` on an empty
// denominator is the failure this exists to prevent.
import { ratePct, ratio } from '@magick-agency/domain/rates';
import {
  bucketStartSql,
  groupedPageHasSingleZone,
  type AgentGroupedParams,
} from '../../../agency/agent-record.js';
import {
  AGENCY_ATTEMPT_METRICS_SQL,
  AGENCY_RESOLVED_ZONE_JOIN_SQL,
  AGENCY_RESOLVED_ZONE_SQL,
  readAttemptMetrics,
} from './sql-fragments.js';
import { params } from './query-builders.js';
import { hasRateDenominator } from './projections.js';

/**
 * Every group dimension's SQL, as the inverted `Record` — and this object IS the
 * injection answer for `group_by`.
 *
 * `sort`, `order`, `group_by` and `limit` all arrive as free text. `limit` is a
 * bound parameter; the other three resolve through a `Record` lookup keyed on a
 * union member that {@link parseGroupedStatsQuery} has already validated, to a
 * fragment written here in source. So no caller-supplied character can reach the
 * statement even if the vocabulary check were removed — the lookup would simply
 * miss.
 *
 * `Record<AgencyGroupDimension, …>` rather than a `switch`: a seventh dimension
 * added to the union is a missing required key here, i.e. a build error naming it,
 * where a `switch` with a `default` would compile and silently group by whatever
 * the fallback picked.
 *
 * ── Three fragments per dimension, and the split is load-bearing ───────────
 *
 * `select` is the CTE's expression, in its NATURAL type. `project` is the outer
 * select item, which is where a numeric dimension is cast to text. They are not
 * one fragment because the ORDER BY reads `g.<alias>` — the CTE's column, at the
 * CTE's type — and **a text-typed hour sorts `'10'` before `'9'`**. Casting inside
 * the CTE would therefore make `sort=key` on an hour-of-day series silently
 * mis-order the x-axis, and with the slice now in SQL it would also change WHICH
 * hours a `limit` returns. Keeping the cast at the outer boundary makes the
 * ordering numeric because the column is.
 *
 * The cast still has to happen, though, and `::int::text` is deliberate on both
 * halves: node-pg hands `numeric` back as a STRING and `int4` back as a JS number,
 * so `EXTRACT`'s `numeric` would give this row mapper two conventions in one row.
 * `::int` states that the value is integral (a day-of-week is not `3.0`), and
 * `::text` puts every column on this statement through the same `Number()` hop as
 * the counters — which is also the only way a fixture that types them as strings,
 * the way node-pg actually returns them, exercises the mapping at all.
 *
 * `day` reuses {@link bucketStartSql}, not a second `to_char(date_trunc(...))`:
 * the contract says a `day` key has the same format as the per-agent record's
 * `bucket_start`, and sharing the expression is what makes that true rather than
 * claimed. It also inherits that function's reason for formatting in SQL — node-pg
 * parses a bare `timestamp` into a LOCAL-time `Date`, putting the server's zone
 * back on a value the query removed it from. It sorts correctly as text because
 * `YYYY-MM-DD` is lexicographically chronological, which is half of why that
 * format was chosen.
 */
const GROUP_DIMENSION_SQL: Record<
  AgencyGroupDimension,
  { select: string; alias: string; project: string }
> = {
  agent: { select: 's.agent_user_id', alias: 'agent_user_id', project: 'g.agent_user_id' },
  campaign: { select: 'a.campaign_id', alias: 'campaign_id', project: 'g.campaign_id' },
  // NULL is a real key value here, not a gap — an attempt with no disposition
  // submitted is the number a supervisor came for. `GROUP BY` puts every NULL in
  // one group, which is exactly the wanted behaviour and is NOT true of a join.
  // It is also the ONLY dimension that can be null, which is what the explicit
  // NULLS LAST in every ORDER BY is there for.
  disposition: {
    select: 'a.disposition_code', alias: 'disposition_code', project: 'g.disposition_code',
  },
  day: {
    select: bucketStartSql('day', 'a.dialed_at', AGENCY_RESOLVED_ZONE_SQL),
    // NOT `day`: that is an SQL keyword. Non-reserved, so `AS day` is legal -- but
    // the tree has no precedent for aliasing a keyword and `day_start` costs nothing
    // while matching the per-agent read's own `bucket_start`. The wire key is still
    // `day`; GROUP_KEY_READERS maps it. (Written when this statement had never run
    // against Postgres; it now does, in `agent-grouped-read.test.ts`, which groups
    // by this dimension -- the alias is kept on the two reasons that survive rather
    // than on the one that expired.)
    alias: 'day_start',
    project: 'g.day_start',
  },
  // 0 = Sunday .. 6 = Saturday, which is `EXTRACT(DOW)`'s own numbering and the
  // reason the contract types this as a NUMBER: restating it as a day name invites
  // an off-by-one against ISO's 1=Monday, and the name is a locale decision the
  // console owns.
  day_of_week: {
    select: `EXTRACT(DOW FROM (a.dialed_at AT TIME ZONE ${AGENCY_RESOLVED_ZONE_SQL}))::int`,
    alias: 'day_of_week',
    project: 'g.day_of_week::text AS day_of_week',
  },
  hour_of_day: {
    select: `EXTRACT(HOUR FROM (a.dialed_at AT TIME ZONE ${AGENCY_RESOLVED_ZONE_SQL}))::int`,
    alias: 'hour_of_day',
    project: 'g.hour_of_day::text AS hour_of_day',
  },
};

/**
 * The ORDER BY term for each METRIC sort key. `key` is absent on purpose — it is
 * the grouped dimensions themselves, assembled from
 * {@link GROUP_DIMENSION_SQL} at the call site, so it has no fixed text.
 *
 * ── Two things every entry here has to get right ────────────────────────────
 *
 *  1. **`::numeric`, always.** The shared metric builder casts every counter to
 *     `::text`, so ordering them as they arrive would rank `'9'` above `'400'` —
 *     a silently wrong "top 200 by attempts" that no type checker can see.
 *  2. **`NULLIF(<denominator>, 0)`, never a bare division.** Postgres raises
 *     `22012 division_by_zero` on `x / 0`, which nothing maps to a status, so a
 *     single group that connected nobody would 500 the whole page under
 *     `?sort=success_rate_pct`. `NULLIF` makes it NULL, which the explicit
 *     `NULLS LAST` then files where the contract says an unranked row goes.
 *
 * ⚠️ **These expressions ORDER the rows; they do not PRODUCE the served rates.**
 * The payload's `connect_rate_pct` / `success_rate_pct` / `aht_seconds` come from
 * {@link ratePct} / {@link ratio} in {@link groupRowFromSql}, like every other rate
 * on this surface. Two reasons the numbers are not read off these columns instead:
 * a Postgres `numeric` division round-tripped through text can differ in its last
 * digits from the JS float division the roster and the per-agent record use, so the
 * same data would report two slightly different rates on two adjacent screens; and
 * the null-on-empty-denominator rule would then have two implementations. What
 * these must agree with the helpers on is only the ORDER — which holds because
 * `x/d` and `100·x/d` rank identically for positive `d`, and both are null on
 * exactly `d = 0`.
 */
const GROUP_SORT_ORDER_SQL: Record<Exclude<AgencyGroupSort, 'key'>, string> = {
  attempts: 'g.attempts::numeric',
  connected: 'g.connected::numeric',
  successes: 'g.successes::numeric',
  connect_rate_pct: 'g.connected::numeric / NULLIF(g.attempts::numeric, 0)',
  success_rate_pct: 'g.successes::numeric / NULLIF(g.connected::numeric, 0)',
  aht_seconds:
    '(g.talk_seconds::numeric + g.wrapup_seconds::numeric) / NULLIF(g.connected::numeric, 0)',
};

/**
 * One row as the grouped statement returns it: every column a string, and the key
 * columns present only when their dimension was grouped.
 *
 * Optional on the type rather than asserted, because the statement genuinely does
 * not select them — a mapper that read `row.day` on an agent-grouped read must be
 * a compile error, not an `undefined` that becomes the string `"undefined"` in a
 * key.
 */
interface AgencyGroupRawRow {
  agent_user_id?: string;
  campaign_id?: string;
  disposition_code?: string | null;
  day_start?: string;
  day_of_week?: string;
  hour_of_day?: string;
  attempts: string;
  connected: string;
  successes: string;
  talk_seconds: string;
  wrapup_seconds: string;
  total_groups: string;
}

/**
 * How each dimension is read back onto the key, as the inverted `Record` for the
 * third time — and the three objects are separate deliberately.
 *
 * {@link AGENCY_GROUP_DIMENSIONS} guards the 400, {@link GROUP_DIMENSION_SQL}
 * builds the statement, and this reads the answer. They guard three different
 * failures, and a dimension present in one and missing from another is a build
 * error whichever one was forgotten.
 *
 * ⚠️ `disposition` assigns UNCONDITIONALLY, including when the value is `null`.
 * That is the grouped-stats contract's null-key rule expressed in one line: `null` is a real key value
 * — the un-dispositioned group — so the member must be PRESENT and null, never
 * absent. `?? null` also normalises a missing column to `null` rather than letting
 * `undefined` reach a JSON payload, where it would vanish and make the group look
 * un-grouped.
 */
const GROUP_KEY_READERS: Record<
  AgencyGroupDimension,
  (row: AgencyGroupRawRow, key: AgencyGroupKey) => void
> = {
  agent: (row, key) => { key.agent_user_id = row.agent_user_id ?? ''; },
  campaign: (row, key) => { key.campaign_id = row.campaign_id ?? ''; },
  disposition: (row, key) => { key.disposition_code = row.disposition_code ?? null; },
  day: (row, key) => { key.day = row.day_start ?? ''; },
  // `?? '0'`, and NOT a bare `Number(...)`. The contract types both of these
  // `number`, `Number(undefined)` is `NaN`, and `JSON.stringify` turns `NaN` into
  // `null` -- so a missing column would ship a null on a non-nullable field and be
  // invisible on the wire, which is the same failure the readers above spend their
  // `?? ''` on. The fallback is unreachable (the column is selected iff the
  // dimension is grouped, and the three Records above are what keep that true), and
  // that unreachability is what makes 0 an acceptable choice even though 0 is also a
  // REAL value for both -- Sunday, and midnight. A legal in-range value a console
  // can render beats a null the type says cannot happen; if this ever fires, the
  // bug is a missing Record entry, not the payload.
  day_of_week: (row, key) => { key.day_of_week = Number(row.day_of_week ?? '0'); },
  hour_of_day: (row, key) => { key.hour_of_day = Number(row.hour_of_day ?? '0'); },
};

/**
 * One SQL row → one {@link AgencyGroupRow}.
 *
 * A free function rather than an inline `map` body for the same reason
 * `rosterBenchmark` is one: it is pure, it issues no statement, and the rules it
 * carries — which key members exist, and that every rate comes from the shared
 * helper — are the two things a reviewer needs to check without reading SQL.
 *
 * The key is assembled by walking `groupBy` rather than by inspecting which
 * columns the row happens to have, so `AgencyGroupPage.group_by` and the key's
 * members cannot disagree: the echoed list IS the list that built the key.
 *
 * Every rate goes through {@link ratePct} / {@link ratio}. A hand-rolled
 * `n / d * 100` here would answer `NaN` on a zero denominator, `NaN` serialises to
 * `null` in JSON, and the bug would be invisible on the wire until a consumer did
 * arithmetic with it.
 */
function groupRowFromSql(row: AgencyGroupRawRow, groupBy: readonly AgencyGroupDimension[]): AgencyGroupRow {
  const key: AgencyGroupKey = {};
  for (const dimension of groupBy) GROUP_KEY_READERS[dimension](row, key);

  const {
    attempts, connected, successes, talk_seconds: talkSeconds, wrapup_seconds: wrapupSeconds,
  } = readAttemptMetrics(row);

  return {
    key,
    attempts,
    connected,
    successes,
    talk_seconds: talkSeconds,
    wrapup_seconds: wrapupSeconds,
    // `null`, never `0`, on a zero denominator — the imported rule, unchanged.
    //
    // Note that `attempts` is >= 1 on every row this statement can emit (`COUNT(*)`
    // over an all-INNER `GROUP BY` filtered on `dialed_at IS NOT NULL` cannot
    // produce a group with no rows), so `connect_rate_pct` is never actually null
    // here. It goes through the helper anyway: the rule belongs to one function
    // rather than to a reachability argument that a later `LEFT JOIN` would quietly
    // invalidate.
    connect_rate_pct: ratePct(connected, attempts),
    // The denominator is CONNECTED, not attempts: a call that never bridged had no
    // conversation to convert. This one IS reachably null — a group that connected
    // nobody is an ordinary row.
    success_rate_pct: ratePct(successes, connected),
    aht_seconds: ratio(talkSeconds + wrapupSeconds, connected),
    // The SERVER decides whether these rates may be quoted as numbers, because a
    // consumer recomputing the threshold from the exported constant would disagree
    // with this line the moment the threshold is tuned. Same constant as the roster
    // row, not a second one holding the same value.
    //
    // `attempts` — the row's headline denominator — so one bool covers the one rate
    // built on it, and the reading holds whatever was grouped: enough dials behind
    // this cell to quote a connect rate for it, whether the cell is a person, a
    // campaign, a disposition or one weekday-hour of a heatmap.
    rates_reportable: attempts >= AGENCY_ROSTER_MIN_RATE_DENOMINATOR,
    // The SECOND flag, and it is not a nicety: `attempts >= 20` says nothing about
    // `connected`, so a row of 20 dials with ONE connect and one conversion is
    // `rates_reportable` and carries `success_rate_pct: 100` — which is the exact
    // number, beside a named person on the contribution screen, that the first flag
    // was added to stop a console printing. One threshold on one denominator could
    // not cover two denominators; this is the per-metric floor the house rule asks
    // for, from the same constant and the same predicate the roster's percentile
    // pools use.
    success_rate_reportable: hasRateDenominator({ connected }),
  };
}

/**
 * ── GET /api/v1/agency-agents/grouped-stats — ONE GENERAL GROUPED AGGREGATE ─
 *
 * `rosterAttemptTotals`' row set, regrouped by one or two CALLER-CHOSEN
 * dimensions instead of by agent. The five metric expressions are the shared
 * {@link AGENCY_ATTEMPT_METRICS_SQL} — the same string this file's two other
 * attempts aggregates interpolate — which is what makes a grouped cell, a roster
 * line and an agent's own scorecard agree on the same attempts.
 *
 * Precisely: that row set TIMES its matching `pg_timezone_names` rows, because
 * this statement carries a join `rosterAttemptTotals` does not
 * ({@link AGENCY_RESOLVED_ZONE_JOIN_SQL}). The two are the same row set only
 * because that join is LATERAL and `LIMIT 1`, so the multiplier is exactly one for
 * every campaign — matched or not. That is the whole reason it is written as a
 * lateral: without it, "regrouped" would be a claim about tzdata's contents rather
 * than about this statement.
 *
 * ⚠️ And "that row set" holds EXACTLY when `agent` is grouped. Where it is not,
 * this read is deliberately WIDER than the roster's: the session join goes LEFT,
 * so attempts that never reached an agent are counted too. That is stated here as
 * well as at the join because a reader arriving from `rosterAttemptTotals` will
 * otherwise subtract one from the other and expect zero. See the join for why the
 * two questions differ.
 *
 * ── ONE aggregate statement, and `limit` is pushed DOWN into it ────────────
 *
 * The opposite of `roster()`, and the difference is worth stating because the
 * two reads sit next to each other. The roster CANNOT carry a `LIMIT`: its
 * benchmark's occupancy percentiles need per-agent talk+wrapup from one statement
 * and shift_seconds from another, for the WHOLE cohort, so a limit inside either
 * destroys an input the payload needs — and a test pins the absence. This read
 * has no benchmark and no aggregate over the rows the page omits, so nothing
 * outside the page depends on them, and the limit belongs where the rows are:
 * in SQL, so a 400-group matrix costs 200 rows over the wire instead of 400.
 *
 * `total_groups` is the one thing that DOES need the pre-limit count, and it
 * comes from `COUNT(*) OVER ()` in the outer select rather than from a second
 * `COUNT(*)` statement. Window functions are evaluated before `LIMIT`, so the
 * number is the pre-limit group count by construction — where two statements
 * would be two scans that could disagree if a write landed between them.
 *
 * ⚠️ And that window has a COST worth naming, because it partly offsets the
 * paragraph above. An EMPTY partition (`OVER ()`) cannot emit its first row until
 * it has seen the last one, so the plan MATERIALISES all `total_groups` rows —
 * spilling to disk past `work_mem` — even when `limit` is 1. Two dimensions over
 * a 92-day window can be tens of thousands of groups, and the server sets no
 * `statement_timeout` anywhere, so nothing cuts that short. Pushing the slice down
 * still wins on what crosses the WIRE, which is what it was for; it does not make
 * the read cheap, and the window cap is the only thing bounding it.
 *
 * ── The ORDER BY is TOTAL, which is what makes `limit` reproducible ────────
 *
 * Every ORDER BY here ends with the full grouped key ascending. The key is unique
 * per row by definition of `GROUP BY`, so the ordering has no ties at all — and
 * with the slice now in SQL, a partial order would mean two identical requests
 * returning DIFFERENT rows rather than merely the same rows in a different order.
 * `NULLS LAST` is spelled explicitly in both directions (Postgres defaults it
 * last only under `ASC`), so an unranked row is never on the first page of a
 * ranked question — the same rule, and the same words, as {@link sortRosterRows}.
 *
 * ── `sort` / `order` / `group_by` / `limit` still interpolate NOTHING ──────
 *
 * Unlike the roster, this read's ordering and slicing DO happen in SQL — so the
 * injection answer cannot be "they never reach a statement". It is instead that
 * every one of them resolves through a TypeScript `Record` lookup keyed on a
 * validated union member to a static fragment written in this file:
 * {@link GROUP_DIMENSION_SQL}, {@link GROUP_SORT_ORDER_SQL}. No caller-supplied
 * character reaches the statement; `limit` is a bound parameter like every value.
 *
 * ── The zone apparatus is reused unchanged, and joined UNCONDITIONALLY ─────
 *
 * {@link AGENCY_RESOLVED_ZONE_JOIN_SQL} with {@link AGENCY_RESOLVED_ZONE_SQL},
 * exactly as `attemptBuckets` has it and for exactly the reason stated there:
 * `default_timezone` is `VARCHAR(64)` with no constraint, `ts AT TIME ZONE
 * 'Mars/Olympus'` raises `22023 invalid_parameter_value`, and nothing maps that to
 * a status — so ONE campaign with a typo would take out every other campaign's
 * numbers in the same statement. The LEFT JOIN turns that into a per-row fallback
 * to UTC, and the LATERAL `LIMIT 1` is what keeps it from being able to FAN OUT —
 * read that constant, because the cardinality is what this statement's numbers
 * rest on, not merely its cost.
 *
 * Joined even when no time dimension is grouped, for two reasons and only the
 * second is about cost. The FIRST: making the FROM clause depend on `group_by`
 * means a future dimension whose expression reads `z.name` with no `z` in scope —
 * a runtime `42P01` on a statement that type-checks, discovered by whoever asked
 * the new question first. The SECOND: one join against a ~1,200-row view, once per
 * statement, which is cheap enough that the first reason wins uncontested.
 *
 * Whether a time dimension may be grouped AT ALL is decided in
 * {@link parseGroupedStatsQuery}: across campaigns in different
 * zones "the 18:00 row" is not one thing, so it is refused rather than answered
 * in UTC. That refusal is a product rule and lives with the other parsing rules;
 * by the time this method runs, the zone is already unambiguous.
 *
 * ── No new index ──────────────────────────────────────────────────────────
 *
 * The driving predicate is the half-open window on `dialed_at` plus an optional
 * `campaign_id`, with the sessions and campaigns joined by primary key — which is
 * `idx_agency_attempts_billing`, `(dialed_at, campaign_id) WHERE
 * dialed_at IS NOT NULL`, leading on exactly the column this scan is driven from.
 * Same argument as `rosterAttemptTotals`, and the same conclusion: nothing here
 * wants an index that does not exist. Grouping columns do not want indexes anyway
 * — the aggregate has to visit every qualifying row whatever it groups by.
 */
export async function agentGroupedStats(
  scope: { tenantId: string; accountId: string },
  p: AgentGroupedParams,
): Promise<AgencyGroupPage> {
  // Bound in the SAME ORDER as `rosterAttemptTotals`: from, to, tenant, account,
  // then the optional campaign. That statement and this one share their whole
  // FROM clause and their whole WHERE clause, so a future editor will diff or
  // copy between them — and a swapped from/to survives review, because an
  // inverted window is an empty result rather than an error. `limit` goes last
  // because it is the only parameter that belongs to the page rather than to the
  // rows.
  const bind = params();
  for (const value of [p.from, p.to, scope.tenantId, scope.accountId]) bind.add(value);
  const campaignFilter = p.campaignId
    ? `\n          AND a.campaign_id = ${bind.add(p.campaignId)}::uuid`
    : '';

  // Every fragment below comes from a `Record` keyed on a validated union member.
  // `p.groupBy` is already canonical and deduplicated (`parseGroupedStatsQuery`),
  // so the ordinals, the select list and the key mapper walk the same list in the
  // same order — which is what makes the echoed `group_by` describe the row shape.
  const dimensions = p.groupBy.map((dimension) => GROUP_DIMENSION_SQL[dimension]);
  const innerSelect = dimensions
    .map((dimension) => `${dimension.select} AS ${dimension.alias}`)
    .join(',\n              ');
  // Ordinals rather than repeating the expressions: `date_trunc(...)` in a GROUP
  // BY has to be spelled identically to the select-list copy or Postgres treats
  // them as different expressions, and one spelling cannot drift from itself.
  const groupOrdinals = dimensions.map((_dimension, index) => index + 1).join(', ');
  // `project`, not `g.<alias>`: a numeric dimension is cast to text HERE and not
  // in the CTE, so the ORDER BY below still reads an integer column. See
  // GROUP_DIMENSION_SQL — a text-typed hour sorts '10' before '9'.
  const outerSelect = dimensions.map((dimension) => dimension.project).join(', ');

  const direction = p.order === 'asc' ? 'ASC' : 'DESC';
  // The key, ascending, terminates EVERY ordering — see the header. Under
  // `sort=key` it IS the ordering and takes the caller's direction; under a metric
  // sort it is the tiebreak and stays ascending, so flipping an unrelated column's
  // direction cannot reshuffle a stable page.
  const keyOrder = (keyDirection: string): string => dimensions
    .map((dimension) => `g.${dimension.alias} ${keyDirection} NULLS LAST`)
    .join(', ');
  const orderBy = p.sort === 'key'
    ? keyOrder(direction)
    : `${GROUP_SORT_ORDER_SQL[p.sort]} ${direction} NULLS LAST, ${keyOrder('ASC')}`;

  const limitPlaceholder = bind.add(p.limit);

  // ── The SECOND statement, and why there is one at all ────────────────────
  //
  // `resolved_timezone` is the zone this page's buckets were ACTUALLY cut in, and
  // it exists only when there IS one zone: a zoned dimension grouped AND the read
  // filtered to one campaign (`groupedPageHasSingleZone`, which carries the
  // derivation). A `campaign,hour_of_day` read with no filter spans every
  // campaign in the account, each row cut in its own zone, and reports `null`.
  //
  // It is read from `agency_campaigns` rather than off the CTE's rows, and that
  // is the whole reason it cannot ride the statement above: a zoned read whose
  // window holds NO attempts returns zero rows, so a zone taken off the rows
  // would be `null` on precisely the page that most needs its axis labelled — an
  // empty heatmap is still a heatmap, and an unlabelled hour axis re-introduces
  // "the 18:00 column is not a fact until a zone is named" at the presentation
  // layer.
  //
  // ⚠️ A deliberate, narrow exception to this read's one-statement rule, and
  // it is not in tension with the reason this read refuses occupancy: occupancy
  // scans `agency_agent_session_events`, whose `session_id` is indexed
  // by nothing, against a row count that is a PRODUCT of cardinalities. This is a
  // primary-key lookup of one campaign row plus a lateral against a ~1,200-row
  // view, at most once per request, and only on the single-campaign zoned read —
  // the reads that refusal protects do not issue it at all.
  const zoneCampaignId = groupedPageHasSingleZone(p) ? p.campaignId : undefined;

  // ── The session join is LEFT unless `agent` is what is being ATTRIBUTED ────
  //
  // `agency_call_attempts.reserved_agent_id` is NULLABLE and it is
  // NULL on every attempt that failed before an agent was ever on it. An INNER
  // join therefore DROPS those attempts, and on a campaign-shaped read
  // (`hour_of_day`, `campaign`, `disposition`, `day`, with no `agent`) dropping
  // them is wrong three ways: it understates the very hour a supervisor is about
  // to move staffing to, it disagrees with the billing sweep (which selects on
  // `dialed_at IS NOT NULL` and joins no session at all), and it disagrees with
  // the campaign attempt spine, which LEFT joins the session ON PURPOSE and says
  // so. "When do dials connect" includes a dial that never reached an agent: that
  // dial is a real attempt, with a real outcome, in a real hour.
  //
  // When `agent` IS grouped the join stays INNER, and that is not an
  // inconsistency. There the join IS the attribution mechanism —
  // `s.agent_user_id` is the KEY — and an attempt with no session belongs to no
  // agent and therefore to no group. A LEFT join there would emit a `null`-keyed
  // row: a person-shaped group that is not a person, on a payload whose key is
  // documented as an agent id.
  //
  // ⚠️ So the two readings deliberately do NOT reconcile: an hour-grouped total
  // can exceed the sum of the agent-grouped rows over the same window, and the
  // difference is exactly the unreserved attempts. That is the same asymmetry
  // `inactive_omitted` documents in `agency-agent-identity.ts`, one layer down, and it is a
  // property of the QUESTION rather than a defect of the statement.
  //
  // ── Which is why the scope predicate now sits on the ATTEMPT ───────────────
  //
  // It read `s.tenant_id = $3 AND s.account_id = $4`, which cannot survive a LEFT
  // join: the NULL side fails it, so every unreserved attempt would be dropped by
  // the WHERE clause instead of by the join, and the fix above would be silently
  // undone. The scope is therefore a predicate on `a` — which is where it belongs
  // anyway. The attempt is the row being counted, `a.tenant_id`/`a.account_id` are
  // `NOT NULL`, and that is the column pair the billing sweep
  // scopes on. The session's own scope is not lost: it moves into the JOIN
  // condition, so a session in another account cannot attribute this account's
  // attempt under EITHER join word — it drops the row where `agent` is grouped,
  // exactly as before, and reads as unattributed where it is not.
  //
  // ── And the LEFT join costs nothing, which is checkable rather than assumed ─
  //
  // `s.id` is the primary key, so the join is at most one row per attempt: the
  // LEFT join cannot fan out and cannot double a counter, which matters here for
  // the same reason it does on the zone lateral. Better than that, `s` is not
  // SELECTED at all on the reads that take the LEFT join — `agent` is the only
  // dimension that reads it — so Postgres's join-removal rewrite drops the join
  // outright. Verified on this statement's real shape against Postgres 16: the
  // plan for an `hour_of_day` read contains no `agency_agent_sessions` node at
  // all. So the LEFT join is not a cost traded for correctness; it is free, and
  // keeping it (rather than emitting no session join at all) is what stops a
  // future dimension that reads `s` from meeting a `42P01` at runtime on a
  // statement that type-checks.
  //
  // One spelling of the ON clause, one varying word. The alternative — two whole
  // join clauses — is how the tenant predicate comes to be present on one of them.
  const sessionJoin = `${p.groupBy.includes('agent') ? 'JOIN' : 'LEFT JOIN'} agency_agent_sessions s ON s.id = a.reserved_agent_id
          AND s.tenant_id = $3
          AND s.account_id = $4`;

  // ── ONE CLIENT, ONE TRANSACTION, ONE SNAPSHOT ─────────────────────────────
  //
  // The two statements were issued in PARALLEL on the pool, which is two
  // connections and therefore two READ COMMITTED snapshots taken at two instants.
  // A `default_timezone` UPDATE committing between them is all it takes for the
  // zone this page REPORTS to differ from the zone its buckets were CUT in — the
  // one thing this field exists to rule out. Nor is it a hypothetical race over a
  // never-touched column: `default_timezone` is customer-facing config, and an
  // operator correcting a typo'd zone is PRECISELY the moment the two reads
  // disagree — which is also the moment the stored value and the resolved value
  // differ, i.e. the case the whole apparatus was built for.
  //
  // So both reads go on one client inside one `REPEATABLE READ` transaction. That
  // isolation level takes its snapshot at the FIRST statement and holds it for the
  // rest of the transaction, so the zone lookup necessarily reads the same
  // `agency_campaigns` row the grouped statement bucketed with, whatever commits
  // in between. `READ ONLY` is spelled out because both statements are reads and a
  // transaction that cannot write cannot be turned into one by a later edit.
  //
  // ⚠️ The grouped statement goes FIRST, and that is load-bearing twice: it is the
  // statement that TAKES the snapshot (so the zone can never be read from BEFORE
  // the buckets were cut), and every `sql()`/`params()` assertion in
  // `agent-grouped-repository.test.ts` reads the first non-control statement.
  //
  // The transaction is opened only when there IS a second statement to hold inside
  // it. A lone statement is one snapshot by construction, and wrapping it would
  // add a BEGIN and a COMMIT round trip to every contribution and trend read on
  // this surface — the ~all of them that report no zone — for a guarantee they
  // already have. Both branches issue the identical text with the identical
  // values, built once here, so they cannot drift in what they ASK; they differ
  // only in whether a companion read is held to the same snapshot.
  const groupedSql = `WITH grouped AS (
       SELECT ${innerSelect},
              ${AGENCY_ATTEMPT_METRICS_SQL}
         FROM agency_call_attempts a
         ${sessionJoin}
         JOIN agency_campaigns c ON c.id = a.campaign_id
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE a.tenant_id = $3
          AND a.account_id = $4
          AND a.dialed_at IS NOT NULL
          AND a.dialed_at >= $1
          AND a.dialed_at < $2${campaignFilter}
        GROUP BY ${groupOrdinals}
     )
     SELECT ${outerSelect},
            g.attempts, g.connected, g.successes, g.talk_seconds, g.wrapup_seconds,
            -- PRE-limit by construction: a window function is evaluated before
            -- LIMIT, so this counts the groups the CTE produced rather than the
            -- rows that survived the slice. A second COUNT(*) statement would be a
            -- second scan that could disagree with this one.
            COUNT(*) OVER ()::text AS total_groups
       FROM grouped g
      ORDER BY ${orderBy}
      LIMIT ${limitPlaceholder}`;

  let rows: AgencyGroupRawRow[];
  let resolvedTimezone: string | null = null;
  if (zoneCampaignId === undefined) {
    ({ rows } = await getPool().query<AgencyGroupRawRow>(groupedSql, bind.values));
  } else {
    // On a throw `withTransaction` rolls back, which here undoes nothing — the
    // transaction is READ ONLY — and only releases the snapshot.
    ({ rows, resolvedTimezone } = await withTransaction(async (client) => ({
      rows: (await client.query<AgencyGroupRawRow>(groupedSql, bind.values)).rows,
      resolvedTimezone: await resolvedCampaignZone(scope, zoneCampaignId, client),
    }), { pool: getPool(), isolation: 'REPEATABLE READ', readOnly: true }));
  }

  return {
    from: p.from.toISOString(),
    to: p.to.toISOString(),
    campaign_id: p.campaignId ?? null,
    // Echoed in CANONICAL order, which is the order the request was
    // canonicalised into rather than the order it was spelled in.
    group_by: [...p.groupBy],
    resolved_timezone: resolvedTimezone,
    sort: p.sort,
    order: p.order,
    limit: p.limit,
    // 0 on an empty result rather than from a nullish read: with no rows there is
    // no window-function value to carry the count, and "no groups" is exactly 0.
    total_groups: rows.length === 0 ? 0 : Number(rows[0]?.total_groups ?? 0),
    rows: rows.map((row) => groupRowFromSql(row, p.groupBy)),
  };
}

/**
 * ONE campaign's RESOLVED zone — the value `COALESCE(z.name, 'UTC')` produces,
 * not the value stored in the column.
 *
 * ── Reading the column back would BE the bug ────────────────────────────────
 *
 * `agency_campaigns.default_timezone` is `VARCHAR(64)` with no constraint,
 * populated from customer-facing config, and the join that resolves it is LEFT
 * (and LATERAL, and `LIMIT 1`) precisely so an unresolvable value cannot raise
 * `22023 invalid_parameter_value` and take out every other campaign's numbers in
 * the same statement. The consequence is that the stored value and the zone the
 * buckets were actually cut in differ **exactly when the stored value is
 * garbage** — so `SELECT c.default_timezone` here would hand a console
 * `Asia/Calcutta_typo` to print over columns that are in fact UTC, on precisely
 * the campaign whose zone is broken. This selects
 * {@link AGENCY_RESOLVED_ZONE_SQL} through {@link AGENCY_RESOLVED_ZONE_JOIN_SQL}
 * — the same two constants `groupedStats` cuts its buckets with, so the reported
 * zone and the zone used cannot drift.
 *
 * ── It takes the CLIENT, and the parameter is required for a reason ────────
 *
 * `client`, not `getPool()`. This statement and the grouped statement have to see
 * the SAME `agency_campaigns` row, and on the pool they would not: two
 * connections are two READ COMMITTED snapshots, so a `default_timezone` UPDATE
 * committing between them makes this method report a zone the buckets were never
 * cut in — the exact confusion the field exists to remove. The caller holds both
 * on one client in one `REPEATABLE READ` transaction; see `groupedStats`.
 *
 * Required rather than defaulted to the pool, and it is the only reason this
 * parameter is not optional: a default would let a future caller — or a
 * refactor of this one — reintroduce the two-snapshot read by omission, in
 * silence, on a method whose whole contract is that it agrees with a statement
 * somewhere else. A missing argument is a build error that names the call site.
 *
 * ── The scope is a predicate here too ──────────────────────────────────────
 *
 * `tenant_id` and `account_id`, not a bare primary-key lookup: `campaign_id`
 * arrives from the caller and a UUID from another account must not resolve to
 * that account's configuration, however small the leak. It also settles the
 * degenerate case honestly — a `campaign_id` naming no campaign IN SCOPE matches
 * no row, and `null` is then the right answer, because a filter that selected no
 * campaign did not select "exactly one" and the page it produced (necessarily
 * empty) was cut in no zone at all.
 *
 * A matched row can never yield SQL NULL: the COALESCE guarantees a value. So the
 * `?? null` maps ONLY "no such campaign in this account", and never a row whose
 * zone failed to resolve — that row returns `'UTC'`, which is what the buckets
 * actually used.
 */
async function resolvedCampaignZone(
  scope: { tenantId: string; accountId: string },
  campaignId: string,
  client: PoolClient,
): Promise<string | null> {
  const { rows } = await client.query<{ resolved_timezone: string }>(
    `SELECT ${AGENCY_RESOLVED_ZONE_SQL} AS resolved_timezone
         FROM agency_campaigns c
         ${AGENCY_RESOLVED_ZONE_JOIN_SQL}
        WHERE c.id = $1::uuid
          AND c.tenant_id = $2
          AND c.account_id = $3`,
    [campaignId, scope.tenantId, scope.accountId],
  );
  return rows[0]?.resolved_timezone ?? null;
}
