import { getPool } from '../connection.js';
import type {
  AccountConcurrencyAllocation,
  ConcurrencyAllocationMode,
  ProviderConcurrencyAllocation,
  ProviderConcurrencyAllocationRecord,
} from '../models/account-settings.model.js';

// Keep the operational fallback aligned with the database and platform UI.
const DEFAULT_MAX_CONCURRENT_CALLS = 5;

interface AllocationSettingsRow {
  tenant_id: string;
  account_id: string;
  max_concurrent_calls: number;
  concurrency_allocation_mode: ConcurrencyAllocationMode;
  concurrency_allocation_version: number;
}

export class ConcurrencyAllocationVersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Concurrency allocation version is stale; current version is ${currentVersion}`);
    this.name = 'ConcurrencyAllocationVersionConflictError';
  }
}

export class ProviderConcurrencyRepository {
  async getAllocation(tenantId: string, accountId: string): Promise<AccountConcurrencyAllocation> {
    const pool = getPool();
    // One statement gives the settings row and all children from one PostgreSQL
    // snapshot. Two pool.query calls can run on different connections and return
    // a version from one allocation with provider rows from another.
    const result = await pool.query<AllocationSettingsRow & { providers: ProviderConcurrencyAllocation[] }>(
      `SELECT s.tenant_id, s.account_id, s.max_concurrent_calls,
              s.concurrency_allocation_mode, s.concurrency_allocation_version,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'provider', p.telephony_provider,
                    'max_concurrent_calls', p.max_concurrent_calls
                  ) ORDER BY p.telephony_provider
                ) FILTER (WHERE p.telephony_provider IS NOT NULL),
                '[]'::jsonb
              ) AS providers
         FROM account_settings s
         LEFT JOIN account_provider_concurrency_allocations p
           ON p.tenant_id = s.tenant_id AND p.account_id = s.account_id
        WHERE s.tenant_id = $1 AND s.account_id = $2
        GROUP BY s.tenant_id, s.account_id, s.max_concurrent_calls,
                 s.concurrency_allocation_mode, s.concurrency_allocation_version`,
      [tenantId, accountId],
    );

    const settings = result.rows[0];
    return {
      tenant_id: tenantId,
      account_id: accountId,
      mode: settings?.concurrency_allocation_mode ?? 'legacy_total',
      version: settings?.concurrency_allocation_version ?? 1,
      total_concurrency: settings?.max_concurrent_calls ?? DEFAULT_MAX_CONCURRENT_CALLS,
      providers: settings?.providers ?? [],
    };
  }

  /**
   * Direct, uncached read used by the distributed provider guard. In legacy
   * mode provider admission is bypassed; in provider mode a missing row means
   * zero allocation and is therefore a deterministic configuration error.
   */
  async getProviderLimit(
    tenantId: string,
    accountId: string,
    provider: string,
  ): Promise<{
    mode: ConcurrencyAllocationMode;
    limit: number | null;
    total: number;
    version: number;
  }> {
    const pool = getPool();
    const result = await pool.query<{
      concurrency_allocation_mode: ConcurrencyAllocationMode;
      provider_limit: number | null;
      total_concurrency: number;
      concurrency_allocation_version: number;
    }>(
      `SELECT s.concurrency_allocation_mode,
              p.max_concurrent_calls AS provider_limit,
              s.max_concurrent_calls AS total_concurrency,
              s.concurrency_allocation_version
       FROM account_settings s
       LEFT JOIN account_provider_concurrency_allocations p
         ON p.tenant_id = s.tenant_id
        AND p.account_id = s.account_id
        AND p.telephony_provider = $3
       WHERE s.tenant_id = $1 AND s.account_id = $2`,
      [tenantId, accountId, provider],
    );

    const row = result.rows[0];
    if (!row) {
      return { mode: 'legacy_total', limit: null, total: DEFAULT_MAX_CONCURRENT_CALLS, version: 1 };
    }
    return {
      mode: row.concurrency_allocation_mode,
      limit: row.provider_limit,
      total: row.total_concurrency,
      version: row.concurrency_allocation_version,
    };
  }

  async replaceProviderBreakdown(input: {
    tenant_id: string;
    account_id: string;
    expected_version: number;
    providers: ProviderConcurrencyAllocation[];
  }): Promise<AccountConcurrencyAllocation> {
    const pool = getPool();
    const client = await pool.connect();
    const total = input.providers.reduce((sum, row) => sum + row.max_concurrent_calls, 0);

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO account_settings (
           tenant_id, account_id, max_concurrent_calls,
           concurrency_allocation_mode, concurrency_allocation_version
         ) VALUES ($1, $2, $3, 'legacy_total', 1)
         ON CONFLICT (tenant_id, account_id) DO NOTHING`,
        [input.tenant_id, input.account_id, DEFAULT_MAX_CONCURRENT_CALLS],
      );

      const locked = await client.query<AllocationSettingsRow>(
        `SELECT tenant_id, account_id, max_concurrent_calls,
                concurrency_allocation_mode, concurrency_allocation_version
         FROM account_settings
         WHERE tenant_id = $1 AND account_id = $2
         FOR UPDATE`,
        [input.tenant_id, input.account_id],
      );
      const settings = locked.rows[0]!;
      if (settings.concurrency_allocation_version !== input.expected_version) {
        throw new ConcurrencyAllocationVersionConflictError(
          settings.concurrency_allocation_version,
        );
      }

      await client.query(
        `DELETE FROM account_provider_concurrency_allocations
         WHERE tenant_id = $1 AND account_id = $2`,
        [input.tenant_id, input.account_id],
      );

      for (const row of input.providers) {
        await client.query(
          `INSERT INTO account_provider_concurrency_allocations (
             tenant_id, account_id, telephony_provider, max_concurrent_calls
           ) VALUES ($1, $2, $3, $4)`,
          [input.tenant_id, input.account_id, row.provider, row.max_concurrent_calls],
        );
      }

      const updated = await client.query<AllocationSettingsRow>(
        `UPDATE account_settings
         SET concurrency_allocation_mode = 'provider_breakdown',
             concurrency_allocation_version = concurrency_allocation_version + 1,
             max_concurrent_calls = $3,
             updated_at = NOW()
         WHERE tenant_id = $1 AND account_id = $2
         RETURNING tenant_id, account_id, max_concurrent_calls,
                   concurrency_allocation_mode, concurrency_allocation_version`,
        [input.tenant_id, input.account_id, total],
      );

      await client.query('COMMIT');
      const saved = updated.rows[0]!;
      return {
        tenant_id: saved.tenant_id,
        account_id: saved.account_id,
        mode: saved.concurrency_allocation_mode,
        version: saved.concurrency_allocation_version,
        total_concurrency: saved.max_concurrent_calls,
        providers: input.providers.map((row) => ({ ...row })),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async switchToLegacy(input: {
    tenant_id: string;
    account_id: string;
    expected_version: number;
    max_concurrent_calls: number;
  }): Promise<AccountConcurrencyAllocation> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO account_settings (
           tenant_id, account_id, max_concurrent_calls,
           concurrency_allocation_mode, concurrency_allocation_version
         ) VALUES ($1, $2, $3, 'legacy_total', 1)
         ON CONFLICT (tenant_id, account_id) DO NOTHING`,
        [input.tenant_id, input.account_id, input.max_concurrent_calls],
      );
      const locked = await client.query<AllocationSettingsRow>(
        `SELECT tenant_id, account_id, max_concurrent_calls,
                concurrency_allocation_mode, concurrency_allocation_version
           FROM account_settings
          WHERE tenant_id = $1 AND account_id = $2
          FOR UPDATE`,
        [input.tenant_id, input.account_id],
      );
      const current = locked.rows[0]!;
      if (current.concurrency_allocation_version !== input.expected_version) {
        throw new ConcurrencyAllocationVersionConflictError(
          current.concurrency_allocation_version,
        );
      }

      const result = await client.query<AllocationSettingsRow>(
        `UPDATE account_settings
         SET concurrency_allocation_mode = 'legacy_total',
             concurrency_allocation_version = concurrency_allocation_version + 1,
             max_concurrent_calls = $3,
             updated_at = NOW()
         WHERE tenant_id = $1 AND account_id = $2
         RETURNING tenant_id, account_id, max_concurrent_calls,
                   concurrency_allocation_mode, concurrency_allocation_version`,
        [input.tenant_id, input.account_id, input.max_concurrent_calls],
      );
      const preserved = await client.query<ProviderConcurrencyAllocationRecord>(
        `SELECT * FROM account_provider_concurrency_allocations
          WHERE tenant_id = $1 AND account_id = $2
          ORDER BY telephony_provider ASC`,
        [input.tenant_id, input.account_id],
      );
      await client.query('COMMIT');
      const settings = result.rows[0]!;
      return {
        tenant_id: settings.tenant_id,
        account_id: settings.account_id,
        mode: settings.concurrency_allocation_mode,
        version: settings.concurrency_allocation_version,
        total_concurrency: settings.max_concurrent_calls,
        // Preserve the last provider snapshot for diagnosis and safe re-enable.
        providers: preserved.rows.map((row) => ({
          provider: row.telephony_provider,
          max_concurrent_calls: row.max_concurrent_calls,
        })),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

}

export const providerConcurrencyRepository = new ProviderConcurrencyRepository();
