/**
 * The insights page's range reads over the rollup (migration 0012, `docs/insights.md`):
 * activity, trends, the abandonment trend, caller IDs, recording, carrier failures and the
 * rollup's freshness. Bodies of `AgencyInsightsRollupRepository`'s read methods.
 *
 * ── The range ───────────────────────────────────────────────────────────────
 * Every read takes a half-open `[from, to)` and sums the 15-minute buckets whose START is in
 * it (`bucket_start >= from AND bucket_start < to`). The rollup cannot cut inside a bucket, so a
 * caller passes bucket-aligned instants (`INSIGHTS_BUCKET_MINUTES`); an unaligned `from` drops
 * the partial bucket it falls in, an unaligned `to` includes the one it falls in. Lifetime is
 * `from` at or before the first dial's bucket.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The rollup tables carry no tenant. Every statement opens with `camp`, the campaign row
 * matched on id AND tenant, and joins every rollup table through it, so a caller that reached
 * this without the route's ownership probe still gets nothing for another tenant's campaign
 * (`null` from the reads that return an object).
 *
 * ── Codes are the caller's ──────────────────────────────────────────────────
 * `successCodes` (catalog entries with `is_success`) and `overrideCodes` (entries that grant an
 * override) are computed by the caller from the CURRENT catalog, so editing a catalog never
 * leaves the rollup stale: it stores conversations and dials per disposition code, and the
 * success count is a filter at read time. Same predicate as `successDispositionSql`: an
 * attempt's code naming a success entry.
 */
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { AgencyAttemptOutcome } from '@magick-agency/contracts/agency';
import type { AgencyInsightsBucket, AgencyInsightsReconciliation } from '@magick-agency/contracts/api/agency/insights';
import { ATTEMPT_OUTCOMES } from '../../../agency/spine-filters.js';
import { AUTO_DISPOSITION_CODE } from '../../../agency/disposition.js';
import { INSIGHTS_BUCKET_SQL_INTERVAL, INSIGHTS_MEASURE_COLUMNS } from './insights-rollup-sql.js';
import { VOICEMAIL_DISPOSITION_CODE } from './sql-fragments.js';

/** A campaign, its tenant, and a half-open range of bucket starts. */
export interface InsightsRangeQuery {
  campaignId: string;
  tenantId: string;
  from: Date;
  to: Date;
}

/** Every measure of a rollup row, as a number (durations in seconds). */
export interface InsightsMeasures {
  dials: number;
  /** `/stats` `attempts_connected`: outcome connected, not a wrap-up redial. */
  connected: number;
  /** One per conversation (`CONVERSATION_ATTEMPT_SQL`): the series' `connected`, the success denominator. */
  conversations: number;
  bridged: number;
  abandoned: number;
  /** Ended and carrier-answered: the abandonment rate's denominator. */
  answered: number;
  talk_seconds: number;
  wrapup_seconds: number;
  wrapup_measured: number;
  redials_placed: number;
  redials_connected: number;
  redial_chains_at_limit: number;
  reopened_dials: number;
  reopened_connected: number;
  manual_dials: number;
  manual_connected: number;
  overrides_used: number;
  recorded_connected: number;
  callbacks_booked: number;
}

export interface InsightsActivityAgentRow {
  /** Null for attempts with no reserved session. */
  agent_user_id: string | null;
  dials: number;
  connected: number;
  /** Conversations (the success rate's denominator). */
  conversations: number;
  successes: number;
  talk_seconds: number;
  wrapup_seconds: number;
  wrapup_measured: number;
  redials: number;
  /** Agent retries: reopened plus manual dials. */
  retries: number;
  overrides: number;
}

export interface InsightsActivityRollup {
  calls: {
    dials: number;
    connected: number;
    conversations: number;
    /** Conversations written up with a code that is neither voicemail nor the reaper's auto-stamp (`/stats` `human_connects`). */
    human_connects: number;
    successes: number;
    bridged: number;
    abandoned: number;
    answered: number;
    by_outcome: Record<AgencyAttemptOutcome, number> & { null_outcome: number };
    redials: { placed: number; connected: number; chains_at_limit: number };
    agent_retries: { reopened_dials: number; reopened_connected: number; manual_dials: number; manual_connected: number };
    talk_seconds: number;
    wrapup_seconds: number;
    wrapup_measured: number;
    /** Callbacks booked, at the booking dial's time. */
    callbacks_booked: number;
    recorded_connected: number;
  };
  /** Conversations by disposition code; `code: null` is a conversation closed without one. Largest first. */
  outcomes: Array<{ code: string | null; count: number }>;
  /** Per override-granting code (caller's list): attempts dispositioned with it, and dials that spent an override it granted. */
  overrides: Array<{
    code: string;
    granted: number;
    used: number;
    by_agent: Array<{ agent_user_id: string | null; granted: number; used: number }>;
  }>;
  /** Conversations closed with no outcome (code absent or the auto-stamp), by wrap-up resolution (`none` when unset). */
  no_outcome: { total: number; by_resolution: Record<string, number> };
  agents: InsightsActivityAgentRow[];
  /** Sums checked against their totals, from the same statement's numbers. */
  reconciliation: AgencyInsightsReconciliation[];
  as_of: string | null;
}

export interface InsightsTrendRow {
  /** ISO instant for `quarter_hour` / `hour`, `YYYY-MM-DD` in `timezone` for `day`. */
  bucket_start: string;
  dials: number;
  connected: number;
  conversations: number;
  successes: number;
  abandoned: number;
  answered: number;
}

export interface InsightsTrends {
  bucket: AgencyInsightsBucket;
  /** The zone the buckets were cut in: the requested one, or UTC when Postgres cannot resolve it. */
  timezone: string;
  buckets: InsightsTrendRow[];
  /** By the contact's local hour at dial time, 0–23, every hour present. */
  best_hours: Array<{ hour: number; dials: number; connected: number }>;
  as_of: string | null;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string).toISOString());

/** The microsecond columns are read back as seconds. */
const US_COLUMNS = new Set(['talk_us', 'wrapup_us']);
const SECONDS_NAME: Record<string, string> = { talk_us: 'talk_seconds', wrapup_us: 'wrapup_seconds' };

/** `SUM(r.col)::bigint AS col` for every measure, for a SELECT over rollup alias `r`. */
const sumOf = (columns: readonly string[]) => columns.map((c) => `COALESCE(SUM(r.${c}), 0) AS ${c}`).join(',\n                ');
const SUM_MEASURES = sumOf(INSIGHTS_MEASURE_COLUMNS);
/** The measures the per-agent rows read (the agents table is the largest the activity read sums). */
const AGENT_MEASURES = sumOf(['dials', 'connected', 'conversations', 'talk_us', 'wrapup_us', 'wrapup_measured', 'redials_placed',
  'reopened_dials', 'manual_dials', 'overrides_used']);

function readMeasures(row: Record<string, unknown> | null | undefined): InsightsMeasures {
  const out: Record<string, number> = {};
  for (const c of INSIGHTS_MEASURE_COLUMNS) {
    const value = num(row?.[c]);
    if (US_COLUMNS.has(c)) out[SECONDS_NAME[c]!] = value / 1_000_000;
    else out[c] = value;
  }
  return out as unknown as InsightsMeasures;
}

/** The campaign row, scoped: `$1` campaign, `$2` tenant. */
const CAMP_CTE = 'camp AS (SELECT c.id FROM agency_campaigns c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid)';
/** The range predicate on rollup alias `r`: `$3` from, `$4` to. */
const IN_RANGE = 'r.bucket_start >= $3::timestamptz AND r.bucket_start < $4::timestamptz';

function reconcile(check: string, expected: number, actual: number): AgencyInsightsReconciliation {
  return { check, expected, actual, ok: expected === actual };
}

/**
 * The activity section's rollup numbers at ONE snapshot: totals, by outcome, outcomes by code,
 * overrides, no-outcome, per agent, and the freshness. A `REPEATABLE READ` read-only transaction
 * of four statements rather than one statement of five subqueries: the snapshot is the same
 * (so a batch the job commits mid-read cannot make the agents disagree with the totals), and
 * each statement may use a parallel scan, which a CTE feeding a scalar subquery may not (on the
 * 1M-attempt seed the single statement read the two largest tables serially, ~2x slower).
 */
export async function insightsActivity(
  q: InsightsRangeQuery & { successCodes: readonly string[]; overrideCodes: readonly string[] },
): Promise<InsightsActivityRollup | null> {
  const p = [q.campaignId, q.from, q.to];
  const BY_CAMPAIGN = 'r.campaign_id = $1::uuid AND r.bucket_start >= $2::timestamptz AND r.bucket_start < $3::timestamptz';
  const read = await withTransaction(async (c) => {
    const head = await c.query<{ found: boolean; totals: Record<string, unknown> | null; as_of: string | null }>(
      `WITH ${CAMP_CTE},
         totals AS (
           SELECT ${SUM_MEASURES}
             FROM agency_insights_rollup_buckets r JOIN camp ON r.campaign_id = camp.id
            WHERE ${IN_RANGE}
         )
         SELECT EXISTS (SELECT 1 FROM camp) AS found,
                (SELECT row_to_json(t) FROM totals t) AS totals,
                (SELECT MAX(r.source_updated_at) FROM agency_insights_rollup_buckets r JOIN camp ON r.campaign_id = camp.id) AS as_of`,
      [q.campaignId, q.tenantId, q.from, q.to],
    );
    // The scope is checked once, in this snapshot; the reads below name the campaign directly.
    if (!head.rows[0]?.found) return null;
    const agents = await c.query<Record<string, unknown>>(
      `SELECT r.agent_user_id, ${AGENT_MEASURES}
         FROM agency_insights_rollup_agents r WHERE ${BY_CAMPAIGN}
        GROUP BY r.agent_user_id`, p);
    const codes = await c.query<{ agent_user_id: string | null; disposition_code: string | null; conversations: string; dials: string }>(
      `SELECT r.agent_user_id, r.disposition_code, SUM(r.conversations) AS conversations, SUM(r.dials) AS dials
         FROM agency_insights_rollup_codes r WHERE ${BY_CAMPAIGN}
        GROUP BY r.agent_user_id, r.disposition_code`, p);
    const facets = await c.query<{ facet: string; key: string | null; agent_user_id: string | null; n: string }>(
      `SELECT r.facet, r.key, r.agent_user_id, SUM(r.n) AS n
         FROM agency_insights_rollup_facets r
        WHERE r.campaign_id = $1::uuid AND r.facet IN ('outcome', 'no_outcome', 'override')
          AND r.bucket_start >= $2::timestamptz AND r.bucket_start < $3::timestamptz
        GROUP BY r.facet, r.key, r.agent_user_id`, p);
    return { ...head.rows[0], agents: agents.rows, codes: codes.rows, facets: facets.rows };
  }, { pool: getPool(), isolation: 'REPEATABLE READ', readOnly: true });
  if (!read) return null;
  const row = read;

  const totals = readMeasures(row.totals);
  const success = new Set(q.successCodes);
  const grant = new Set(q.overrideCodes);
  const codes = row.codes ?? [];
  const facets = row.facets ?? [];

  const byOutcome = Object.fromEntries(ATTEMPT_OUTCOMES.map((o) => [o, 0])) as Record<AgencyAttemptOutcome, number>;
  let nullOutcome = 0;
  for (const f of facets) {
    if (f.facet !== 'outcome') continue;
    if (f.key === null) nullOutcome += num(f.n);
    else if (Object.hasOwn(byOutcome, f.key)) byOutcome[f.key as AgencyAttemptOutcome] += num(f.n);
    // An outcome outside the vocabulary is dropped rather than invented as a key; the
    // outcomes_vs_dials check below then says the split does not add up.
  }

  const outcomeCounts = new Map<string | null, number>();
  const successesByAgent = new Map<string | null, number>();
  const grantedByCode = new Map<string, Map<string | null, number>>();
  let successes = 0;
  let humanConnects = 0;
  for (const c of codes) {
    const conversations = num(c.conversations);
    if (conversations > 0) outcomeCounts.set(c.disposition_code, (outcomeCounts.get(c.disposition_code) ?? 0) + conversations);
    if (c.disposition_code !== null && success.has(c.disposition_code)) {
      successes += conversations;
      successesByAgent.set(c.agent_user_id, (successesByAgent.get(c.agent_user_id) ?? 0) + conversations);
    }
    if (c.disposition_code !== null
      && c.disposition_code !== VOICEMAIL_DISPOSITION_CODE
      && c.disposition_code !== AUTO_DISPOSITION_CODE) humanConnects += conversations;
    if (c.disposition_code !== null && grant.has(c.disposition_code) && num(c.dials) > 0) {
      const perAgent = grantedByCode.get(c.disposition_code) ?? new Map<string | null, number>();
      perAgent.set(c.agent_user_id, (perAgent.get(c.agent_user_id) ?? 0) + num(c.dials));
      grantedByCode.set(c.disposition_code, perAgent);
    }
  }

  const usedByCode = new Map<string, Map<string | null, number>>();
  const overridesByAgent = new Map<string | null, number>();
  const noOutcome: Record<string, number> = {};
  let noOutcomeTotal = 0;
  for (const f of facets) {
    if (f.facet === 'no_outcome') {
      const key = f.key ?? 'none';
      noOutcome[key] = (noOutcome[key] ?? 0) + num(f.n);
      noOutcomeTotal += num(f.n);
    } else if (f.facet === 'override') {
      overridesByAgent.set(f.agent_user_id, (overridesByAgent.get(f.agent_user_id) ?? 0) + num(f.n));
      // A spent override whose granting code is not in the caller's list (an entry edited
      // since, or no earlier disposition found) is still counted per agent, not per code.
      if (f.key === null || !grant.has(f.key)) continue;
      const perAgent = usedByCode.get(f.key) ?? new Map<string | null, number>();
      perAgent.set(f.agent_user_id, (perAgent.get(f.agent_user_id) ?? 0) + num(f.n));
      usedByCode.set(f.key, perAgent);
    }
  }

  const overrides = [...grant].sort().map((code) => {
    const granted = grantedByCode.get(code) ?? new Map<string | null, number>();
    const used = usedByCode.get(code) ?? new Map<string | null, number>();
    const agentIds = [...new Set([...granted.keys(), ...used.keys()])];
    const byAgent = agentIds.map((agent_user_id) => ({
      agent_user_id, granted: granted.get(agent_user_id) ?? 0, used: used.get(agent_user_id) ?? 0,
    })).sort((a, b) => (b.granted + b.used) - (a.granted + a.used) || String(a.agent_user_id).localeCompare(String(b.agent_user_id)));
    return {
      code,
      granted: byAgent.reduce((s, r) => s + r.granted, 0),
      used: byAgent.reduce((s, r) => s + r.used, 0),
      by_agent: byAgent,
    };
  });

  const agents: InsightsActivityAgentRow[] = (row.agents ?? []).map((a) => {
    const m = readMeasures(a);
    const agentUserId = (a['agent_user_id'] as string | null) ?? null;
    return {
      agent_user_id: agentUserId,
      dials: m.dials,
      connected: m.connected,
      conversations: m.conversations,
      successes: successesByAgent.get(agentUserId) ?? 0,
      talk_seconds: m.talk_seconds,
      wrapup_seconds: m.wrapup_seconds,
      wrapup_measured: m.wrapup_measured,
      redials: m.redials_placed,
      retries: m.reopened_dials + m.manual_dials,
      overrides: m.overrides_used,
    };
  }).sort((a, b) => b.dials - a.dials || String(a.agent_user_id).localeCompare(String(b.agent_user_id)));

  const outcomes = [...outcomeCounts].map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || String(a.code).localeCompare(String(b.code)));

  const sum = (xs: number[]): number => xs.reduce((s, x) => s + x, 0);
  const reconciliation = [
    reconcile('outcomes_vs_dials', totals.dials, sum(Object.values(byOutcome)) + nullOutcome),
    reconcile('agents_dials_vs_dials', totals.dials, sum(agents.map((a) => a.dials))),
    reconcile('agents_connected_vs_connected', totals.connected, sum(agents.map((a) => a.connected))),
    reconcile('outcome_codes_vs_conversations', totals.conversations, sum(outcomes.map((o) => o.count))),
    reconcile('agents_overrides_vs_overrides_used', totals.overrides_used, sum([...overridesByAgent.values()])),
    reconcile('no_outcome_vs_unclassified_codes', (outcomeCounts.get(null) ?? 0) + (outcomeCounts.get(AUTO_DISPOSITION_CODE) ?? 0), noOutcomeTotal),
  ];

  return {
    calls: {
      dials: totals.dials,
      connected: totals.connected,
      conversations: totals.conversations,
      human_connects: humanConnects,
      successes,
      bridged: totals.bridged,
      abandoned: totals.abandoned,
      answered: totals.answered,
      by_outcome: { ...byOutcome, null_outcome: nullOutcome },
      redials: {
        placed: totals.redials_placed,
        connected: totals.redials_connected,
        chains_at_limit: totals.redial_chains_at_limit,
      },
      agent_retries: {
        reopened_dials: totals.reopened_dials,
        reopened_connected: totals.reopened_connected,
        manual_dials: totals.manual_dials,
        manual_connected: totals.manual_connected,
      },
      talk_seconds: totals.talk_seconds,
      wrapup_seconds: totals.wrapup_seconds,
      wrapup_measured: totals.wrapup_measured,
      callbacks_booked: totals.callbacks_booked,
      recorded_connected: totals.recorded_connected,
    },
    outcomes,
    overrides,
    no_outcome: { total: noOutcomeTotal, by_resolution: noOutcome },
    agents,
    reconciliation,
    as_of: iso(row.as_of),
  };
}

// ── Trend buckets ────────────────────────────────────────────────────────────

/**
 * A trend bucket's LABEL for the instant `ts`, as text: an ISO instant (`.000Z`, as
 * `Date#toISOString` prints it) for `quarter_hour` and `hour`, a `YYYY-MM-DD` local date for
 * `day`. `hour` and `day` are cut in `zone` (`date_trunc` with a zone, PG 12+, is DST-aware).
 * Text so the three widths order and join the same way.
 */
export function trendLabelSql(bucket: AgencyInsightsBucket, ts: string, zone: string): string {
  const isoText = (instant: string) => `to_char((${instant}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
  switch (bucket) {
    case 'quarter_hour': return isoText(`agency_insights_bucket(${ts})`);
    case 'hour': return isoText(`date_trunc('hour', ${ts}, ${zone})`);
    case 'day': return `to_char((${ts}) AT TIME ZONE ${zone}, 'YYYY-MM-DD')`;
  }
}

/**
 * The START INSTANT of every trend bucket that overlaps `[fromExpr, toExpr)`, as a FROM item
 * yielding `b`. Generated in the bucket's own arithmetic (absolute quarter hours; absolute hours
 * from a zone-truncated start, so a :30 or :45 zone's hours stay on their boundaries; local
 * calendar days, each local midnight converted back to its instant), and the upper bound is
 * `to - 1 microsecond`, the greatest instant inside a half-open range, so a `to` on a boundary
 * adds no empty bucket. Each `b` labels (`trendLabelSql`) as its own bucket.
 */
export function trendBoundariesSql(bucket: AgencyInsightsBucket, fromExpr: string, toExpr: string, zone: string): string {
  const last = `((${toExpr}) - interval '1 microsecond')`;
  switch (bucket) {
    case 'quarter_hour':
      return `(SELECT gs AS b
                 FROM generate_series(agency_insights_bucket(${fromExpr}), agency_insights_bucket(${last}), ${INSIGHTS_BUCKET_SQL_INTERVAL}) gs)`;
    case 'hour':
      return `(SELECT gs AS b
                 FROM generate_series(date_trunc('hour', ${fromExpr}, ${zone}), date_trunc('hour', ${last}, ${zone}), interval '1 hour') gs)`;
    case 'day':
      return `(SELECT (gs::date::timestamp AT TIME ZONE ${zone}) AS b
                 FROM generate_series(((${fromExpr}) AT TIME ZONE ${zone})::date, (${last} AT TIME ZONE ${zone})::date, interval '1 day') gs)`;
  }
}

/** The labels of the buckets of {@link trendBoundariesSql}, as a FROM item yielding `label`: the zero-filled spine. */
export function trendSpineSql(bucket: AgencyInsightsBucket, fromExpr: string, toExpr: string, zone: string): string {
  return `(SELECT ${trendLabelSql(bucket, 'x.b', zone)} AS label FROM ${trendBoundariesSql(bucket, fromExpr, toExpr, zone)} x)`;
}

/** `$n` resolved like `AGENCY_RESOLVED_ZONE_SQL`: a name Postgres knows, else UTC. */
export function resolvedZoneCte(param: string): string {
  return `tz AS (SELECT COALESCE((SELECT z.name FROM pg_timezone_names z WHERE lower(z.name) = lower(${param}) LIMIT 1), 'UTC') AS zone)`;
}

/**
 * The trend series: every bucket of the range, zero-filled, plus the best hours. `hour` and
 * `day` are cut in `timezone` (the campaign's), `best_hours` in each contact's own zone (the
 * rollup's `local_hour`). The spine and the data are joined on their labels with the data's
 * labels UNIONed in, so a bucket the spine's arithmetic missed (a DST edge) still carries its
 * counts rather than dropping them.
 */
export async function insightsTrends(
  q: InsightsRangeQuery & { bucket: AgencyInsightsBucket; timezone: string; successCodes: readonly string[] },
): Promise<InsightsTrends | null> {
  const label = trendLabelSql(q.bucket, 'r.bucket_start', 'tz.zone');
  const { rows } = await getPool().query<{
    found: boolean; zone: string; series: Array<Record<string, unknown>> | null;
    hours: Array<{ hour: string; dials: number; connected: number }> | null; as_of: string | null;
  }>(
    `WITH ${CAMP_CTE}, ${resolvedZoneCte('$5::text')},
       agg AS (
         SELECT ${label} AS label,
                SUM(r.dials) AS dials, SUM(r.connected) AS connected, SUM(r.conversations) AS conversations,
                SUM(r.abandoned) AS abandoned, SUM(r.answered) AS answered
           FROM agency_insights_rollup_buckets r JOIN camp ON r.campaign_id = camp.id, tz
          WHERE ${IN_RANGE}
          GROUP BY 1
       ), suc AS (
         SELECT ${label} AS label, SUM(r.conversations) AS successes
           FROM agency_insights_rollup_codes r JOIN camp ON r.campaign_id = camp.id, tz
          WHERE ${IN_RANGE} AND r.disposition_code = ANY($6::text[])
          GROUP BY 1
       ), labels AS (
         SELECT s.label FROM tz, LATERAL ${trendSpineSql(q.bucket, '$3::timestamptz', '$4::timestamptz', 'tz.zone')} s
         UNION
         SELECT label FROM agg
       ), series AS (
         SELECT l.label AS bucket_start,
                COALESCE(agg.dials, 0) AS dials, COALESCE(agg.connected, 0) AS connected,
                COALESCE(agg.conversations, 0) AS conversations, COALESCE(suc.successes, 0) AS successes,
                COALESCE(agg.abandoned, 0) AS abandoned, COALESCE(agg.answered, 0) AS answered
           FROM labels l
           LEFT JOIN agg ON agg.label = l.label
           LEFT JOIN suc ON suc.label = l.label
          ORDER BY l.label
       ), hours AS (
         SELECT r.key AS hour, SUM(r.n) AS dials, SUM(r.connected) AS connected
           FROM agency_insights_rollup_facets r JOIN camp ON r.campaign_id = camp.id
          WHERE r.facet = 'local_hour' AND ${IN_RANGE}
          GROUP BY r.key
       )
       SELECT EXISTS (SELECT 1 FROM camp) AS found,
              (SELECT zone FROM tz) AS zone,
              (SELECT json_agg(s ORDER BY s.bucket_start) FROM series s) AS series,
              (SELECT json_agg(h) FROM hours h) AS hours,
              (SELECT MAX(r.source_updated_at) FROM agency_insights_rollup_buckets r JOIN camp ON r.campaign_id = camp.id) AS as_of`,
    [q.campaignId, q.tenantId, q.from, q.to, q.timezone, [...q.successCodes]],
  );
  const row = rows[0];
  if (!row?.found) return null;
  const byHour = new Map((row.hours ?? []).map((h) => [Number(h.hour), h]));
  return {
    bucket: q.bucket,
    timezone: row.zone,
    buckets: (row.series ?? []).map((s) => ({
      bucket_start: String(s['bucket_start']),
      dials: num(s['dials']),
      connected: num(s['connected']),
      conversations: num(s['conversations']),
      successes: num(s['successes']),
      abandoned: num(s['abandoned']),
      answered: num(s['answered']),
    })),
    best_hours: Array.from({ length: 24 }, (_, hour) => ({
      hour, dials: num(byHour.get(hour)?.dials), connected: num(byHour.get(hour)?.connected),
    })),
    as_of: iso(row.as_of),
  };
}

/** Abandoned and answered per trend bucket (the health section's line): the trend read's columns. */
export async function insightsAbandonmentTrend(
  q: InsightsRangeQuery & { bucket: AgencyInsightsBucket; timezone: string },
): Promise<{ timezone: string; buckets: Array<{ bucket_start: string; abandoned: number; answered: number }>; as_of: string | null } | null> {
  const trends = await insightsTrends({ ...q, successCodes: [] });
  if (!trends) return null;
  return {
    timezone: trends.timezone,
    buckets: trends.buckets.map((b) => ({ bucket_start: b.bucket_start, abandoned: b.abandoned, answered: b.answered })),
    as_of: trends.as_of,
  };
}

/** Dials and connected per caller ID, most dials first. */
export async function insightsCallerIds(
  q: InsightsRangeQuery,
): Promise<Array<{ caller_id: string; dials: number; connected: number }> | null> {
  const { rows } = await getPool().query<{ found: boolean; ids: Array<{ caller_id: string; dials: number; connected: number }> | null }>(
    `WITH ${CAMP_CTE},
       ids AS (
         SELECT r.key AS caller_id, SUM(r.n) AS dials, SUM(r.connected) AS connected
           FROM agency_insights_rollup_facets r JOIN camp ON r.campaign_id = camp.id
          WHERE r.facet = 'caller_id' AND ${IN_RANGE}
          GROUP BY r.key
       )
       SELECT EXISTS (SELECT 1 FROM camp) AS found,
              (SELECT json_agg(i ORDER BY i.dials DESC, i.caller_id) FROM ids i) AS ids`,
    [q.campaignId, q.tenantId, q.from, q.to],
  );
  if (!rows[0]?.found) return null;
  return (rows[0].ids ?? []).map((i) => ({ caller_id: i.caller_id, dials: num(i.dials), connected: num(i.connected) }));
}

/** Connected calls (as `connected`) and those whose call carries a recording. */
export async function insightsRecording(q: InsightsRangeQuery): Promise<{ connected: number; recorded: number } | null> {
  const totals = await bucketTotals(q);
  return totals && { connected: totals.connected, recorded: totals.recorded_connected };
}

/** Placed dials whose outcome is `failed` (the carrier's). */
export async function insightsCarrierFailures(q: InsightsRangeQuery): Promise<number | null> {
  const { rows } = await getPool().query<{ found: boolean; n: string }>(
    `WITH ${CAMP_CTE}
     SELECT EXISTS (SELECT 1 FROM camp) AS found,
            (SELECT COALESCE(SUM(r.n), 0) FROM agency_insights_rollup_facets r JOIN camp ON r.campaign_id = camp.id
              WHERE r.facet = 'outcome' AND r.key = 'failed' AND ${IN_RANGE})::text AS n`,
    [q.campaignId, q.tenantId, q.from, q.to],
  );
  return rows[0]?.found ? Number(rows[0].n) : null;
}

/** The bucket totals over a range (every measure). */
export async function bucketTotals(q: InsightsRangeQuery): Promise<InsightsMeasures | null> {
  const { rows } = await getPool().query<{ found: boolean; totals: Record<string, unknown> | null }>(
    `WITH ${CAMP_CTE},
       totals AS (
         SELECT ${SUM_MEASURES}
           FROM agency_insights_rollup_buckets r JOIN camp ON r.campaign_id = camp.id
          WHERE ${IN_RANGE}
       )
       SELECT EXISTS (SELECT 1 FROM camp) AS found, (SELECT row_to_json(t) FROM totals t) AS totals`,
    [q.campaignId, q.tenantId, q.from, q.to],
  );
  return rows[0]?.found ? readMeasures(rows[0].totals) : null;
}

/**
 * The rollup's freshness: the newest attempt `updated_at` folded into any of the campaign's
 * buckets, or null when the campaign has no rollup rows. `pending_buckets` is how many of its
 * buckets are marked and not yet recomputed (0 when the rollup is caught up), so the page can
 * say "updating" rather than only "as of".
 */
export async function insightsAsOf(
  q: { campaignId: string; tenantId: string },
): Promise<{ as_of: string | null; pending_buckets: number } | null> {
  const { rows } = await getPool().query<{ found: boolean; as_of: string | null; pending: number }>(
    `WITH camp AS (SELECT c.id FROM agency_campaigns c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid)
     SELECT EXISTS (SELECT 1 FROM camp) AS found,
            (SELECT MAX(r.source_updated_at) FROM agency_insights_rollup_buckets r JOIN camp ON r.campaign_id = camp.id) AS as_of,
            (SELECT count(DISTINCT d.bucket_start) FROM agency_insights_rollup_dirty d JOIN camp ON d.campaign_id = camp.id)::int AS pending`,
    [q.campaignId, q.tenantId],
  );
  const row = rows[0];
  if (!row?.found) return null;
  return { as_of: iso(row.as_of), pending_buckets: num(row.pending) };
}
