/**
 * `AgencyCompareViewRepository`: Compare agents' saved views (`agency_compare_views`, 0064; the
 * wire is `AgencyCompareView`, `packages/contracts/src/api/agency/compare.ts`; docs/compare-agents.md
 * §4). A small table: a few views per supervisor.
 *
 * Every statement names the tenant AND the account; the routes validate every id at the edge and
 * the view's content (metrics against the campaign's catalog) before a write. What this file
 * owns are the two rules that need a transaction:
 *
 *  - **the per-owner limit** (`COMPARE_VIEWS_PER_USER_MAX`): counted in the create's transaction
 *    under a transaction advisory lock on (tenant, account, owner), so two creates at once cannot
 *    both see 49 and both insert;
 *  - **one default per campaign** (`uq_agency_compare_views_campaign_default`): setting a view as
 *    its campaign's default clears the campaign's other default, whoever owns it, in the same
 *    transaction, under an advisory lock on the campaign, so two supervisors setting defaults at
 *    once serialise instead of one failing on the unique index. The cleared view's `updated_at` is
 *    left alone: its owner did not edit it.
 *
 * **Lock order** (every transaction here takes them in this order, so two can never wait on each
 * other): the campaign's default lock FIRST, whenever the write may set a default; then the
 * owner's lock (create); then rows. An edit that locked its row and then waited for the campaign's
 * lock deadlocked (`40P01`) against a create or edit holding that lock and clearing the old default,
 * which is a write to the very row the first one held.
 *
 * Only the owner edits or deletes a view: `update` and `delete` match on the owner and answer
 * "not found" otherwise, the same answer as for a view that does not exist (the route's uniform
 * `404 compare_view_not_found`).
 */
import { getPool } from '@magick-agency/db';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import type { PoolClient } from 'pg';
import type { AgencyCompareMetricRef, CompareLens } from '@magick-agency/contracts/api/agency/compare';

/** One stored view (`agency_compare_views`). */
export interface CompareViewRecord {
  id: string;
  tenant_id: string;
  account_id: string;
  owner_user_id: string;
  name: string;
  lens: CompareLens;
  metrics: AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  campaign_id: string | null;
  shared: boolean;
  is_campaign_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A view's content: everything the owner chooses. Validated by the route before it gets here. */
export interface CompareViewContent {
  name: string;
  lens: CompareLens;
  metrics: AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  campaign_id: string | null;
  shared: boolean;
  is_campaign_default: boolean;
}

/** The scope every statement names. */
export interface CompareViewScope {
  tenantId: string;
  accountId: string;
}

export type CompareViewCreateResult =
  | { ok: true; view: CompareViewRecord }
  | { ok: false; reason: 'limit' };

const COLUMNS = `id, tenant_id, account_id, owner_user_id, name, lens, metrics, trend, campaign_id, shared,
       is_campaign_default, created_at, updated_at`;

/**
 * The views a supervisor may see in the account: their own and the shared ones; with a campaign,
 * only that campaign's views and those with no campaign. Ordered as the contract says: the
 * campaign's default first, then the caller's own, then the rest, each newest `updated_at` first
 * (the id last, so the order is total). $1 tenant, $2 account, $3 caller, $4 campaign or NULL.
 */
export const COMPARE_VIEW_LIST_SQL = `
  SELECT ${COLUMNS}
    FROM agency_compare_views v
   WHERE v.tenant_id = $1::uuid AND v.account_id = $2::uuid
     AND (v.owner_user_id = $3::uuid OR v.shared)
     AND ($4::uuid IS NULL OR v.campaign_id = $4::uuid OR v.campaign_id IS NULL)
   ORDER BY (v.is_campaign_default AND $4::uuid IS NOT NULL AND v.campaign_id = $4::uuid) DESC,
            (v.owner_user_id = $3::uuid) DESC,
            v.updated_at DESC, v.id`;

/** The lock key of an owner's views in an account (the per-owner limit). */
export const COMPARE_VIEW_OWNER_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('agency_compare_views:owner:' || $1::text || ':' || $2::text || ':' || $3::text, 0))`;
/** The lock key of a campaign's default view: taken before any other lock or row (see the lock order). */
export const COMPARE_VIEW_DEFAULT_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtextextended('agency_compare_views:default:' || $1::text, 0))`;

function json(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

/** Clear the campaign's default but `keepId`. The caller already holds the campaign's default lock. */
async function clearOtherDefault(client: PoolClient, scope: CompareViewScope, campaignId: string, keepId: string | null): Promise<void> {
  await client.query(
    `UPDATE agency_compare_views
        SET is_campaign_default = false
      WHERE campaign_id = $1::uuid AND is_campaign_default
        AND tenant_id = $2::uuid AND account_id = $3::uuid
        AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [campaignId, scope.tenantId, scope.accountId, keepId],
  );
}

export class AgencyCompareViewRepository {
  /** {@link COMPARE_VIEW_LIST_SQL}. */
  async list(scope: CompareViewScope & { userId: string; campaignId: string | null }): Promise<CompareViewRecord[]> {
    const { rows } = await getPool().query<CompareViewRecord>(COMPARE_VIEW_LIST_SQL, [scope.tenantId, scope.accountId, scope.userId, scope.campaignId]);
    return rows;
  }

  /** The view if the caller may see it (their own, or shared), else null. */
  async findVisible(scope: CompareViewScope & { userId: string }, id: string): Promise<CompareViewRecord | null> {
    const { rows } = await getPool().query<CompareViewRecord>(
      `SELECT ${COLUMNS} FROM agency_compare_views
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid
          AND (owner_user_id = $4::uuid OR shared)`,
      [id, scope.tenantId, scope.accountId, scope.userId],
    );
    return rows[0] ?? null;
  }

  /** The caller's own view, else null (also for another supervisor's). */
  async findOwned(scope: CompareViewScope & { userId: string }, id: string): Promise<CompareViewRecord | null> {
    const { rows } = await getPool().query<CompareViewRecord>(
      `SELECT ${COLUMNS} FROM agency_compare_views
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND owner_user_id = $4::uuid`,
      [id, scope.tenantId, scope.accountId, scope.userId],
    );
    return rows[0] ?? null;
  }

  /** The campaign's default view (shared by the CHECK), else null. */
  async findCampaignDefault(scope: CompareViewScope, campaignId: string): Promise<CompareViewRecord | null> {
    const { rows } = await getPool().query<CompareViewRecord>(
      `SELECT ${COLUMNS} FROM agency_compare_views
        WHERE campaign_id = $1::uuid AND is_campaign_default
          AND tenant_id = $2::uuid AND account_id = $3::uuid`,
      [campaignId, scope.tenantId, scope.accountId],
    );
    return rows[0] ?? null;
  }

  /**
   * Insert a view for `ownerUserId`, unless they already own `maxPerOwner` in the account
   * (`{ ok: false, reason: 'limit' }`). A default clears the campaign's other default first.
   */
  async create(scope: CompareViewScope & { ownerUserId: string; maxPerOwner: number }, content: CompareViewContent): Promise<CompareViewCreateResult> {
    const defaultFor = content.is_campaign_default ? content.campaign_id : null;
    return withTransaction(async (client) => {
      // The lock order: the campaign's default lock, then the owner's, then rows.
      if (defaultFor !== null) await client.query(COMPARE_VIEW_DEFAULT_LOCK_SQL, [defaultFor]);
      await client.query(COMPARE_VIEW_OWNER_LOCK_SQL, [scope.tenantId, scope.accountId, scope.ownerUserId]);
      const { rows: counted } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM agency_compare_views
          WHERE tenant_id = $1::uuid AND account_id = $2::uuid AND owner_user_id = $3::uuid`,
        [scope.tenantId, scope.accountId, scope.ownerUserId],
      );
      if ((counted[0]?.n ?? 0) >= scope.maxPerOwner) return { ok: false, reason: 'limit' } as const;
      if (defaultFor !== null) await clearOtherDefault(client, scope, defaultFor, null);
      const { rows } = await client.query<CompareViewRecord>(
        `INSERT INTO agency_compare_views
           (tenant_id, account_id, owner_user_id, name, lens, metrics, trend, campaign_id, shared, is_campaign_default)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7::jsonb, $8::uuid, $9, $10)
         RETURNING ${COLUMNS}`,
        [
          scope.tenantId, scope.accountId, scope.ownerUserId, content.name, content.lens,
          json(content.metrics), json(content.trend), content.campaign_id, content.shared, content.is_campaign_default,
        ],
      );
      return { ok: true, view: rows[0]! } as const;
    }, { pool: getPool() });
  }

  /**
   * Replace the content of the caller's own view (the route merged and validated it), stamping
   * `updated_at`. Null when there is no such view of theirs (another supervisor's included).
   */
  async update(scope: CompareViewScope & { ownerUserId: string }, id: string, content: CompareViewContent): Promise<CompareViewRecord | null> {
    const defaultFor = content.is_campaign_default ? content.campaign_id : null;
    return withTransaction(async (client) => {
      // The lock order: the campaign's default lock BEFORE the row's lock (module note).
      if (defaultFor !== null) await client.query(COMPARE_VIEW_DEFAULT_LOCK_SQL, [defaultFor]);
      const { rows: mine } = await client.query<{ id: string }>(
        `SELECT id FROM agency_compare_views
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND owner_user_id = $4::uuid
          FOR UPDATE`,
        [id, scope.tenantId, scope.accountId, scope.ownerUserId],
      );
      if (mine.length === 0) return null;
      if (defaultFor !== null) await clearOtherDefault(client, scope, defaultFor, id);
      const { rows } = await client.query<CompareViewRecord>(
        `UPDATE agency_compare_views
            SET name = $2, lens = $3, metrics = $4::jsonb, trend = $5::jsonb, campaign_id = $6::uuid,
                shared = $7, is_campaign_default = $8, updated_at = now()
          WHERE id = $1::uuid
          RETURNING ${COLUMNS}`,
        [
          id, content.name, content.lens, json(content.metrics), json(content.trend), content.campaign_id,
          content.shared, content.is_campaign_default,
        ],
      );
      return rows[0] ?? null;
    }, { pool: getPool() });
  }

  /** Delete the caller's own view. False when there is no such view of theirs. */
  async delete(scope: CompareViewScope & { ownerUserId: string }, id: string): Promise<boolean> {
    const { rowCount } = await getPool().query(
      `DELETE FROM agency_compare_views
        WHERE id = $1::uuid AND tenant_id = $2::uuid AND account_id = $3::uuid AND owner_user_id = $4::uuid`,
      [id, scope.tenantId, scope.accountId, scope.ownerUserId],
    );
    return (rowCount ?? 0) > 0;
  }
}

export const agencyCompareViewRepository = new AgencyCompareViewRepository();
