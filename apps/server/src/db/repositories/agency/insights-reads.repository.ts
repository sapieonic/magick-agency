/**
 * The campaign insights page's as-of-now reads (docs/insights.md "API"): the roster buckets, the
 * dial pace, the contacts on DNC, the allocation per owner and its attempt counters, and the
 * upload history. The route layer (`src/agency/insights/`) assembles the wire shapes from these.
 *
 * ── One statement per section ───────────────────────────────────────────────
 * Each `reconciliation` block on the wire is checked against counts that came out of ONE
 * statement, so every count in it is cut at the same instant (`now()` is the statement's).
 *
 * ── Plans (1M-contact campaigns) ────────────────────────────────────────────
 *  - {@link rosterStatement} and {@link allocationStatement} read only the columns of
 *    `idx_agency_contacts_insights` (`insights-sql.ts`): an Index Only Scan of the campaign, or
 *    the parallel seq scan the planner prefers when the campaign is most of the table (0011's
 *    BASELINE notes: ~280 ms either way at 1M). They are the one whole-campaign read the summary
 *    and allocation make; the route caches their answers for a few seconds (`insights/cache.ts`).
 *  - {@link dialPaceStatement}: the last hour of the campaign's dials on
 *    `idx_agency_attempts_campaign_dialed`, each joined to its contact by primary key.
 *  - {@link contactsOnDncStatement}: the campaign's `pending` contacts semi-joined to the DNC
 *    entries in scope; the planner drives from whichever side is smaller, each probe indexed
 *    (`idx_agency_contacts_phone` / `idx_dnc_entries_tenant_phone`).
 *  - {@link allocationCountersStatement}: the campaign's rows of `agency_insights_rollup_agents`
 *    (a lifetime is one campaign prefix of its unique index), plus one 15-minute range of
 *    `idx_agency_attempts_campaign_dialed` per agent for `last_activity_at`. Never the whole
 *    attempt table (it replaced a read of every attempt: 1.1 s at 1M).
 *  - The range reads' extras: {@link softphoneCallsStatement} (`idx_agency_manual_calls_campaign`),
 *    {@link dncMarkedStatement} (`idx_dnc_entries_tenant_created`), {@link abandonmentWindowStatement}
 *    (a day of `idx_agency_attempts_campaign_dialed`).
 *  - {@link listUploads}: `idx_agency_ingest_jobs_campaign`.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyMyContactBucket } from '@magick-agency/contracts/api/agency/assignment';
import { contactBucketSql, openContactSql } from './assignment-sql.js';
import {
  attemptedSql,
  pendingCallbackSql,
  rosterBucketPredicates,
  ROSTER_BUCKETS,
  suppressedDncSql,
  waitingDueNowSql,
  waitingRetrySql,
  waitingSql,
  type RosterBucket,
} from './insights-sql.js';
import { neverSeededSuppressionSql, params, retrySelectionConditions } from './query-builders.js';
import { INSIGHTS_BUCKET_SQL_INTERVAL } from './insights-rollup-sql.js';
import type { AgencyRetrySelector } from '@magick-agency/contracts/agency';
import { ABANDONED_ATTEMPT_PREDICATE_SQL, ABANDONMENT_WINDOW_HOURS } from '@magick-agency/domain/abandonment-predicate';

/** A statement and its values, exported so a test can `EXPLAIN` exactly what runs. */
export interface InsightsStatement {
  text: string;
  values: unknown[];
}

// ─── Roster ─────────────────────────────────────────────────────────────────

export interface RosterCountsInput {
  campaignId: string;
  /** `callbackCodes(campaign.disposition_catalog)`. */
  callbackCodes: string[];
  /** The catalog's `is_success` codes. */
  successCodes: string[];
  /** The current pause's start: callbacks that fell due in `[pausedAt, now)`. Null: none counted. */
  pausedAt: Date | null;
  /** Today's calling window end: callbacks due in `[now, windowEndAt)`. Null: none counted. */
  windowEndAt: Date | null;
}

export interface RosterCounts {
  total: number;
  buckets: Record<RosterBucket, number>;
  attempted: number;
  attempts: { one: number; two: number; three: number; four_plus: number };
  dials_placed: number;
  /** Pending: the three waiting buckets' sum, counted on its own. */
  pending: number;
  /** Pending callbacks, due or not. */
  pending_callbacks: number;
  /** The owner's `not_reached` bucket (`contactBucketSql`). */
  not_reached: number;
  /** Latest disposition is a success code. */
  successes: number;
  callbacks_missed_while_paused: number;
  callbacks_due_before_window_end: number;
  /** Open contacts nobody owns. */
  unassigned_open: number;
}

/** The roster's one statement (exported for its plan test). */
export function rosterStatement(input: RosterCountsInput): InsightsStatement {
  const bind = params();
  const id = bind.add(input.campaignId);
  const codes = bind.add(input.callbackCodes);
  const success = bind.add(input.successCodes);
  const pausedAt = bind.add(input.pausedAt);
  const windowEnd = bind.add(input.windowEndAt);
  const buckets = rosterBucketPredicates('c', codes);
  const callback = pendingCallbackSql('c', codes);
  const text = `
    SELECT count(*)::int AS total,
           ${ROSTER_BUCKETS.map((b) => `(count(*) FILTER (WHERE ${buckets[b]}))::int AS ${b}`).join(',\n           ')},
           (count(*) FILTER (WHERE ${attemptedSql('c')}))::int AS attempted,
           (count(*) FILTER (WHERE c.dials_placed = 1))::int AS one,
           (count(*) FILTER (WHERE c.dials_placed = 2))::int AS two,
           (count(*) FILTER (WHERE c.dials_placed = 3))::int AS three,
           (count(*) FILTER (WHERE c.dials_placed >= 4))::int AS four_plus,
           COALESCE(sum(c.dials_placed), 0)::bigint AS dials_placed,
           (count(*) FILTER (WHERE ${waitingSql('c')}))::int AS pending,
           (count(*) FILTER (WHERE ${callback}))::int AS pending_callbacks,
           (count(*) FILTER (WHERE ${contactBucketSql('c', codes)} = 'not_reached'))::int AS not_reached,
           (count(*) FILTER (WHERE c.last_disposition = ANY(${success}::text[])))::int AS successes,
           (count(*) FILTER (WHERE ${callback} AND c.next_attempt_at >= ${pausedAt}::timestamptz
                               AND c.next_attempt_at < now()))::int AS callbacks_missed_while_paused,
           (count(*) FILTER (WHERE ${callback} AND c.next_attempt_at >= now()
                               AND c.next_attempt_at < ${windowEnd}::timestamptz))::int AS callbacks_due_before_window_end,
           (count(*) FILTER (WHERE ${openContactSql('c')} AND c.assigned_user_id IS NULL))::int AS unassigned_open
      FROM agency_contacts c
     WHERE c.campaign_id = ${id}::uuid`;
  return { text, values: bind.values };
}

// ─── Allocation ─────────────────────────────────────────────────────────────

export interface AllocationCountsInput {
  campaignId: string;
  callbackCodes: string[];
  successCodes: string[];
  /** Midnight ending today in the campaign's zone: "callbacks due today" is `[now, dayEnd)`. */
  dayEndAt: Date;
}

/** One owner's (or the pool's, `uid: null`) contacts. */
export interface OwnerCounts {
  uid: string | null;
  allocated: number;
  attempted: number;
  due_now: number;
  waiting_retry: number;
  callbacks_due_today: number;
  callbacks_overdue: number;
  reached: number;
  not_reached: number;
  exhausted: number;
  successes: number;
  dnc: number;
  /** Open (pending, not DNC): nothing left to work when 0. */
  open: number;
  /** The roster partition per owner, summed: must equal `allocated`. */
  partition_sum: number;
}

/** The allocation's one statement (exported for its plan test). */
export function allocationStatement(input: AllocationCountsInput): InsightsStatement {
  const bind = params();
  const id = bind.add(input.campaignId);
  const codes = bind.add(input.callbackCodes);
  const success = bind.add(input.successCodes);
  const dayEnd = bind.add(input.dayEndAt);
  const bucket = (b: AgencyMyContactBucket) => `${contactBucketSql('c', codes)} = '${b}'`;
  const buckets = rosterBucketPredicates('c', codes);
  const callback = pendingCallbackSql('c', codes);
  const text = `
    SELECT c.assigned_user_id::text AS uid,
           count(*)::int AS allocated,
           (count(*) FILTER (WHERE ${attemptedSql('c')}))::int AS attempted,
           (count(*) FILTER (WHERE ${waitingDueNowSql('c')}))::int AS due_now,
           (count(*) FILTER (WHERE ${waitingRetrySql('c', codes)}))::int AS waiting_retry,
           (count(*) FILTER (WHERE ${callback} AND c.next_attempt_at >= now()
                               AND c.next_attempt_at < ${dayEnd}::timestamptz))::int AS callbacks_due_today,
           (count(*) FILTER (WHERE ${callback} AND c.next_attempt_at < now()))::int AS callbacks_overdue,
           (count(*) FILTER (WHERE ${bucket('reached')}))::int AS reached,
           (count(*) FILTER (WHERE ${bucket('not_reached')}))::int AS not_reached,
           (count(*) FILTER (WHERE ${bucket('exhausted')}))::int AS exhausted,
           (count(*) FILTER (WHERE c.last_disposition = ANY(${success}::text[])))::int AS successes,
           -- The roster's rule (suppressedDncSql): suppressed FOR DNC. A pending row frozen DNC
           -- before the claim refused it is still waiting (the roster counts it there), and the
           -- allocation's dnc link lists state=suppressed&suppressed_reason=dnc.
           (count(*) FILTER (WHERE ${suppressedDncSql('c')}))::int AS dnc,
           (count(*) FILTER (WHERE ${openContactSql('c')}))::int AS open,
           (${ROSTER_BUCKETS.map((b) => `count(*) FILTER (WHERE ${buckets[b]})`).join('\n            + ')})::int AS partition_sum
      FROM agency_contacts c
     WHERE c.campaign_id = ${id}::uuid
     GROUP BY 1`;
  return { text, values: bind.values };
}

/** Per agent who dialled (null: dials with no reserved session): the allocation's dial counters. */
export interface OwnerAttemptCounters {
  redials: number;
  retries_reopened: number;
  retries_manual: number;
  overrides_used: number;
  last_activity_at: Date | null;
}

/**
 * The allocation's dial counters over the campaign's lifetime, per agent, from the rollup's
 * per-agent rows (`agency_insights_rollup_agents`, migration 0012), never the attempt table:
 * placed wrap-up redials, placed agent reopens, placed hand dials, placed dials that spent an
 * override. Attributed to the agent who PLACED the dial (the reserved session's user), as the
 * rollup attributes every measure and as the Call attempts list's `agent_user_id` filter selects
 * (`attemptAgentUserSql`), so a per-agent number and the list it opens are one set.
 *
 * `last_activity_at`: the agent's newest placed dial, found in two indexed steps: the newest
 * bucket the rollup holds for the agent (read in the same scan as the sums), then the newest
 * `dialed_at` among the campaign's dials in that one 15-minute bucket
 * (`idx_agency_attempts_campaign_dialed`, a bucket's worth of rows) whose session is the agent's
 * (joined by primary key). Exact to the dial, as fresh as the rollup (a dial in a bucket the job
 * has not recomputed yet shows when it has, seconds later). Exported for its plan test.
 */
export function allocationCountersStatement(campaignId: string): InsightsStatement {
  return {
    text: `
      WITH per_agent AS (
        SELECT r.agent_user_id AS uid,
               COALESCE(SUM(r.redials_placed), 0)::int AS redials,
               COALESCE(SUM(r.reopened_dials), 0)::int AS reopened,
               COALESCE(SUM(r.manual_dials), 0)::int AS manual,
               COALESCE(SUM(r.overrides_used), 0)::int AS overrides,
               MAX(r.bucket_start) FILTER (WHERE r.dials > 0) AS newest
          FROM agency_insights_rollup_agents r
         WHERE r.campaign_id = $1::uuid
         GROUP BY r.agent_user_id
      )
      SELECT p.uid::text AS uid, p.redials, p.reopened, p.manual, p.overrides,
             -- ORDER BY … LIMIT 1 rather than max(): the shape of the index's own order, so the
             -- planner walks idx_agency_attempts_campaign_dialed backwards from the bucket's end
             -- and stops at the agent's newest dial.
             (SELECT a.dialed_at
                FROM agency_call_attempts a
                LEFT JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
               WHERE a.campaign_id = $1::uuid
                 AND a.dialed_at IS NOT NULL
                 AND a.dialed_at >= p.newest
                 AND a.dialed_at < p.newest + ${INSIGHTS_BUCKET_SQL_INTERVAL}
                 AND s.agent_user_id IS NOT DISTINCT FROM p.uid
               ORDER BY a.dialed_at DESC
               LIMIT 1) AS last
        FROM per_agent p`,
    values: [campaignId],
  };
}

// ─── Range reads that are neither the rollup nor the pacing history ────────

/**
 * Soft-phone calls tagged to the campaign and PLACED (`dialed_at` set), created in `[from, to)`:
 * a range of `idx_agency_manual_calls_campaign (campaign_id, created_at DESC) WHERE campaign_id IS
 * NOT NULL`. On `created_at` because that is the column the tag's index orders (a call is placed
 * seconds after it is created); tenant-checked because the tag carries no foreign key.
 */
export function softphoneCallsStatement(q: { campaignId: string; tenantId: string; from: Date; to: Date }): InsightsStatement {
  return {
    text: `
      SELECT count(*)::int AS n
        FROM agency_manual_calls m
       WHERE m.campaign_id = $1::uuid
         AND m.created_at >= $2::timestamptz AND m.created_at < $3::timestamptz
         AND m.tenant_id = $4::uuid
         AND m.dialed_at IS NOT NULL`,
    values: [q.campaignId, q.from, q.to, q.tenantId],
  };
}

/**
 * Do Not Call entries agents wrote SCOPED TO THIS CAMPAIGN in `[from, to)`, by who wrote them
 * (`added_by`). A range of the tenant's entries on `idx_dnc_entries_tenant_created (tenant_id,
 * created_at DESC)`: it reads the tenant's entries of the range (imports included) and keeps the
 * campaign's agent marks, so its cost is the tenant's DNC writes in the range, not the campaign's
 * size. An agent's tenant-wide escalation names no campaign and is not counted here.
 */
export function dncMarkedStatement(q: { campaignId: string; tenantId: string; from: Date; to: Date }): InsightsStatement {
  return {
    text: `
      SELECT d.added_by, count(*)::int AS n
        FROM dnc_entries d
       WHERE d.tenant_id = $1::uuid
         AND d.created_at >= $2::timestamptz AND d.created_at < $3::timestamptz
         AND d.campaign_id = $4::uuid
         AND d.source = 'agent'
       GROUP BY d.added_by`,
    values: [q.tenantId, q.from, q.to, q.campaignId],
  };
}

/**
 * How far before its answer an answered attempt can have been dialled, at most. A call rings for
 * seconds (the carrier's ring timeout, then the reaper's orphan sweep); an hour is a bound no
 * attempt reaches, and it lets the window be a range of the campaign's dials.
 */
export const ANSWER_AFTER_DIAL_MAX_HOURS = 1;

/**
 * The abandonment guardrail's window for ONE campaign (`AgencyAbandonmentRepository.window24h`'s
 * predicate: ended, answered in the last `ABANDONMENT_WINDOW_HOURS`, and the abandoned among
 * them), read as a range of the campaign's dials on `idx_agency_attempts_campaign_dialed` (dialled
 * within the window plus {@link ANSWER_AFTER_DIAL_MAX_HOURS}), so it reads a day of one
 * campaign, not the fleet's day on the global `answered_at` index.
 */
export function abandonmentWindowStatement(campaignId: string): InsightsStatement {
  return {
    text: `
      SELECT (count(*))::int AS answered,
             (count(*) FILTER (WHERE ${ABANDONED_ATTEMPT_PREDICATE_SQL}))::int AS abandoned
        FROM agency_call_attempts
       WHERE campaign_id = $1::uuid
         AND dialed_at IS NOT NULL
         AND dialed_at > now() - make_interval(hours => $2::int + ${ANSWER_AFTER_DIAL_MAX_HOURS})
         AND state = 'ended'
         AND answered_at IS NOT NULL
         AND answered_at > now() - make_interval(hours => $2::int)`,
    values: [campaignId, ABANDONMENT_WINDOW_HOURS],
  };
}

// ─── Headline ───────────────────────────────────────────────────────────────

export interface DialPace {
  /** Dials placed in the last 15 minutes. */
  dials_15m: number;
  /** Contacts dialled in the last hour that are now finished (completed, exhausted, suppressed). */
  finished_1h: number;
}

/** The running headline's pace (exported for its plan test). */
export function dialPaceStatement(campaignId: string): InsightsStatement {
  return {
    text: `
      SELECT (count(*) FILTER (WHERE a.dialed_at > now() - interval '15 minutes'))::int AS dials_15m,
             (count(DISTINCT a.contact_id) FILTER (WHERE c.state IN ('completed', 'exhausted', 'suppressed')))::int AS finished_1h
        FROM agency_call_attempts a
        JOIN agency_contacts c ON c.id = a.contact_id
       WHERE a.campaign_id = $1::uuid
         AND a.dialed_at IS NOT NULL
         AND a.dialed_at > now() - interval '1 hour'`,
    values: [campaignId],
  };
}

// ─── Readiness ──────────────────────────────────────────────────────────────

export interface DncScope {
  campaignId: string;
  tenantId: string;
  accountId: string;
}

/**
 * The campaign's `pending` contacts whose number is on a DNC entry in scope for it: tenant-wide,
 * the campaign's account, or the campaign itself. The predicate is `DncRepository.findSuppressed`'s
 * (the pre-dial gate's): exact `phone_e164` equality within the tenant, `account_id` NULL or the
 * campaign's, `campaign_id` NULL or the campaign. Exported for its plan test.
 */
export function contactsOnDncStatement(scope: DncScope): InsightsStatement {
  return {
    text: `
      SELECT count(*)::int AS n
        FROM agency_contacts c
       WHERE c.campaign_id = $1::uuid
         AND c.tenant_id = $2::uuid
         AND c.state = 'pending'
         AND EXISTS (
               SELECT 1 FROM dnc_entries d
                WHERE d.tenant_id = $2::uuid
                  AND d.phone_e164 = c.phone_e164
                  AND (d.account_id IS NULL OR d.account_id = $3::uuid)
                  AND (d.campaign_id IS NULL OR d.campaign_id = $1::uuid))`,
    values: [scope.campaignId, scope.tenantId, scope.accountId],
  };
}

// ─── Uploads ────────────────────────────────────────────────────────────────

/** One committed (non-dry-run) ingest job. */
export interface InsightsUploadRow {
  id: string;
  file_name: string | null;
  created_by: string | null;
  created_at: Date;
  finished_at: Date | null;
  status: string;
  mode: string;
  phone_column: string | null;
  rows_read: number;
  accepted: number;
  rejected: number;
  rejected_by_reason: Record<string, unknown> | null;
  duplicates: number;
  /** The upload's duplicate key, in order; empty = phone (or no check). */
  dedupe_columns: string[];
  has_rejected_export: boolean;
}

/** The most uploads one read lists. */
export const INSIGHTS_UPLOADS_LIMIT = 200;

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export class AgencyInsightsReadRepository {
  /** The roster buckets and the headline's counts, one statement. */
  async roster(input: RosterCountsInput): Promise<RosterCounts> {
    const { text, values } = rosterStatement(input);
    const { rows } = await getPool().query<Record<string, number | string>>(text, values);
    const r = rows[0]!;
    const n = (k: string) => num(r[k]);
    return {
      total: n('total'),
      buckets: Object.fromEntries(ROSTER_BUCKETS.map((b) => [b, n(b)])) as Record<RosterBucket, number>,
      attempted: n('attempted'),
      attempts: { one: n('one'), two: n('two'), three: n('three'), four_plus: n('four_plus') },
      dials_placed: n('dials_placed'),
      pending: n('pending'),
      pending_callbacks: n('pending_callbacks'),
      not_reached: n('not_reached'),
      successes: n('successes'),
      callbacks_missed_while_paused: n('callbacks_missed_while_paused'),
      callbacks_due_before_window_end: n('callbacks_due_before_window_end'),
      unassigned_open: n('unassigned_open'),
    };
  }

  /** The running headline's pace: dials in the last 15 min, contacts finished in the last hour. */
  async dialPace(campaignId: string): Promise<DialPace> {
    const { text, values } = dialPaceStatement(campaignId);
    const { rows } = await getPool().query<{ dials_15m: number; finished_1h: number }>(text, values);
    return { dials_15m: num(rows[0]?.dials_15m), finished_1h: num(rows[0]?.finished_1h) };
  }

  /**
   * How many contacts `selector` would pick up for a retry: the retry preview's selection
   * (`retrySelectionConditions` and the never-seeded suppressions, the conditions the preview and
   * the commit's INSERT share) counted without the preview's `DISTINCT ON (fingerprint)`. That
   * DISTINCT computes `agency_contact_row_fingerprint` per selected row (5.0 s on a 1M-contact
   * campaign with 630k matching, against 0.3 s for this count, the same answer); the two differ only by rows of one campaign with the
   * same phone, context and timezone, which `uq_agency_contacts_row_fingerprint` refuses for every
   * row carrying a fingerprint, so only legacy rows without one can be counted twice here.
   */
  async retryMatchCount(campaignId: string, selector: AgencyRetrySelector): Promise<number> {
    const bind = params();
    const conditions = [`c.campaign_id = ${bind.add(campaignId)}::uuid`, ...retrySelectionConditions(selector, 'c', bind)];
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_contacts c
        WHERE ${conditions.join(' AND ')} AND NOT (${neverSeededSuppressionSql('c')})`,
      bind.values,
    );
    return num(rows[0]?.n);
  }

  /** Live attempts on the campaign (calls still finishing): `idx_agency_attempts_live`. */
  async liveAttempts(campaignId: string): Promise<number> {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agency_call_attempts
        WHERE campaign_id = $1::uuid AND state IN ('queued', 'dialing', 'ringing', 'answered', 'bridged')`,
      [campaignId],
    );
    return num(rows[0]?.n);
  }

  /** {@link contactsOnDncStatement}'s count. */
  async contactsOnDnc(scope: DncScope): Promise<number> {
    const { text, values } = contactsOnDncStatement(scope);
    const { rows } = await getPool().query<{ n: number }>(text, values);
    return num(rows[0]?.n);
  }

  /** {@link allocationStatement}'s rows: one per owner, the pool's under `uid: null`. */
  async allocation(input: AllocationCountsInput): Promise<OwnerCounts[]> {
    const { text, values } = allocationStatement(input);
    const { rows } = await getPool().query<Record<string, number | string | null>>(text, values);
    return rows.map((r) => ({
      uid: (r['uid'] as string | null) ?? null,
      allocated: num(r['allocated']),
      attempted: num(r['attempted']),
      due_now: num(r['due_now']),
      waiting_retry: num(r['waiting_retry']),
      callbacks_due_today: num(r['callbacks_due_today']),
      callbacks_overdue: num(r['callbacks_overdue']),
      reached: num(r['reached']),
      not_reached: num(r['not_reached']),
      exhausted: num(r['exhausted']),
      successes: num(r['successes']),
      dnc: num(r['dnc']),
      open: num(r['open']),
      partition_sum: num(r['partition_sum']),
    }));
  }

  /**
   * {@link allocationCountersStatement}: per agent who placed the dials (null: dials with no
   * reserved session), over the campaign's lifetime, from the rollup. Nothing but the allocation
   * route calls it.
   */
  async allocationAttemptCounters(campaignId: string): Promise<Map<string | null, OwnerAttemptCounters>> {
    const { text, values } = allocationCountersStatement(campaignId);
    const { rows } = await getPool().query<{
      uid: string | null; redials: number; reopened: number; manual: number; overrides: number; last: Date | null;
    }>(text, values);
    return new Map(rows.map((r) => [r.uid, {
      redials: num(r.redials),
      retries_reopened: num(r.reopened),
      retries_manual: num(r.manual),
      overrides_used: num(r.overrides),
      last_activity_at: r.last,
    }]));
  }

  /** {@link softphoneCallsStatement}'s count. */
  async softphoneCalls(q: { campaignId: string; tenantId: string; from: Date; to: Date }): Promise<number> {
    const { text, values } = softphoneCallsStatement(q);
    const { rows } = await getPool().query<{ n: number }>(text, values);
    return num(rows[0]?.n);
  }

  /** {@link dncMarkedStatement}'s rows, most first; `added_by` as stored. */
  async dncMarked(q: { campaignId: string; tenantId: string; from: Date; to: Date }): Promise<Array<{ added_by: string | null; count: number }>> {
    const { text, values } = dncMarkedStatement(q);
    const { rows } = await getPool().query<{ added_by: string | null; n: number }>(text, values);
    return rows.map((r) => ({ added_by: r.added_by, count: num(r.n) }))
      .sort((a, b) => b.count - a.count || String(a.added_by).localeCompare(String(b.added_by)));
  }

  /** {@link abandonmentWindowStatement}'s pair. */
  async abandonmentWindow(campaignId: string): Promise<{ abandoned: number; answered: number }> {
    const { text, values } = abandonmentWindowStatement(campaignId);
    const { rows } = await getPool().query<{ answered: number; abandoned: number }>(text, values);
    return { abandoned: num(rows[0]?.abandoned), answered: num(rows[0]?.answered) };
  }

  /** Per agent with a session on the campaign: the state of the joined session, if any. */
  async agentStates(campaignId: string): Promise<Map<string, string>> {
    const { rows } = await getPool().query<{ uid: string; state: string }>(
      `SELECT DISTINCT ON (s.agent_user_id) s.agent_user_id::text AS uid, s.state
         FROM agency_agent_sessions s
        WHERE s.campaign_id = $1::uuid AND s.left_at IS NULL
        ORDER BY s.agent_user_id, s.last_heartbeat DESC`,
      [campaignId],
    );
    return new Map(rows.map((r) => [r.uid, r.state]));
  }

  /** Committed (non-dry-run) uploads, newest first, at most {@link INSIGHTS_UPLOADS_LIMIT}. */
  async listUploads(tenantId: string, campaignId: string): Promise<InsightsUploadRow[]> {
    return this.selectUploads(tenantId, campaignId, { completedOnly: false, limit: INSIGHTS_UPLOADS_LIMIT });
  }

  /** The newest committed upload that completed (the roster it left is the campaign's), or null. */
  async latestCompletedUpload(tenantId: string, campaignId: string): Promise<InsightsUploadRow | null> {
    const [row] = await this.selectUploads(tenantId, campaignId, { completedOnly: true, limit: 1 });
    return row ?? null;
  }

  private async selectUploads(
    tenantId: string,
    campaignId: string,
    opts: { completedOnly: boolean; limit: number },
  ): Promise<InsightsUploadRow[]> {
    const { rows } = await getPool().query<Record<string, unknown>>(
      `SELECT j.id, j.file_name, j.created_by, j.created_at, j.finished_at, j.status, j.mode, j.phone_column,
              j.rows_read, j.accepted, j.rejected, j.rejected_by_reason, j.duplicates, j.dedupe_columns,
              (j.rejected_s3_key IS NOT NULL) AS has_rejected_export
         FROM agency_ingest_jobs j
        WHERE j.campaign_id = $1::uuid AND j.tenant_id = $2::uuid AND NOT j.dry_run
          AND (NOT $3::boolean OR j.status = 'completed')
        ORDER BY j.created_at DESC, j.id DESC
        LIMIT $4`,
      [campaignId, tenantId, opts.completedOnly, opts.limit],
    );
    return rows.map((r) => ({
      id: String(r['id']),
      file_name: (r['file_name'] as string | null) ?? null,
      created_by: (r['created_by'] as string | null) ?? null,
      created_at: r['created_at'] as Date,
      finished_at: (r['finished_at'] as Date | null) ?? null,
      status: String(r['status']),
      mode: String(r['mode']),
      phone_column: (r['phone_column'] as string | null) ?? null,
      rows_read: num(r['rows_read']),
      accepted: num(r['accepted']),
      rejected: num(r['rejected']),
      rejected_by_reason: (r['rejected_by_reason'] as Record<string, unknown> | null) ?? null,
      duplicates: num(r['duplicates']),
      dedupe_columns: (r['dedupe_columns'] as string[] | null) ?? [],
      has_rejected_export: r['has_rejected_export'] === true,
    }));
  }
}

export const agencyInsightsReadRepository = new AgencyInsightsReadRepository();
