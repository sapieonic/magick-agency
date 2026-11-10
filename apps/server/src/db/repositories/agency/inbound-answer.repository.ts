/**
 * `AgencyInboundAnswerRepository`: the reads the inbound answer webhook makes beyond the spine
 * (docs/inbound.md §3, §4.1, §5.3): the route's admission count under its lock, and the caller
 * identification over the customer-history indexes.
 *
 * ── Identification (§4.1) ────────────────────────────────────────────────────
 * An actor-less, tenant-wide, unaudited read, NOT the customer-history route (that one is
 * user-scoped, rate-limited and audited: CH2, CH6, CH10, CH11). It covers every account of the
 * tenant that is not deleted, walked one account at a time over the customer-history indexes,
 * each walk stopped early:
 *  - the number's roster rows: `idx_agency_contacts_customer_history (tenant_id, account_id,
 *    phone_e164, created_at DESC, id DESC)`, the newest {@link INBOUND_CONTACT_CANDIDATES_PER_ACCOUNT}
 *    per account; each one's latest attempt by `uq_agency_attempt_number (contact_id,
 *    attempt_number)`;
 *  - the calls to the number inside the lookback: the attempts of those roster rows (by contact),
 *    and the soft-phone calls dialled to it, `idx_agency_manual_calls_destination (tenant_id,
 *    account_id, destination_e164, created_at DESC, id DESC)`, the newest
 *    {@link INBOUND_CALLS_PER_ACCOUNT} per account.
 * What the rows MEAN (which contact is matched, which agent is sticky and why) is decided in
 * `agency/inbound/identify-caller.ts`, a pure function over these rows.
 *
 * Every id is bound as a parameter and cast once; callers validate ids at the edge (`22P02`).
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import type {
  AgencyCampaignStatus, AgencyContactState, AgencyInboundHoliday, AgencyInboundHoursInterval,
} from '@magick-agency/contracts/agency';

type Db = Pick<PoolClient, 'query'>;

/** Roster rows per account the identification reads for one number (newest first). */
export const INBOUND_CONTACT_CANDIDATES_PER_ACCOUNT = 50;
/** Calls (attempts, soft-phone calls) per account the identification reads inside the lookback. */
export const INBOUND_CALLS_PER_ACCOUNT = 50;

/** One roster row carrying the caller's number, with what ranking it needs. */
export interface InboundContactCandidateRow {
  contact_id: string;
  campaign_id: string;
  account_id: string;
  contact_state: AgencyContactState;
  suppressed_reason: string | null;
  assigned_user_id: string | null;
  contact_created_at: Date;
  campaign_status: AgencyCampaignStatus;
  inbound_sticky_enabled: boolean;
  /** Whether the contact's account may use the number rung (the caller-ID tag rule). */
  account_may_use: boolean;
  /** The contact's latest campaign attempt, or nulls. */
  last_attempt_at: Date | null;
  last_attempt_caller_id: string | null;
}

/** A route's hours, as `@magick-agency/domain/inbound-schedule` reads them. */
export interface InboundRouteSchedule {
  timezone: string;
  weekly_hours: AgencyInboundHoursInterval[];
  holidays: AgencyInboundHoliday[];
}

/** One call to the caller's number inside the lookback, by an agent who may still be assigned work. */
export interface InboundCallSignalRow {
  channel: 'campaign' | 'softphone';
  /** The attempt or soft-phone call id. */
  call_id: string;
  account_id: string;
  campaign_id: string | null;
  contact_id: string | null;
  agent_user_id: string;
  caller_id: string;
  connected: boolean;
  at: Date;
  /** The tagged campaign's `inbound_sticky_enabled`; true for an untagged soft-phone call. */
  sticky_enabled: boolean;
}

/**
 * Whether user `alias.agent` is someone work can still be given to in the tenant: an active user
 * with an active membership in it (tenant-level or any account). A removed or deactivated agent is
 * never sticky (§4.3, last row).
 */
const activeInTenant = (userExpr: string) => `EXISTS (
         SELECT 1 FROM users u JOIN memberships mm ON mm.user_id = u.id
          WHERE u.id = ${userExpr} AND u.status = 'active' AND mm.tenant_id = $1::uuid AND mm.status = 'active')`;

/** The tenant's accounts that are not deleted. $1 tenant. */
const ACCOUNTS_CTE = `acc AS MATERIALIZED (SELECT a.id FROM accounts a WHERE a.tenant_id = $1::uuid AND a.status <> 'deleted')`;

/** The number's newest roster rows per account. $1 tenant, $2 the caller's E.164. */
const CONTACTS_CTE = `ct AS MATERIALIZED (
         SELECT w.* FROM acc
          CROSS JOIN LATERAL (
            SELECT c.id FROM agency_contacts c
             WHERE c.tenant_id = $1::uuid AND c.account_id = acc.id AND c.phone_e164 = $2::text
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT ${INBOUND_CONTACT_CANDIDATES_PER_ACCOUNT}) w)`;

export class AgencyInboundAnswerRepository {
  /**
   * Serialise the admissions of one route: a transaction-scoped advisory lock on the route id,
   * held until the caller's transaction ends, so two calls arriving together cannot both read
   * the route as under its `max_concurrent` and both be admitted (IB5).
   */
  async lockRouteAdmission(routeId: string, client: Db): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('agency_inbound_routes.admission'), hashtext($1::uuid::text))`,
      [routeId],
    );
  }

  /**
   * The route's live ADMITTED calls: not ended, and moved on from `arrived` (an admitted call
   * goes to `greeting` in the transaction that admits it; one turned away for the route's cap stays
   * `arrived` until it ends, and one the bridge's shared scopes turn away is put back there
   * (`refuseAdmission`), so a burst of callers hearing "all lines are busy" never holds the route
   * full). The same predicate as the account's live total (`countLiveForAccount`'s inbound arm). Read once per arriving call over `idx_agency_inbound_calls_open` (0024): bounded by
   * the live inbound calls, whatever the route's history.
   */
  async countLiveAdmittedOnRoute(routeId: string, db: Db = getPool()): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM agency_inbound_calls c
        WHERE c.route_id = $1::uuid AND c.state <> 'ended' AND c.state <> 'arrived'`,
      [routeId],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * The roster rows carrying `fromE164` in the tenant's accounts (see the header), each with its
   * campaign, owner, latest attempt and whether its account may use `phoneNumberId` (the number
   * rung; the tag rule of `findAvailableForAccount`). Newest first.
   */
  async findContactCandidates(
    input: { tenantId: string; fromE164: string; phoneNumberId: string },
    db: Db = getPool(),
  ): Promise<InboundContactCandidateRow[]> {
    const { rows } = await db.query<InboundContactCandidateRow>(
      `WITH ${ACCOUNTS_CTE}, ${CONTACTS_CTE}
       SELECT c.id AS contact_id, c.campaign_id, c.account_id, c.state AS contact_state, c.suppressed_reason,
              c.assigned_user_id, c.created_at AS contact_created_at,
              cam.status AS campaign_status, cam.inbound_sticky_enabled,
              (tpa.id IS NOT NULL AND (
                 NOT EXISTS (SELECT 1 FROM phone_account_tags pat WHERE pat.assignment_id = tpa.id)
                 OR EXISTS (SELECT 1 FROM phone_account_tags pat WHERE pat.assignment_id = tpa.id AND pat.account_id = c.account_id)
              )) AS account_may_use,
              la.created_at AS last_attempt_at, la.caller_id AS last_attempt_caller_id
         FROM ct
         JOIN agency_contacts c ON c.id = ct.id
         JOIN agency_campaigns cam ON cam.id = c.campaign_id
         LEFT JOIN tenant_phone_assignments tpa ON tpa.phone_number_id = $3::uuid AND tpa.tenant_id = $1::uuid
         LEFT JOIN LATERAL (
           SELECT a.created_at, a.caller_id FROM agency_call_attempts a
            WHERE a.contact_id = c.id
            ORDER BY a.attempt_number DESC
            LIMIT 1) la ON true
        ORDER BY c.created_at DESC, c.id DESC`,
      [input.tenantId, input.fromE164, input.phoneNumberId],
    );
    return rows;
  }

  /**
   * The calls to `fromE164` placed since `since` that name an agent still active in the tenant:
   * the campaign attempts of the number's roster rows (agent = the reserved session's user) and the
   * soft-phone calls dialled to the number. Newest first, at most
   * {@link INBOUND_CALLS_PER_ACCOUNT} of each kind per account.
   */
  async findCallSignals(
    input: { tenantId: string; fromE164: string; since: Date },
    db: Db = getPool(),
  ): Promise<InboundCallSignalRow[]> {
    const { rows } = await db.query<InboundCallSignalRow>(
      `WITH ${ACCOUNTS_CTE}, ${CONTACTS_CTE},
       attempts AS (
         SELECT w.* FROM acc
          CROSS JOIN LATERAL (
            SELECT 'campaign'::text AS channel, a.id AS call_id, a.account_id, a.campaign_id, a.contact_id,
                   s.agent_user_id, a.caller_id,
                   COALESCE(a.outcome = 'connected' OR a.bridged_at IS NOT NULL, false) AS connected, a.created_at AS at,
                   cam.inbound_sticky_enabled AS sticky_enabled
              FROM agency_call_attempts a
              JOIN agency_agent_sessions s ON s.id = a.reserved_agent_id
              JOIN agency_campaigns cam ON cam.id = a.campaign_id
             WHERE a.contact_id IN (SELECT id FROM ct) AND a.tenant_id = $1::uuid AND a.account_id = acc.id
               AND a.created_at >= $3::timestamptz
             ORDER BY a.created_at DESC
             LIMIT ${INBOUND_CALLS_PER_ACCOUNT}) w
       ),
       manual AS (
         SELECT w.* FROM acc
          CROSS JOIN LATERAL (
            SELECT 'softphone'::text AS channel, m.id AS call_id, m.account_id, m.campaign_id, m.contact_id,
                   m.agent_user_id, m.caller_id,
                   COALESCE(m.outcome = 'connected' OR m.state = 'bridged', false) AS connected, m.created_at AS at,
                   COALESCE((SELECT cam.inbound_sticky_enabled FROM agency_campaigns cam WHERE cam.id = m.campaign_id), true)
                     AS sticky_enabled
              FROM agency_manual_calls m
             WHERE m.tenant_id = $1::uuid AND m.account_id = acc.id AND m.destination_e164 = $2::text
               AND m.created_at >= $3::timestamptz
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT ${INBOUND_CALLS_PER_ACCOUNT}) w
       )
       SELECT x.* FROM (SELECT * FROM attempts UNION ALL SELECT * FROM manual) x
        WHERE ${activeInTenant('x.agent_user_id')}
        ORDER BY x.at DESC, x.call_id DESC`,
      [input.tenantId, input.fromE164, input.since],
    );
    return rows;
  }

  /**
   * A route's opening hours (`InboundSchedule`), deleted or not: what the follow-up of a call that
   * named it reads to book the callback at the route's next opening. Null when no such route.
   */
  async findRouteSchedule(routeId: string, db: Db = getPool()): Promise<InboundRouteSchedule | null> {
    const { rows } = await db.query<InboundRouteSchedule>(
      `SELECT r.timezone, r.weekly_hours, r.holidays FROM agency_inbound_routes r WHERE r.id = $1::uuid`,
      [routeId],
    );
    return rows[0] ?? null;
  }

  /**
   * Record on an ENDED call the callback its follow-up booked (the sweep ends calls first, in its
   * own statement, and books after). Only while the row has none, so a second booking for one
   * call cannot move it. False when nothing was written.
   */
  async setCallbackDueAt(id: string, dueAt: Date, db: Db = getPool()): Promise<boolean> {
    const { rowCount } = await db.query(
      `UPDATE agency_inbound_calls SET callback_due_at = $2::timestamptz
        WHERE id = $1::uuid AND state = 'ended' AND callback_due_at IS NULL AND follow_up_status IS NOT NULL`,
      [id, dueAt],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Of `userIds`, those who can see the account's work: an active user with an active
   * membership in the tenant at tenant level or in `accountId`. The Missed row's assignee must be
   * someone who can open it.
   */
  async filterAccountMembers(tenantId: string, accountId: string, userIds: readonly string[], db: Db = getPool()): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const { rows } = await db.query<{ id: string }>(
      `SELECT DISTINCT u.id FROM users u JOIN memberships mm ON mm.user_id = u.id
        WHERE u.id = ANY($3::uuid[]) AND u.status = 'active'
          AND mm.tenant_id = $1::uuid AND mm.status = 'active'
          AND (mm.account_id IS NULL OR mm.account_id = $2::uuid)`,
      [tenantId, accountId, [...userIds]],
    );
    return new Set(rows.map((r) => r.id));
  }
}

export const agencyInboundAnswerRepository = new AgencyInboundAnswerRepository();
