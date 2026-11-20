/**
 * `AgencyMyDayRepository`: the two reads behind the agent's My day (agent station BE-1, BE-3; the
 * wire is `packages/contracts/src/api/agency/my-day.ts`, the rules `src/agency/my-day.ts`). Light
 * enough for the station to poll every 30 to 60 s and after each saved outcome.
 *
 *  - {@link MY_DAY_COUNTS_SQL}: the agent's own numbers on one campaign over the day, from the
 *    agent record's own frozen metrics ({@link AGENCY_ATTEMPT_METRICS_SQL}, `my-stats`'s
 *    statement: attempts dialled by the agent's sessions, `dialed_at` in the window), so My day,
 *    the agent's scorecard and the floor's `calls_today` count the same conversations. Plus the
 *    promises to pay (AS7) written in the window on the agent's calls of the campaign, every kind
 *    of call that can carry one (the Live floor's promises summary reads the same three tables):
 *    the dialler's attempts of those sessions, the agent's soft-phone calls tagged to the campaign
 *    (`agency_manual_calls.agent_user_id`) and the inbound calls the agent answered that matched a
 *    contact of the campaign (`answered_by_user_id`, `matched_campaign_id`). Each by
 *    `dispositioned_at` (every outcome write stamps it with `promise_date`, and a replay that
 *    corrects a promise re-stamps the same row, so it is counted once), whoever saved the outcome
 *    (a supervisor's on-behalf save of the agent's call is the agent's, as on the dialler).
 *    The agent's sessions are read first (`idx_agency_agent_sessions_agent`, 0023: the few that
 *    were open during the day), then their attempts by session (`idx_agency_attempts_agent_dialed`);
 *    the soft-phone promises on the agent's own calls (`idx_agency_manual_calls_agent`) or the
 *    account's promises of the window (`idx_agency_manual_calls_promise_written`, 0050), whichever
 *    the planner finds smaller, and the inbound ones on `idx_agency_inbound_calls_promise_written`.
 *  - {@link myCallLaterStatement}: the agent's own pending call-laters on the campaign, due before
 *    the day's end (the overdue included), oldest due first, at most `limit`, with the counts.
 *    Two halves: the ones this agent booked (0057's booker), read on
 *    `idx_agency_contacts_my_callbacks` (0058), whose predicate {@link MY_CALLBACKS_INDEX_PREDICATE_SQL}
 *    repeats byte for byte; and, on `strict` / `preferred` campaigns, the callbacks assigned to the
 *    agent (a supervisor's hand-off, LF7, and those booked before the booker was recorded), read on
 *    `idx_agency_contacts_assignee` (0010). On those campaigns the list holds only what will really
 *    come to the agent (the lead's ruling on AS8): a call-later they booked that a supervisor has
 *    since given to someone else (LF21) or that the callback fallback returned to the pool (CA5)
 *    is not theirs any more, so the booked half also requires `assigned_user_id` to be the agent,
 *    a separate AND after 0058's predicate (the new owner sees it through their assigned half;
 *    the planner may then read the booked half on the assignee index, the agent's own contacts,
 *    which the assigned half reads anyway). On
 *    `pool` the booked half is the whole list. A contact in both halves is one row. A callback is
 *    `isCallbackSql`'s, the one definition.
 *
 * `test/integration/api/agent-station-my-day.test.ts` pins the counts, the halves and the plans.
 */
import { getPool } from '@magick-agency/db';
import { AGENCY_ATTEMPT_METRICS_SQL, readAttemptMetrics } from './sql-fragments.js';
import { isCallbackSql } from './assignment-sql.js';

/**
 * 0058's `idx_agency_contacts_my_callbacks` predicate, byte for byte as the migration writes it,
 * unqualified. The booker half reads `agency_contacts` unaliased so this text is the same in both
 * places and the planner proves the partial index applies.
 */
export const MY_CALLBACKS_INDEX_PREDICATE_SQL = `state = 'pending' AND callback_booked_by_user_id IS NOT NULL`;

/**
 * $1 agent, $2 tenant, $3 account, $4 campaign, $5 day start (inclusive), $6 day end (exclusive).
 * Exported for its plan test.
 */
export const MY_DAY_COUNTS_SQL = `
  WITH my_sessions AS MATERIALIZED (
    SELECT s.id
      FROM agency_agent_sessions s
     WHERE s.agent_user_id = $1::uuid
       AND s.tenant_id = $2::uuid
       AND s.account_id = $3::uuid
       AND s.campaign_id = $4::uuid
       AND s.joined_at < $6::timestamptz
       AND (s.left_at IS NULL OR s.left_at >= $5::timestamptz)
  )
  SELECT ${AGENCY_ATTEMPT_METRICS_SQL},
         ((SELECT COUNT(*)
             FROM my_sessions mp
             JOIN agency_call_attempts p ON p.reserved_agent_id = mp.id
            WHERE p.campaign_id = $4::uuid
              AND p.promise_date IS NOT NULL
              AND p.dispositioned_at >= $5::timestamptz
              AND p.dispositioned_at < $6::timestamptz)
          + (SELECT COUNT(*)
               FROM agency_manual_calls m
              WHERE m.tenant_id = $2::uuid AND m.account_id = $3::uuid
                AND m.promise_date IS NOT NULL
                AND m.dispositioned_at >= $5::timestamptz
                AND m.dispositioned_at < $6::timestamptz
                AND m.campaign_id = $4::uuid
                AND m.agent_user_id = $1::uuid)
          + (SELECT COUNT(*)
               FROM agency_inbound_calls i
              WHERE i.tenant_id = $2::uuid AND i.account_id = $3::uuid
                AND i.promise_date IS NOT NULL
                AND i.dispositioned_at >= $5::timestamptz
                AND i.dispositioned_at < $6::timestamptz
                AND i.matched_campaign_id = $4::uuid
                AND i.answered_by_user_id = $1::uuid))::text AS promises
    FROM my_sessions ms
    JOIN agency_call_attempts a ON a.reserved_agent_id = ms.id
    JOIN agency_campaigns c ON c.id = a.campaign_id
   WHERE a.campaign_id = $4::uuid
     AND a.dialed_at IS NOT NULL
     AND a.dialed_at >= $5::timestamptz
     AND a.dialed_at < $6::timestamptz`;

/** What {@link AgencyMyDayRepository.counts} reads. */
export interface MyDayCountsInput {
  agentUserId: string;
  tenantId: string;
  accountId: string;
  campaignId: string;
  from: Date;
  to: Date;
}

/** What {@link AgencyMyDayRepository.callLaters} reads. */
export interface MyCallLatersInput {
  campaignId: string;
  agentUserId: string;
  /**
   * `strict` / `preferred`: the callbacks assigned to the agent are theirs too, and a call-later
   * they booked is theirs only while it is still assigned to them. `pool`: the booked ones.
   */
  ownerMode: boolean;
  /** `callbackCodes(campaign.disposition_catalog)`. */
  callbackCodes: readonly string[];
  /** The day's end: due before it (the overdue included). */
  dueBefore: Date;
  now: Date;
  limit: number;
}

/** The call-later read's statement. Exported for its plan test. */
export function myCallLaterStatement(input: MyCallLatersInput): { text: string; values: unknown[] } {
  const owned = input.ownerMode
    ? `
       UNION
       SELECT o.id, o.next_attempt_at
         FROM agency_contacts o
        WHERE o.campaign_id = $1::uuid
          AND o.assigned_user_id = $2::uuid
          AND o.state = 'pending'
          AND o.next_attempt_at < $3::timestamptz
          AND o.suppressed_reason IS DISTINCT FROM 'dnc'
          AND ${isCallbackSql('o', '$4')}`
    : '';
  return {
    text: `
      WITH mine AS (
        SELECT id, next_attempt_at
          FROM agency_contacts
         WHERE campaign_id = $1::uuid
           AND callback_booked_by_user_id = $2::uuid
           AND ${MY_CALLBACKS_INDEX_PREDICATE_SQL}${input.ownerMode ? `
           AND assigned_user_id = $2::uuid` : ''}
           AND next_attempt_at < $3::timestamptz
           AND suppressed_reason IS DISTINCT FROM 'dnc'
           AND ${isCallbackSql('agency_contacts', '$4')}${owned}
      ), page AS (
        SELECT m.id, m.next_attempt_at,
               COUNT(*) FILTER (WHERE m.next_attempt_at < $5::timestamptz) OVER () AS overdue,
               COUNT(*) OVER () AS total
          FROM mine m
         ORDER BY m.next_attempt_at, m.id
         LIMIT $6::int
      )
      SELECT p.id AS contact_id, k.context, p.next_attempt_at AS due_at,
             p.overdue::text AS overdue, p.total::text AS total
        FROM page p
        JOIN agency_contacts k ON k.id = p.id
       ORDER BY p.next_attempt_at, p.id`,
    values: [input.campaignId, input.agentUserId, input.dueBefore, [...input.callbackCodes], input.now, input.limit],
  };
}

export class AgencyMyDayRepository {
  /** The agent's own numbers on the campaign in `[from, to)`. */
  async counts(input: MyDayCountsInput): Promise<{
    dialed: number; calls: number; talk_seconds: number; successes: number; promises: number;
  }> {
    const { rows } = await getPool().query<{
      attempts: string; connected: string; successes: string; talk_seconds: string; wrapup_seconds: string;
      promises: string;
    }>(MY_DAY_COUNTS_SQL, [input.agentUserId, input.tenantId, input.accountId, input.campaignId, input.from, input.to]);
    const row = rows[0];
    if (!row) return { dialed: 0, calls: 0, talk_seconds: 0, successes: 0, promises: 0 };
    const m = readAttemptMetrics(row);
    return {
      dialed: m.attempts,
      calls: m.connected,
      talk_seconds: m.talk_seconds,
      successes: m.successes,
      promises: Number(row.promises),
    };
  }

  /** The agent's own pending call-laters due before the day's end: the first `limit`, and the counts. */
  async callLaters(input: MyCallLatersInput): Promise<{
    rows: Array<{ contact_id: string; context: Record<string, unknown> | null; due_at: Date }>;
    today: number;
    overdue: number;
  }> {
    const { text, values } = myCallLaterStatement(input);
    const { rows } = await getPool().query<{
      contact_id: string; context: Record<string, unknown> | null; due_at: Date; overdue: string; total: string;
    }>(text, values);
    const overdue = rows[0] ? Number(rows[0].overdue) : 0;
    const total = rows[0] ? Number(rows[0].total) : 0;
    return {
      rows: rows.map((r) => ({ contact_id: r.contact_id, context: r.context, due_at: r.due_at })),
      today: total - overdue,
      overdue,
    };
  }
}

export const agencyMyDayRepository = new AgencyMyDayRepository();
