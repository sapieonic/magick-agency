/**
 * `AgencyCallSettingsRepository`: `agency_call_settings`, one optional row per (tenant, account)
 * (0071, docs/call-log.md §5): the account's setting "Every call must belong to a campaign". No
 * row reads as the defaults (off).
 *
 * ── What it guarantees ─────────────────────────────────────────────────────────
 *  - **Tenant and account scope in every statement.**
 *  - **Read fresh, never cached.** Every soft-phone dial and inbound outcome asks; a switch
 *    takes effect on the next one. One unique-index lookup.
 *  - **Switching on and saving an inbound route serialise** ({@link lockAccount}, a transaction
 *    advisory lock on the account): the switch is refused while a live route has no campaign for
 *    unknown callers, and a route may not be saved without one while the switch is on, so the
 *    two checks must not each pass on what the other has not committed yet.
 *  - **`require_campaign_since` is when it was LAST switched on.** Saving "on" over "on" keeps
 *    it; switching off clears it. A call that began before it may finish as it is (CL19).
 *
 * The readiness reads of the Settings › Calls page are here too: the agents on no running
 * campaign, and the calls filed under no campaign lately. The routes with no default campaign
 * are `AgencyInboundRouteRepository.listMissingDefaultCampaign`.
 */
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { inboundCampaignRowConditions } from './sql-fragments.js';
import { SOFTPHONE_PLACED_SQL } from './softphone-campaign-sql.js';

type Db = Pick<PoolClient, 'query'>;

/** An `agency_call_settings` row. */
export interface AgencyCallSettingsRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  require_campaign: boolean;
  require_campaign_since: Date | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/** The setting as its readers ask it: on or off, and since when. */
export interface RequireCampaign {
  on: boolean;
  /** When it was last switched on; null while off. */
  since: Date | null;
}

/** What an account with no row reads as. */
export const REQUIRE_CAMPAIGN_OFF: Readonly<RequireCampaign> = Object.freeze({ on: false, since: null });

/** An active member of the account, with every role they hold in it (tenant-wide or the account's). */
export interface AccountMemberRoles {
  user_id: string;
  name: string | null;
  roles: string[];
  /** Actively staffed on a campaign of the account that a soft-phone call can be logged to. */
  on_taggable_campaign: boolean;
}

export class AgencyCallSettingsRepository {
  /** The account's row, or null when it never saved its call settings. */
  async find(tenantId: string, accountId: string, db: Db = getPool()): Promise<AgencyCallSettingsRecord | null> {
    const { rows } = await db.query<AgencyCallSettingsRecord>(
      'SELECT * FROM agency_call_settings WHERE tenant_id = $1::uuid AND account_id = $2::uuid',
      [tenantId, accountId],
    );
    return rows[0] ?? null;
  }

  /** "Every call must belong to a campaign" for the account, read fresh. */
  async requireCampaign(tenantId: string, accountId: string, db: Db = getPool()): Promise<RequireCampaign> {
    const row = await this.find(tenantId, accountId, db);
    return row?.require_campaign ? { on: true, since: row.require_campaign_since } : { ...REQUIRE_CAMPAIGN_OFF };
  }

  /**
   * Hold the account's call-settings lock until the caller's transaction ends: the switch-on and
   * every inbound route write take it before they check each other's state (see the header).
   * Keyed on the tenant and account; `hashtextextended` so two accounts do not share a 32-bit key.
   */
  async lockAccount(client: Db, tenantId: string, accountId: string): Promise<void> {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('agency_call_settings:' || $1::text || ':' || $2::text, 0))`,
      [tenantId, accountId],
    );
  }

  /**
   * Write the switch (`PUT /call-settings`), creating the row on the first write. `mayEnable`
   * runs under {@link lockAccount} when the switch goes on (from off, or with no row): its
   * non-null answer refuses, and nothing is written. Answers the row as stored and whether the
   * switch changed.
   */
  async setRequireCampaign<TRefusal>(
    input: { tenantId: string; accountId: string; on: boolean; userId: string },
    mayEnable: (client: PoolClient) => Promise<TRefusal | null>,
  ): Promise<{ ok: true; row: AgencyCallSettingsRecord; changed: boolean } | { ok: false; refusal: TRefusal }> {
    return withTransaction(async (client, tx) => {
      await this.lockAccount(client, input.tenantId, input.accountId);
      const current = await this.find(input.tenantId, input.accountId, client);
      const was = current?.require_campaign ?? false;
      if (input.on && !was) {
        const refusal = await mayEnable(client);
        if (refusal !== null) {
          await tx.rollback();
          return { ok: false as const, refusal };
        }
      }
      const { rows } = await client.query<AgencyCallSettingsRecord>(
        `INSERT INTO agency_call_settings AS s (tenant_id, account_id, require_campaign, require_campaign_since, updated_by)
         VALUES ($1::uuid, $2::uuid, $3::boolean, CASE WHEN $3::boolean THEN now() END, $4::uuid)
         ON CONFLICT (tenant_id, account_id) DO UPDATE
           SET require_campaign = EXCLUDED.require_campaign,
               require_campaign_since = CASE
                 WHEN NOT EXCLUDED.require_campaign THEN NULL
                 WHEN s.require_campaign THEN s.require_campaign_since
                 ELSE now() END,
               updated_by = EXCLUDED.updated_by
         RETURNING s.*`,
        [input.tenantId, input.accountId, input.on, input.userId],
      );
      return { ok: true as const, row: rows[0]!, changed: was !== input.on };
    }, { pool: getPool() });
  }

  /**
   * Every active member who can open the account (an active user with an active membership at
   * tenant level or in this account), with the roles they hold there and whether they are
   * actively staffed on a campaign of the account in one of `taggableStatuses`. The caller
   * decides which roles are agents (`rbac`). Bounded by the account's head count.
   */
  async listMembersWithStaffing(
    tenantId: string,
    accountId: string,
    taggableStatuses: readonly string[],
  ): Promise<AccountMemberRoles[]> {
    const { rows } = await getPool().query<AccountMemberRoles>(
      `SELECT u.id AS user_id, NULLIF(btrim(COALESCE(u.display_name, '')), '') AS name,
              array_agg(DISTINCT mm.role::text) AS roles,
              EXISTS (
                SELECT 1 FROM agency_campaign_agents a
                  JOIN agency_campaigns c ON c.id = a.campaign_id
                 WHERE a.tenant_id = $1::uuid AND a.user_id = u.id AND a.unassigned_at IS NULL
                   AND c.tenant_id = $1::uuid AND c.account_id = $2::uuid
                   AND c.status = ANY($3::text[])) AS on_taggable_campaign
         FROM users u
         JOIN memberships mm ON mm.user_id = u.id
        WHERE u.status = 'active' AND mm.tenant_id = $1::uuid AND mm.status = 'active'
          AND (mm.account_id IS NULL OR mm.account_id = $2::uuid)
        GROUP BY u.id, u.display_name
        ORDER BY lower(COALESCE(u.display_name, '')), u.id`,
      [tenantId, accountId, [...taggableStatuses]],
    );
    return rows;
  }

  /**
   * The account's calls of the last `days` days filed under no campaign: soft-phone calls that
   * were dialled with none (`dialed_at` set, SR2's definition of a soft-phone call), and ended
   * inbound calls we served with none (the Call log's own row rule, `inboundCampaignRowConditions`:
   * a `rejected` call is not a call of ours). Each is a range of an account index
   * (`idx_agency_manual_calls_account`, the inbound summary's
   * `(tenant_id, account_id, arrived_at) WHERE state = 'ended'`).
   *
   * The window is ROLLING: the last `days` × 24 hours to this instant. The console's link from
   * the count (`unfiledCallsPath`) opens All calls on calendar days on the reader's clock, which
   * cannot be this window (the server does not know the reader's zone, and the list's date
   * fields are days): the list starts up to a day earlier, and also shows soft-phone calls that
   * never dialled, greyed, which this count leaves out. So the list can hold a few more rows
   * than the number, never fewer.
   */
  async countUnfiledCalls(tenantId: string, accountId: string, days: number, now: Date = new Date()): Promise<number> {
    const from = new Date(now.getTime() - days * 86_400_000);
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT (
          (SELECT count(*) FROM agency_manual_calls m
            WHERE m.tenant_id = $1::uuid AND m.account_id = $2::uuid AND m.created_at >= $3::timestamptz
              AND m.campaign_id IS NULL AND ${SOFTPHONE_PLACED_SQL})
        + (SELECT count(*) FROM agency_inbound_calls i
            WHERE i.tenant_id = $1::uuid AND i.account_id = $2::uuid AND i.arrived_at >= $3::timestamptz
              AND i.campaign_id IS NULL AND ${inboundCampaignRowConditions('i').join(' AND ')})
        )::text AS n`,
      [tenantId, accountId, from],
    );
    return Number(rows[0]?.n ?? 0);
  }
}

export const agencyCallSettingsRepository = new AgencyCallSettingsRepository();
