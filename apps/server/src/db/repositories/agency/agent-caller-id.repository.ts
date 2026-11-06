/**
 * Dedicated caller IDs (decisions DN1–DN10): `agency_campaign_agent_caller_ids`, one number per
 * agent per campaign and one agent per number per campaign (migration 0016).
 *
 *  - {@link EFFECTIVE_DEDICATION_SQL} is THE definition of a dedication that counts (DN1): its
 *    agent has an ACTIVE staffing row on the campaign, and the row was set at or after that
 *    staffing began. Every read here applies it, so a row an unstaff left behind (a release
 *    that failed, or one that raced a PUT) is never dialled, listed, guarded or summarised, and
 *    never revives when the agent is staffed again.
 *  - {@link AgencyAgentCallerIdRepository.mapForCampaign} is the dial paths' read: ONE indexed
 *    query (`uq_agency_agent_caller_id_agent` leads with `campaign_id`; the staffing side is the
 *    campaign's active roster, `idx_agency_campaign_agents_campaign_active`, or a probe of
 *    `uq_agency_campaign_agent_active_campaign`, as the planner picks) per dialling batch, per agent's own call, per
 *    redial and per tagged soft-phone dial. The resolver (`resolveCallerId`,
 *    `agency/pacing/caller-id-pool.ts`) decides from it; a stored number the campaign no longer
 *    has is ignored there, not here.
 *  - {@link AgencyAgentCallerIdRepository.set} is the supervisor's PUT, one transaction:
 *    serialised per (campaign, agent) by an advisory lock, then the campaign row `FOR SHARE`
 *    (the number is validated against `caller_ids` as they stand, and a campaign PATCH, which
 *    holds the row `FOR UPDATE`, cannot drop it in between), then the agent's active staffing
 *    row `FOR SHARE` (an unstaff closing it waits for this write to commit, so its release sees
 *    the row). A number held by another agent is `taken` (checked first, and a unique-violation
 *    race on `uq_agency_agent_caller_id_number` is mapped to the same answer, never a 500); an
 *    agent who already holds a number has it replaced in the same statement (an UPSERT on
 *    `uq_agency_agent_caller_id_agent`).
 *  - The unstaff release (DN7) is not here: it is a CTE of CA6's return statement
 *    (`AgencyAssignmentRepository.returnOnUnstaff`), so the two happen together.
 */
import { getPool } from '@magick-agency/db';
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { PoolClient } from 'pg';
import { usableCallerIds } from '../../../agency/pacing/caller-id-pool.js';
import type { AgencyCampaignRecord } from '../../models/agency.model.js';

type Queryable = Pick<PoolClient, 'query'>;

/** The unique constraint a number held by another agent trips. */
export const AGENT_CALLER_ID_NUMBER_CONSTRAINT = 'uq_agency_agent_caller_id_number';

/** One stored dedication. */
export interface AgentCallerIdRow {
  campaign_id: string;
  user_id: string;
  caller_id: string;
  set_by_user_id: string | null;
  set_at: Date;
}

/** The PUT's outcome. `caller_ids` is the campaign's usable caller IDs the write was checked against. */
export type AgentCallerIdSetOutcome =
  | { ok: true; row: AgentCallerIdRow; previous_caller_id: string | null; changed: boolean; caller_ids: string[] }
  /** The agent has no active staffing row on the campaign (read inside the write's transaction). */
  | { ok: false; reason: 'not_staffed' }
  /** Not one of the campaign's usable caller IDs as they stand (read `FOR SHARE` in the transaction). */
  | { ok: false; reason: 'not_in_campaign'; caller_ids: string[] }
  /** Held by another agent on the campaign; `holder_user_id` null when it went in between. */
  | { ok: false; reason: 'taken'; holder_user_id: string | null };

/**
 * THE effective dedication (DN1), a predicate over the dedication aliased `d`: its agent has an
 * ACTIVE staffing row on the campaign (`unassigned_at IS NULL`), and the dedication was set at or
 * after that staffing row's `assigned_at`. Anything else is a stale row (an unstaff whose release
 * failed or raced a PUT) and counts nowhere; the second clause keeps it from reviving when the
 * agent is staffed again (a new staffing row, a later `assigned_at`). Served by the active-staffing
 * partial indexes (`idx_agency_campaign_agents_campaign_active`, `uq_agency_campaign_agent_active_campaign`):
 * on a seeded database (57k staffing rows, 20k dedications) the per-campaign map is a hash semi
 * join of two index scans, 0.15 ms. `set()` stamps `set_at` with `clock_timestamp()` after
 * locking the staffing row, so a dedication made on a live staffing row is never older than it.
 */
export const EFFECTIVE_DEDICATION_SQL = `EXISTS (
  SELECT 1 FROM agency_campaign_agents s
   WHERE s.tenant_id = d.tenant_id AND s.user_id = d.user_id AND s.campaign_id = d.campaign_id
     AND s.unassigned_at IS NULL AND d.set_at >= s.assigned_at)`;

/**
 * Serialises every write to one agent's dedication on one campaign (`set`, `clear`), so the
 * audit's `previous_caller_id` is the number the write replaced even when the agent had none
 * (a `FOR UPDATE` on a row that does not exist yet locks nothing). `$1` campaign, `$2` agent.
 */
export const AGENT_CALLER_ID_LOCK_SQL =
  `SELECT pg_advisory_xact_lock(hashtext('agency_campaign_agent_caller_ids'), hashtext($1::text || ':' || $2::text))`;

const COLUMNS = `d.campaign_id::text AS campaign_id, d.user_id::text AS user_id, d.caller_id,
                 d.set_by_user_id::text AS set_by_user_id, d.set_at`;

export class AgencyAgentCallerIdRepository {
  /**
   * Agent user id → effective dedicated number, on one campaign. Empty map when none. `db` lets
   * the campaign PATCH read it inside its transaction (the campaign row held `FOR UPDATE`).
   */
  async mapForCampaign(campaignId: string, db: Queryable = getPool()): Promise<Map<string, string>> {
    const { rows } = await db.query<{ user_id: string; caller_id: string }>(
      `SELECT d.user_id::text AS user_id, d.caller_id
         FROM agency_campaign_agent_caller_ids d
        WHERE d.campaign_id = $1::uuid AND ${EFFECTIVE_DEDICATION_SQL}`,
      [campaignId],
    );
    return new Map(rows.map((r) => [r.user_id, r.caller_id]));
  }

  /** Every effective dedication on a campaign of `tenantId`. Unordered: the route orders by agent name. */
  async listForCampaign(tenantId: string, campaignId: string): Promise<AgentCallerIdRow[]> {
    const { rows } = await getPool().query<AgentCallerIdRow>(
      `SELECT ${COLUMNS}
         FROM agency_campaign_agent_caller_ids d
        WHERE d.campaign_id = $1::uuid AND d.tenant_id = $2::uuid AND ${EFFECTIVE_DEDICATION_SQL}`,
      [campaignId, tenantId],
    );
    return rows;
  }

  /** The number effectively dedicated to `userId` on a campaign, as stored, or null. */
  async findForAgent(campaignId: string, userId: string): Promise<string | null> {
    const { rows } = await getPool().query<{ caller_id: string }>(
      `SELECT d.caller_id FROM agency_campaign_agent_caller_ids d
        WHERE d.campaign_id = $1::uuid AND d.user_id = $2::uuid AND ${EFFECTIVE_DEDICATION_SQL}`,
      [campaignId, userId],
    );
    return rows[0]?.caller_id ?? null;
  }

  /** The agent effectively holding `callerId` on a campaign, or null. */
  async holderOf(campaignId: string, callerId: string): Promise<string | null> {
    const { rows } = await getPool().query<{ user_id: string }>(
      `SELECT d.user_id::text AS user_id FROM agency_campaign_agent_caller_ids d
        WHERE d.campaign_id = $1::uuid AND d.caller_id = $2 AND ${EFFECTIVE_DEDICATION_SQL}`,
      [campaignId, callerId],
    );
    return rows[0]?.user_id ?? null;
  }

  /**
   * Dedicate `callerId` (trimmed by the caller) to `userId` on the campaign, replacing the
   * number they held, in one transaction (see the module header for the locks and why):
   *
   *  1. the (campaign, agent) advisory lock ({@link AGENT_CALLER_ID_LOCK_SQL});
   *  2. the campaign's `caller_ids` `FOR SHARE`;
   *  3. the agent's active staffing row `FOR SHARE`: none → `not_staffed`; then the number
   *     not among the usable caller IDs → `not_in_campaign`;
   *  4. stale rows (not {@link EFFECTIVE_DEDICATION_SQL}) of this agent or this number on the
   *     campaign are deleted, so one never blocks the unique constraints;
   *  5. the agent's row (`previous`); the same number again writes nothing (`changed: false`);
   *  6. the number held by another agent → `taken`; else the UPSERT, `set_at` the
   *     `clock_timestamp()` (after step 3's lock, so never before the staffing's `assigned_at`).
   */
  async set(input: {
    tenantId: string;
    accountId: string;
    campaignId: string;
    userId: string;
    callerId: string;
    setByUserId: string | null;
  }): Promise<AgentCallerIdSetOutcome> {
    try {
      return await withTransaction(async (client, tx) => {
        await client.query(AGENT_CALLER_ID_LOCK_SQL, [input.campaignId, input.userId]);
        const campaign = await client.query<Pick<AgencyCampaignRecord, 'caller_ids'>>(
          `SELECT caller_ids FROM agency_campaigns
            WHERE id = $1::uuid AND tenant_id = $2::uuid
            FOR SHARE`,
          [input.campaignId, input.tenantId],
        );
        const staffed = await client.query(
          `SELECT 1 FROM agency_campaign_agents
            WHERE tenant_id = $1::uuid AND user_id = $2::uuid AND campaign_id = $3::uuid
              AND unassigned_at IS NULL
            FOR SHARE`,
          [input.tenantId, input.userId, input.campaignId],
        );
        if (staffed.rowCount === 0) {
          await tx.rollback();
          return { ok: false, reason: 'not_staffed' } as const;
        }
        const usable = campaign.rows[0] ? usableCallerIds(campaign.rows[0]) : [];
        if (!usable.includes(input.callerId)) {
          await tx.rollback();
          return { ok: false, reason: 'not_in_campaign', caller_ids: usable } as const;
        }
        await client.query(
          `DELETE FROM agency_campaign_agent_caller_ids d
            WHERE d.campaign_id = $1::uuid AND (d.user_id = $2::uuid OR d.caller_id = $3)
              AND NOT ${EFFECTIVE_DEDICATION_SQL}`,
          [input.campaignId, input.userId, input.callerId],
        );
        // The agent's row, locked; the advisory lock has already serialised two PUTs for them.
        const prev = await client.query<AgentCallerIdRow>(
          `SELECT ${COLUMNS} FROM agency_campaign_agent_caller_ids d
            WHERE d.campaign_id = $1::uuid AND d.user_id = $2::uuid
            FOR UPDATE`,
          [input.campaignId, input.userId],
        );
        const previous = prev.rows[0] ?? null;
        if (previous && previous.caller_id === input.callerId) {
          return { ok: true, row: previous, previous_caller_id: previous.caller_id, changed: false, caller_ids: usable } as const;
        }
        const held = await client.query<{ user_id: string }>(
          `SELECT user_id::text AS user_id FROM agency_campaign_agent_caller_ids
            WHERE campaign_id = $1::uuid AND caller_id = $2 AND user_id <> $3::uuid`,
          [input.campaignId, input.callerId, input.userId],
        );
        if (held.rows[0]) return { ok: false, reason: 'taken', holder_user_id: held.rows[0].user_id } as const;
        // A concurrent PUT of the same number for another agent, committed after the read
        // above, trips uq_agency_agent_caller_id_number here: mapped below.
        const { rows } = await client.query<AgentCallerIdRow>(
          `INSERT INTO agency_campaign_agent_caller_ids AS d
             (tenant_id, account_id, campaign_id, user_id, caller_id, set_by_user_id, set_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, clock_timestamp())
           ON CONFLICT ON CONSTRAINT uq_agency_agent_caller_id_agent DO UPDATE
             SET caller_id = EXCLUDED.caller_id,
                 set_by_user_id = EXCLUDED.set_by_user_id,
                 set_at = EXCLUDED.set_at
           RETURNING ${COLUMNS}`,
          [input.tenantId, input.accountId, input.campaignId, input.userId, input.callerId, input.setByUserId],
        );
        return { ok: true, row: rows[0]!, previous_caller_id: previous?.caller_id ?? null, changed: true, caller_ids: usable } as const;
      }, { pool: getPool() });
    } catch (err) {
      if (!isUniqueViolation(err, AGENT_CALLER_ID_NUMBER_CONSTRAINT)) throw err;
      return { ok: false, reason: 'taken', holder_user_id: await this.holderOf(input.campaignId, input.callerId) };
    }
  }

  /**
   * Release `userId`'s number on the campaign, under the same advisory lock as {@link set}. The
   * number released, or null when none was effectively set. A stale row is deleted too, but is
   * not reported (it was never dialled from, so nothing is audited as released).
   */
  async clear(campaignId: string, userId: string): Promise<string | null> {
    return withTransaction(async (client) => {
      await client.query(AGENT_CALLER_ID_LOCK_SQL, [campaignId, userId]);
      const { rows } = await client.query<{ caller_id: string; effective: boolean }>(
        `DELETE FROM agency_campaign_agent_caller_ids d
          WHERE d.campaign_id = $1::uuid AND d.user_id = $2::uuid
         RETURNING d.caller_id, ${EFFECTIVE_DEDICATION_SQL} AS effective`,
        [campaignId, userId],
      );
      return rows[0]?.effective ? rows[0].caller_id : null;
    }, { pool: getPool() });
  }
}

export const agencyAgentCallerIdRepository = new AgencyAgentCallerIdRepository();
