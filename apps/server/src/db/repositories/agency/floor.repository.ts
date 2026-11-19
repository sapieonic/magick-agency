/**
 * `AgencyFloorRepository`: the account's whole floor (the Live floor page, decision B28b; the wire
 * is `packages/contracts/src/api/agency/floor.ts`). Two statements, both tenant and account scoped:
 *
 *  - {@link FLOOR_ROWS_SQL}: one row per person. Every open session in the account (a campaign
 *    session on any of its campaigns, or a soft-phone session, `campaign_id` NULL), with its
 *    campaign, its unsettled inbound call (the per-campaign floor's lateral, `supervisorAgents`),
 *    the window its wrap-up takes (an inbound wrap-up's captured on its call, else the campaign's;
 *    none for a timerless campaign), whether the person is staffed on an active campaign, and
 *    the session's open Need help (LF4: open and fresh on the database's clock, `helpOpenSql`);
 *    then one row per agent staffed on an ACTIVE campaign (`running`, `stopping`, `paused`) with
 *    no open session in the account, with when their last session in THIS account ended (never a
 *    later one in another account).
 *  - {@link FLOOR_CALLS_TODAY_SQL}: each agent's conversations dialled in a window, counted as
 *    the grouped stats count `connected` (the same FROM, scope, window and
 *    `CONVERSATION_ATTEMPT_SQL`), so an agent's `calls_today` is their `group_by=agent` row.
 *
 * The call in progress on a session is not read here: it is the live calls list's own read
 * (`AgencyLiveCallRepository.listLive`), keyed by its `agent_session_id`.
 *
 * ── One row per person ──────────────────────────────────────────────────────
 * `uq_agency_agent_live_agent` (0035, OS1) holds one open session per agent across every tenant,
 * so an agent has at most one open row here. Should two ever be open (a row the unique index did
 * not see, an index dropped by a rollback), `DISTINCT ON (agent_user_id)` keeps the newest joined,
 * then the greatest session id: deterministic, and the session the agent last opened. A campaign
 * agent switched to the soft phone is their campaign session on `break/soft_phone`, never a second
 * row (docs/softphone.md §2).
 *
 * ── What it costs (polled every 5 s per open Live floor) ─────────────────────
 * Measured with EXPLAIN ANALYZE on Postgres 16 (warm cache) against one account of 540 agents (500
 * on shift, 40 staffed and away, 20 of whom left today) over 25 running campaigns (60 in all),
 * inside a deployment of 10 tenants, 5,000 campaigns, 46,720 sessions (30 days of history) and
 * 600,100 attempts, 37,782 of the account's dialled in the 10 h window, 100 calls live:
 *  - {@link FLOOR_ROWS_SQL}: 5–7 ms. The account's open sessions on `uq_agency_agent_live_tenant`
 *    (by tenant, the account filtered), the staffed agents on `idx_agency_campaigns_tenant` then
 *    `idx_agency_campaign_agents_campaign_active` per active campaign, the inbound lateral on
 *    `uq_agency_inbound_calls_session_unsettled`, and an absent agent's last session on
 *    `idx_agency_agent_sessions_agent` (their own sessions only).
 *  - the live calls (`LIVE_CALLS_SQL`, the live list's statement): 1.5 ms.
 *  - {@link FLOOR_CALLS_TODAY_SQL}: 35 ms. Every attempt dialled in the window on
 *    `idx_agency_attempts_billing` (the grouped stats' own index; it is the read's cost and grows
 *    with the deployment's dials in the window), grouped per session, then joined to the
 *    account's sessions. So the internal handler keeps it `FLOOR_CALLS_TODAY_CACHE_MS`
 *    per account and `from` (`api/routes/agency/floor.ts`): at most one such read per account
 *    every 30 s, whatever the number of open tabs.
 * `test/integration/agency/floor-repository.test.ts` pins the rows on their indexes.
 */
import { getPool } from '@magick-agency/db';
import type { AgencyAgentLiveState, AgencyClientKind } from '@magick-agency/contracts/agency';
import { AGENCY_INBOUND_OUTCOME_LAPSE_MS, type AgencyBreakReason } from '@magick-agency/contracts/agency';
import { AGENCY_HOME_ACTIVE_STATUSES } from '@magick-agency/contracts/api/agency/home';
import { INBOUND_DEFAULT_WRAPUP_SECONDS } from '../../../agency/inbound/inbound-wrapup.js';
import { AGENCY_HELP_EXPIRY_MS } from '@magick-agency/contracts/agency';
import { CONVERSATION_ATTEMPT_SQL, inboundUnsettledCallLateralSql } from './sql-fragments.js';
import { helpOpenSql } from './floor-assist.repository.js';

/** The campaign statuses whose staffed agents are on the floor with no session: Home's active set, the same list. */
export const FLOOR_ACTIVE_STATUSES = AGENCY_HOME_ACTIVE_STATUSES;

/** One person on the floor, as the database answers. */
export interface AgencyFloorRow {
  /** The open session; null for a staffed agent with none. */
  session_id: string | null;
  agent_user_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  /**
   * The window the session's wrap-up takes, in seconds: on an inbound wrap-up (`inbound_outcome_owed`)
   * the one captured on the inbound call (IQ52, `agency_inbound_calls.wrapup_seconds`), else the
   * inbound default, never past the backstop (`inboundOutcomeWindowMs`'s rule; the captured window's
   * CHECK, 10..600 s, keeps it well inside); otherwise the campaign's `wrapup_seconds`. Null without a campaign, and for a
   * timerless campaign (`wrapup_seconds = 0`: no countdown, so nothing to be past).
   */
  wrapup_seconds: number | null;
  /** The campaign's break catalog as stored (`[]`: the default catalog); null without a campaign. */
  break_reasons: AgencyBreakReason[] | null;
  /** `offline` for a row with no open session. */
  state: AgencyAgentLiveState;
  state_since: Date | null;
  /** Only while `state = 'break'`. */
  break_reason: string | null;
  client_kind: AgencyClientKind | null;
  on_inbound_call: boolean;
  inbound_outcome_owed: boolean;
  /** Staffed on an active campaign of the account. */
  staffed: boolean;
  /** No open session: when their last session in the account ended, if at or after `from`. */
  left_at: Date | null;
  /** The open session's open Need help (LF4): when it was raised; null when none is open (or past its expiry). */
  help_raised_at: Date | null;
  /** The call it was raised on; null with no open request, or one raised in wrap-up. */
  help_call_id: string | null;
}

/**
 * The floor's rows: $1 tenant, $2 account, $3 `from`, $4 the active statuses, $5 the inbound default
 * window in seconds ({@link INBOUND_DEFAULT_WRAPUP_SECONDS}), $6 the inbound backstop in ms
 * ({@link AGENCY_INBOUND_OUTCOME_LAPSE_MS}), $7 the Need help expiry in ms ({@link AGENCY_HELP_EXPIRY_MS}).
 * Exported for its plan test.
 */
export const FLOOR_ROWS_SQL = `
  WITH open_sessions AS (
    SELECT DISTINCT ON (s.agent_user_id)
           s.id, s.agent_user_id, s.campaign_id, s.state, s.state_since, s.break_reason, s.client_kind,
           -- The open Need help (LF4), by the rule every read applies: open and fresh on the database's clock.
           CASE WHEN ${helpOpenSql('$7')} THEN s.help_raised_at END AS help_raised_at,
           CASE WHEN ${helpOpenSql('$7')} THEN s.help_call_id END AS help_call_id
      FROM agency_agent_sessions s
     WHERE s.tenant_id = $1::uuid AND s.account_id = $2::uuid AND s.left_at IS NULL
     ORDER BY s.agent_user_id, s.joined_at DESC, s.id DESC
  ), staffed AS (
    SELECT DISTINCT ca.user_id AS agent_user_id
      FROM agency_campaigns c
      JOIN agency_campaign_agents ca
        ON ca.campaign_id = c.id AND ca.tenant_id = $1::uuid AND ca.unassigned_at IS NULL
     WHERE c.tenant_id = $1::uuid AND c.account_id = $2::uuid AND c.status = ANY($4::text[])
  )
  SELECT o.id AS session_id, o.agent_user_id, o.campaign_id, cam.name AS campaign_name,
         -- The window the session's wrap-up takes: on an inbound wrap-up (its call ended and owes
         -- its outcome) the one captured on the call (IQ52), else the inbound default, never past
         -- the backstop (inbound-wrapup.ts inboundOutcomeWindowMs); otherwise the campaign's, and
         -- none for a timerless campaign (wrapup_seconds = 0: no countdown).
         CASE WHEN ib.outcome_owed THEN LEAST(COALESCE(ib.wrapup_seconds, $5::int), $6::int / 1000)
              WHEN cam.wrapup_seconds > 0 THEN cam.wrapup_seconds
         END AS wrapup_seconds,
         cam.break_reasons,
         o.state, o.state_since,
         -- Only while on a break: the column keeps the last reason after they return.
         CASE WHEN o.state = 'break' THEN o.break_reason END AS break_reason,
         o.client_kind,
         COALESCE(ib.on_call, false) AS on_inbound_call,
         COALESCE(ib.outcome_owed, false) AS inbound_outcome_owed,
         EXISTS (SELECT 1 FROM staffed st WHERE st.agent_user_id = o.agent_user_id) AS staffed,
         NULL::timestamptz AS left_at,
         o.help_raised_at, o.help_call_id
    FROM open_sessions o
    LEFT JOIN agency_campaigns cam ON cam.id = o.campaign_id AND cam.tenant_id = $1::uuid
    -- The session's unsettled inbound call (on_call, outcome_owed, its captured window): the
    -- per-campaign floor's own lateral (campaign-stats.ts supervisorAgents; sql-fragments.ts).
    ${inboundUnsettledCallLateralSql('o.id')}
  UNION ALL
  SELECT NULL::uuid, st.agent_user_id, NULL::uuid, NULL::varchar, NULL::int, NULL::jsonb,
         'offline'::varchar, NULL::timestamptz, NULL::varchar, NULL::varchar, false, false, true,
         CASE WHEN last.left_at >= $3::timestamptz THEN last.left_at END,
         NULL::timestamptz, NULL::uuid
    FROM staffed st
    -- Their last session in the account: sessions of one agent in one tenant never overlap
    -- (uq_agency_agent_live_tenant), so the newest joined is the last to end. The walk goes back
    -- through the agent's sessions in other accounts until it meets one in this one.
    LEFT JOIN LATERAL (
      SELECT s.left_at
        FROM agency_agent_sessions s
       WHERE s.agent_user_id = st.agent_user_id AND s.tenant_id = $1::uuid AND s.account_id = $2::uuid
       ORDER BY s.joined_at DESC
       LIMIT 1
    ) last ON true
   WHERE NOT EXISTS (SELECT 1 FROM open_sessions o WHERE o.agent_user_id = st.agent_user_id)`;

/**
 * Each agent's conversations dialled in `[$3, $4)`: $1 tenant, $2 account. The grouped stats'
 * statement grouped by `agent` (`agent-grouped-stats.ts`): the scope on the attempt, the session
 * joined INNER in the same account, `dialed_at` in the window, `connected` counted by
 * `CONVERSATION_ATTEMPT_SQL`. Counted per session first and joined to the sessions after (a few
 * hundred primary-key rows, not one per attempt), which is the same count: the join is on the
 * session's primary key, so it neither drops nor repeats an attempt the grouped read keeps.
 * `MATERIALIZED`: inlined, the planner joins every attempt to the account's sessions before
 * grouping (about half again the time on the seeded set below).
 * Exported for its plan test.
 */
export const FLOOR_CALLS_TODAY_SQL = `
  WITH per_session AS MATERIALIZED (
    SELECT a.reserved_agent_id AS session_id,
           COUNT(*) FILTER (WHERE ${CONVERSATION_ATTEMPT_SQL}) AS calls
      FROM agency_call_attempts a
     WHERE a.tenant_id = $1::uuid
       AND a.account_id = $2::uuid
       AND a.dialed_at IS NOT NULL
       AND a.dialed_at >= $3::timestamptz
       AND a.dialed_at < $4::timestamptz
     GROUP BY a.reserved_agent_id
  )
  SELECT s.agent_user_id, SUM(p.calls)::text AS calls
    FROM per_session p
    JOIN agency_agent_sessions s ON s.id = p.session_id
     AND s.tenant_id = $1::uuid
     AND s.account_id = $2::uuid
   GROUP BY s.agent_user_id`;

export class AgencyFloorRepository {
  /** The account's floor rows: open sessions first, then the staffed agents with none; each by agent. */
  async floorRows(tenantId: string, accountId: string, from: Date): Promise<AgencyFloorRow[]> {
    const { rows } = await getPool().query<AgencyFloorRow>(FLOOR_ROWS_SQL, [
      tenantId, accountId, from, [...FLOOR_ACTIVE_STATUSES], INBOUND_DEFAULT_WRAPUP_SECONDS, AGENCY_INBOUND_OUTCOME_LAPSE_MS,
      AGENCY_HELP_EXPIRY_MS,
    ]);
    const out = rows.map((r): AgencyFloorRow => ({
      ...r,
      wrapup_seconds: r.wrapup_seconds === null ? null : Number(r.wrapup_seconds),
      client_kind: r.session_id === null ? null : r.client_kind === 'mobile' ? 'mobile' : 'web',
      on_inbound_call: r.on_inbound_call === true,
      inbound_outcome_owed: r.inbound_outcome_owed === true,
      staffed: r.staffed === true,
    }));
    // Open sessions first, then the absent; each by agent (the console ranks by risk).
    return out.sort((a, b) => Number(a.session_id === null) - Number(b.session_id === null)
      || (a.agent_user_id < b.agent_user_id ? -1 : a.agent_user_id > b.agent_user_id ? 1 : 0));
  }

  /** Each agent's conversations dialled in `[from, to)` in the account; an agent with none is absent. */
  async callsToday(tenantId: string, accountId: string, from: Date, to: Date): Promise<Map<string, number>> {
    const { rows } = await getPool().query<{ agent_user_id: string; calls: string }>(
      FLOOR_CALLS_TODAY_SQL, [tenantId, accountId, from, to],
    );
    return new Map(rows.map((r) => [r.agent_user_id, Number(r.calls)]));
  }
}

export const agencyFloorRepository = new AgencyFloorRepository();
