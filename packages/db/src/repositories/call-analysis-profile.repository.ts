import { getPool } from '../connection.js';
import type {
  CallAnalysisProfileRecord,
  CreateCallAnalysisProfileInput,
  UpdateCallAnalysisProfileInput,
} from '../models/call-analysis-profile.model.js';

/**
 * Reusable analysis profiles — the dialer's answer to prompt `analytics_config`.
 * Tenant/account-scoped throughout. Mirrors the prompt-template lifecycle:
 * copy-on-write versioning (a PUT inserts a new version and deactivates the old
 * row), soft delete, and DB-backed active-name uniqueness. At most one default per
 * (tenant, account) — setting a new default clears the previous one in the same
 * transaction.
 */
export class CallAnalysisProfileRepository {
  async create(input: CreateCallAnalysisProfileInput): Promise<CallAnalysisProfileRecord> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Making this the default demotes any existing default first, so the partial
      // unique index (one default per tenant/account) can never be violated.
      if (input.is_default) {
        await client.query(
          `UPDATE call_analysis_profiles SET is_default = false
           WHERE tenant_id = $1 AND account_id = $2 AND is_default = true AND is_active = true`,
          [input.tenant_id, input.account_id],
        );
      }

      const result = await client.query<CallAnalysisProfileRecord>(
        `INSERT INTO call_analysis_profiles (
          tenant_id, account_id, name, description, context,
          custom_dimensions, language_hint, is_default
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *`,
        [
          input.tenant_id,
          input.account_id,
          input.name,
          input.description ?? null,
          input.context ?? null,
          JSON.stringify(input.custom_dimensions ?? []),
          input.language_hint ?? null,
          input.is_default ?? false,
        ],
      );

      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async findById(id: string): Promise<CallAnalysisProfileRecord | null> {
    const pool = getPool();
    const result = await pool.query<CallAnalysisProfileRecord>(
      'SELECT * FROM call_analysis_profiles WHERE id = $1',
      [id],
    );
    return result.rows[0] ?? null;
  }

  /** Scoped lookup — a missing or non-owned row is a 404. Active versions only. */
  async findByIdScoped(
    id: string,
    tenantId: string,
    accountId: string,
  ): Promise<CallAnalysisProfileRecord | null> {
    const pool = getPool();
    const result = await pool.query<CallAnalysisProfileRecord>(
      `SELECT * FROM call_analysis_profiles
       WHERE id = $1 AND tenant_id = $2 AND account_id = $3 AND is_active = true`,
      [id, tenantId, accountId],
    );
    return result.rows[0] ?? null;
  }

  /** Any active profile with this name — the friendly pre-create 409 guard. */
  async findActiveByName(
    tenantId: string,
    accountId: string,
    name: string,
  ): Promise<CallAnalysisProfileRecord | null> {
    const pool = getPool();
    const result = await pool.query<CallAnalysisProfileRecord>(
      `SELECT * FROM call_analysis_profiles
       WHERE tenant_id = $1 AND account_id = $2 AND name = $3 AND is_active = true`,
      [tenantId, accountId, name],
    );
    return result.rows[0] ?? null;
  }

  /** The account's default profile (resolution step 2), or null when none is set. */
  async findDefault(tenantId: string, accountId: string): Promise<CallAnalysisProfileRecord | null> {
    const pool = getPool();
    const result = await pool.query<CallAnalysisProfileRecord>(
      `SELECT * FROM call_analysis_profiles
       WHERE tenant_id = $1 AND account_id = $2 AND is_default = true AND is_active = true
       LIMIT 1`,
      [tenantId, accountId],
    );
    return result.rows[0] ?? null;
  }

  async listByTenant(
    tenantId: string,
    accountId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ rows: CallAnalysisProfileRecord[]; total: number }> {
    const pool = getPool();
    const countResult = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM call_analysis_profiles
       WHERE tenant_id = $1 AND account_id = $2 AND is_active = true`,
      [tenantId, accountId],
    );
    const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

    const result = await pool.query<CallAnalysisProfileRecord>(
      `SELECT * FROM call_analysis_profiles
       WHERE tenant_id = $1 AND account_id = $2 AND is_active = true
       ORDER BY created_at DESC, id DESC
       LIMIT $3 OFFSET $4`,
      [tenantId, accountId, limit, offset],
    );
    return { rows: result.rows, total };
  }

  /**
   * Copy-on-write versioning, mirroring prompt templates. INSERTs a new version
   * (version+1) carrying forward every unspecified field, then deactivates the old
   * row — in-flight jobs are unaffected because they carry a snapshot. Setting
   * `is_default` demotes the previous default in the same transaction. Scoped: a
   * row belonging to another tenant/account returns null (→ 404). Returns null when
   * the id doesn't exist or is already superseded (→ the route resolves a 409 +
   * successor id, like prompts).
   */
  async update(
    id: string,
    tenantId: string,
    accountId: string,
    input: UpdateCallAnalysisProfileInput,
  ): Promise<CallAnalysisProfileRecord | null> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the current active version scoped to the owner. A missing/superseded/
      // cross-tenant row yields null here → the caller signals a stale conflict.
      const existingResult = await client.query<CallAnalysisProfileRecord>(
        `SELECT * FROM call_analysis_profiles
         WHERE id = $1 AND tenant_id = $2 AND account_id = $3 AND is_active = true
         FOR UPDATE`,
        [id, tenantId, accountId],
      );
      const existing = existingResult.rows[0];
      if (!existing) {
        await client.query('ROLLBACK');
        return null;
      }

      const nextDefault = input.is_default ?? existing.is_default;
      if (nextDefault) {
        // Demote any other default (excluding this lineage's soon-to-be-inactive row).
        await client.query(
          `UPDATE call_analysis_profiles SET is_default = false
           WHERE tenant_id = $1 AND account_id = $2 AND is_default = true
             AND is_active = true AND id <> $3`,
          [tenantId, accountId, id],
        );
      }

      // Deactivate the old row BEFORE inserting the new version. The name unique
      // index `uq_analysis_profiles_name` is partial on `WHERE is_active` and does
      // NOT include `version`, so if the new active row were inserted first there
      // would momentarily be two is_active rows sharing (tenant, account, name) →
      // unique violation, rolling back the whole PUT on real Postgres. The old row
      // is already FOR UPDATE-locked in this transaction, so deactivating first is
      // safe and keeps the strict one-active-name-per-scope guarantee.
      await client.query(
        'UPDATE call_analysis_profiles SET is_active = false WHERE id = $1',
        [id],
      );

      const result = await client.query<CallAnalysisProfileRecord>(
        `INSERT INTO call_analysis_profiles (
          tenant_id, account_id, name, description, context,
          custom_dimensions, language_hint, is_default, version
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          existing.tenant_id,
          existing.account_id,
          existing.name,
          input.description ?? existing.description,
          input.context ?? existing.context,
          JSON.stringify(input.custom_dimensions ?? existing.custom_dimensions),
          input.language_hint ?? existing.language_hint,
          nextDefault,
          existing.version + 1,
        ],
      );

      await client.query('COMMIT');
      return result.rows[0]!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Resolve a superseded profile id to its active successor — same shape and
   * same-lineage guard as PromptRepository.findActiveSuccessor. Lets the PUT route
   * return the current version's id on a stale-write 409. Scoped by the dead row's
   * own tenant/account for the successor join, AND by the CALLER's tenant/account on
   * the lookup of the dead row.
   *
   * SECURITY DEVIATION from core (v1.123.2, which takes `id` alone): with only an id,
   * a caller sending another tenant's superseded profile id got a 409 carrying that
   * tenant's current profile id, and could tell 404 from 409. Not ported; flagged for a
   * later core fix. See PORTING.md.
   */
  async findActiveSuccessor(
    id: string,
    tenantId: string,
    accountId: string,
  ): Promise<CallAnalysisProfileRecord | null> {
    const pool = getPool();
    const result = await pool.query<CallAnalysisProfileRecord>(
      `SELECT active.*
       FROM call_analysis_profiles dead
       JOIN call_analysis_profiles active
         ON active.tenant_id = dead.tenant_id
        AND active.account_id = dead.account_id
        AND active.name = dead.name
        AND active.is_active = true
        AND active.version > dead.version
       WHERE dead.id = $1
         AND dead.tenant_id = $2
         AND dead.account_id = $3
         AND dead.is_active = false
       ORDER BY active.version DESC
       LIMIT 1`,
      [id, tenantId, accountId],
    );
    return result.rows[0] ?? null;
  }

  /** Soft delete. Scoped; jobs are self-contained (snapshot), so no reference guard. */
  async softDelete(id: string, tenantId: string, accountId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE call_analysis_profiles SET is_active = false
       WHERE id = $1 AND tenant_id = $2 AND account_id = $3 AND is_active = true`,
      [id, tenantId, accountId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

export const callAnalysisProfileRepository = new CallAnalysisProfileRepository();
