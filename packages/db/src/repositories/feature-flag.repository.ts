import { getPool } from '../connection.js';
import type {
  FeatureFlagOverrideRecord,
  UpsertFeatureFlagOverrideInput,
  DeleteFeatureFlagOverrideInput,
} from '../models/feature-flag.model.js';

/**
 * Repository over `feature_flag_overrides` — sparse override rows keyed by
 * (flag_key, scope). The catalog of *which* flags exist lives in the code
 * registry (`src/feature-flags/registry.ts`); this table holds only deviations
 * from the resolved default.
 *
 * JSONB `value` is written as JSON text (`JSON.stringify`) — the repo-wide
 * convention (see call/static-call/audit repositories). A bare boolean/number
 * stringifies to valid JSON, so non-object flag values round-trip correctly.
 */
export class FeatureFlagRepository {
  /**
   * Insert or update a single override. The conflict target matches the matching
   * partial unique index (including its `WHERE` predicate) so the upsert is
   * per (flag, scope target).
   */
  async upsert(input: UpsertFeatureFlagOverrideInput): Promise<FeatureFlagOverrideRecord> {
    const pool = getPool();
    const conflictTarget =
      input.scope_type === 'global'
        ? "(flag_key) WHERE scope_type = 'global'"
        : input.scope_type === 'tenant'
          ? "(flag_key, tenant_id) WHERE scope_type = 'tenant'"
          : "(flag_key, tenant_id, account_id) WHERE scope_type = 'account'";

    const result = await pool.query<FeatureFlagOverrideRecord>(
      `INSERT INTO feature_flag_overrides
         (flag_key, scope_type, tenant_id, account_id, value, reason, expires_at, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $8)
       ON CONFLICT ${conflictTarget}
       DO UPDATE SET
         value = EXCLUDED.value,
         reason = EXCLUDED.reason,
         expires_at = EXCLUDED.expires_at,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        input.flag_key,
        input.scope_type,
        input.tenant_id ?? null,
        input.account_id ?? null,
        JSON.stringify(input.value),
        input.reason ?? null,
        input.expires_at ?? null,
        input.updated_by ?? null,
      ],
    );
    return result.rows[0]!;
  }

  /** All global-scope override rows (the global snapshot). */
  async findGlobal(): Promise<FeatureFlagOverrideRecord[]> {
    const pool = getPool();
    const result = await pool.query<FeatureFlagOverrideRecord>(
      `SELECT * FROM feature_flag_overrides WHERE scope_type = 'global'`,
    );
    return result.rows;
  }

  /** All tenant+account override rows for one tenant (the per-tenant snapshot). */
  async findByTenant(tenantId: string): Promise<FeatureFlagOverrideRecord[]> {
    const pool = getPool();
    const result = await pool.query<FeatureFlagOverrideRecord>(
      `SELECT * FROM feature_flag_overrides
       WHERE tenant_id = $1 AND scope_type IN ('tenant', 'account')`,
      [tenantId],
    );
    return result.rows;
  }

  /**
   * The single override row for an exact (flag, scope) tuple, or null. Used to
   * capture the prior value for the old→new audit trail. NULL dimensions compare
   * with IS NOT DISTINCT FROM so global (tenant_id NULL) and tenant lookups both work.
   */
  async findOne(input: DeleteFeatureFlagOverrideInput): Promise<FeatureFlagOverrideRecord | null> {
    const pool = getPool();
    const result = await pool.query<FeatureFlagOverrideRecord>(
      `SELECT * FROM feature_flag_overrides
       WHERE flag_key = $1
         AND scope_type = $2
         AND tenant_id IS NOT DISTINCT FROM $3
         AND account_id IS NOT DISTINCT FROM $4`,
      [input.flag_key, input.scope_type, input.tenant_id ?? null, input.account_id ?? null],
    );
    return result.rows[0] ?? null;
  }

  /** Every override row for one flag (drives the per-flag admin view). */
  async findByFlag(flagKey: string): Promise<FeatureFlagOverrideRecord[]> {
    const pool = getPool();
    const result = await pool.query<FeatureFlagOverrideRecord>(
      `SELECT * FROM feature_flag_overrides WHERE flag_key = $1
       ORDER BY scope_type, tenant_id, account_id`,
      [flagKey],
    );
    return result.rows;
  }

  /** Remove an override (revert to the next resolution layer). Returns whether a row was deleted. */
  async delete(input: DeleteFeatureFlagOverrideInput): Promise<boolean> {
    const pool = getPool();
    // Match the exact scope tuple. NULL dimensions compare with IS NOT DISTINCT FROM
    // so a global delete (tenant_id NULL) and a tenant delete both work cleanly.
    const result = await pool.query(
      `DELETE FROM feature_flag_overrides
       WHERE flag_key = $1
         AND scope_type = $2
         AND tenant_id IS NOT DISTINCT FROM $3
         AND account_id IS NOT DISTINCT FROM $4`,
      [input.flag_key, input.scope_type, input.tenant_id ?? null, input.account_id ?? null],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Bulk upsert — used by the gradual-rollout endpoint. Applies each input in turn. */
  async upsertMany(inputs: UpsertFeatureFlagOverrideInput[]): Promise<FeatureFlagOverrideRecord[]> {
    const out: FeatureFlagOverrideRecord[] = [];
    for (const input of inputs) {
      out.push(await this.upsert(input));
    }
    return out;
  }
}

export const featureFlagRepository = new FeatureFlagRepository();
