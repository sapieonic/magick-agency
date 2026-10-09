import { getPool } from '../connection.js';
import { TtlCache } from '../utils/ttl-cache.js';
import type { AccountSettingsRecord, UpsertAccountSettingsInput } from '../models/account-settings.model.js';

const DEFAULT_MAX_CONCURRENT_CALLS = 5;
const CACHE_TTL_MS = 60_000;

export class AccountSettingsRepository {
  /**
   * Read-through cache for the per-(tenant, account) settings row, covering the
   * per-call reads of `allow_recording` (call start), `analyze_calls` (call
   * end), and `default_ai_pipeline` (inbound) via {@link findByTenantAndAccount}.
   * Caching the whole row collapses repeated same-account reads into one DB read
   * per TTL. Negative (`null`, i.e. no row) results are cached too so a
   * defaults-only account doesn't re-query every call. Seeded write-through on
   * {@link upsert}.
   *
   * NOTE: {@link getMaxConcurrentCalls} deliberately does NOT use this cache —
   * see its doc for why (it would defeat the guard's cross-replica Redis limit
   * invalidation).
   *
   * In-process, so a change on another replica is visible within one TTL — the
   * same trade-off as the prompt/messaging/SIP registries. `allow_recording`
   * (recording-consent gate) therefore has up to one TTL of cross-replica
   * propagation lag on non-writing replicas; the writing replica is immediate
   * via the write-through above.
   *
   * PORT NOTE (magick-agency): `default_ai_pipeline` (AI pipeline selection) and
   * `analyze_dialer_calls` (the softphone-only gate 3, decision Q3b) are not
   * columns here, so their readers are gone; `webrtc_max_duration_seconds` (plan
   * §3.2) is read through this cache by {@link getWebrtcMaxDurationSeconds}.
   */
  private cache = new TtlCache<AccountSettingsRecord | null>({
    ttlMs: CACHE_TTL_MS,
    maxEntries: 10_000,
    name: 'account-settings',
  });

  private cacheKey(tenantId: string, accountId: string): string {
    return `${tenantId}:${accountId}`;
  }

  /** Drop the cached row for a (tenant, account). */
  invalidate(tenantId: string, accountId: string): void {
    this.cache.invalidate(this.cacheKey(tenantId, accountId));
  }

  /** Flush the entire row cache. Useful for tests and operational cache resets. */
  clearCache(): void {
    this.cache.clear();
  }

  async upsert(input: UpsertAccountSettingsInput): Promise<AccountSettingsRecord> {
    const pool = getPool();
    // On update a NULL ($4/$5) is treated as "no change" via COALESCE, so a caller
    // updating only max_concurrent_calls never clobbers an existing toggle.
    // (PORT NOTE: core's `default_ai_pipeline` and `analyze_dialer_calls` are not
    // carried — AI pipeline selection and decision Q3b.)
    const result = await pool.query<AccountSettingsRecord>(
      `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls, analyze_calls, allow_recording)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, account_id)
       DO UPDATE SET
         max_concurrent_calls = CASE
           WHEN account_settings.concurrency_allocation_mode = 'legacy_total' THEN $3
           ELSE account_settings.max_concurrent_calls
         END,
         concurrency_allocation_version = CASE
           WHEN account_settings.concurrency_allocation_mode = 'legacy_total'
                AND account_settings.max_concurrent_calls IS DISTINCT FROM $3
             THEN account_settings.concurrency_allocation_version + 1
           ELSE account_settings.concurrency_allocation_version
         END,
         analyze_calls = COALESCE($4, account_settings.analyze_calls),
         allow_recording = COALESCE($5, account_settings.allow_recording),
         updated_at = NOW()
       RETURNING *`,
      [
        input.tenant_id,
        input.account_id,
        input.max_concurrent_calls,
        input.analyze_calls ?? null,
        input.allow_recording ?? null,
      ]
    );
    const record = result.rows[0]!;
    // Write-through: seed the cache with the fresh row so the next read on this
    // replica sees the update immediately rather than a stale cached value.
    this.cache.set(this.cacheKey(record.tenant_id, record.account_id), record);
    return record;
  }

  /**
   * Set the account's cap on a bridged call's length, in seconds, creating the
   * row (at the column defaults for everything else) when the account has none.
   *
   * PORT NOTE (magick-agency): added, no core source — the WRITER half of
   * {@link getWebrtcMaxDurationSeconds} (plan §3.2 moves core's
   * `webrtc_max_duration_seconds` flag onto this row). Its one caller is the
   * super-admin per-account settings route, which enforces core's flag bound
   * (60..14400) before it gets here. Touches ONLY this column (and
   * `updated_at`): concurrency and the two toggles keep their values, so it
   * cannot race {@link upsert}'s `CASE` over the allocation mode. Same
   * write-through as {@link upsert}, so the next read on this replica sees it.
   */
  async setWebrtcMaxDurationSeconds(
    tenantId: string,
    accountId: string,
    seconds: number,
  ): Promise<AccountSettingsRecord> {
    const pool = getPool();
    const result = await pool.query<AccountSettingsRecord>(
      `INSERT INTO account_settings (tenant_id, account_id, webrtc_max_duration_seconds)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, account_id)
       DO UPDATE SET
         webrtc_max_duration_seconds = EXCLUDED.webrtc_max_duration_seconds,
         updated_at = NOW()
       RETURNING *`,
      [tenantId, accountId, seconds],
    );
    const record = result.rows[0]!;
    this.cache.set(this.cacheKey(record.tenant_id, record.account_id), record);
    return record;
  }

  /**
   * Set the account's recording / analysis toggles, creating the row (at the
   * column defaults for everything else) when the account has none. A `null` or
   * omitted toggle keeps its stored value (COALESCE, as {@link upsert} does).
   *
   * PORT NOTE (magick-agency): added, no core source (authorised by the lead).
   * Core's tenant-facing `PUT /api/v1/account-settings` wrote the toggles through
   * {@link upsert}, passing back the concurrency it had just read. In legacy_total
   * mode that rewrites `max_concurrent_calls` and bumps the allocation version,
   * so a concurrency write committing between the read and the upsert was
   * silently undone, past the version lock. This statement names only the two
   * toggles (and `updated_at`), so it cannot touch concurrency at all. Same
   * write-through as {@link upsert}.
   */
  async setRecordingAnalysisToggles(
    tenantId: string,
    accountId: string,
    toggles: { allow_recording?: boolean | null; analyze_calls?: boolean | null },
  ): Promise<AccountSettingsRecord> {
    const pool = getPool();
    const result = await pool.query<AccountSettingsRecord>(
      `INSERT INTO account_settings (tenant_id, account_id, allow_recording, analyze_calls)
       VALUES ($1, $2, $3::boolean, $4::boolean)
       ON CONFLICT (tenant_id, account_id)
       DO UPDATE SET
         allow_recording = COALESCE($3::boolean, account_settings.allow_recording),
         analyze_calls = COALESCE($4::boolean, account_settings.analyze_calls),
         updated_at = NOW()
       RETURNING *`,
      [tenantId, accountId, toggles.allow_recording ?? null, toggles.analyze_calls ?? null],
    );
    const record = result.rows[0]!;
    this.cache.set(this.cacheKey(record.tenant_id, record.account_id), record);
    return record;
  }

  async findByTenantAndAccount(tenantId: string, accountId: string): Promise<AccountSettingsRecord | null> {
    return this.cache.getOrLoad(this.cacheKey(tenantId, accountId), async () => {
      const pool = getPool();
      const result = await pool.query<AccountSettingsRecord>(
        `SELECT * FROM account_settings WHERE tenant_id = $1 AND account_id = $2`,
        [tenantId, accountId]
      );
      return result.rows[0] || null;
    });
  }

  /**
   * The per-account concurrency limit. Read **directly from the DB, bypassing
   * the in-process row cache**, because `AccountConcurrencyGuard` fronts this
   * with its own cross-replica Redis limit cache and invalidates that Redis key
   * on a settings change (`invalidateLimit`). If this read went through the
   * in-process cache, a replica that hadn't seen the update would serve a stale
   * limit and re-populate the shared Redis cache with it, silently defeating the
   * cross-replica invalidation. The guard only calls this on its own Redis miss
   * (~once per TTL per account per replica), so the extra point-lookup is cheap.
   */
  async getMaxConcurrentCalls(tenantId: string, accountId: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query<AccountSettingsRecord>(
      `SELECT max_concurrent_calls FROM account_settings WHERE tenant_id = $1 AND account_id = $2`,
      [tenantId, accountId]
    );
    return result.rows[0]?.max_concurrent_calls ?? DEFAULT_MAX_CONCURRENT_CALLS;
  }

  /**
   * The account-level post-call-analysis toggle, or null when unset (row absent
   * or column NULL). The caller applies the env default on null. Dumb column read.
   */
  async getAnalyzeCalls(tenantId: string, accountId: string): Promise<boolean | null> {
    const settings = await this.findByTenantAndAccount(tenantId, accountId);
    return settings?.analyze_calls ?? null;
  }

  /**
   * The account-level recording ceiling, or null when unset (row absent or column
   * NULL). The caller applies the env default on null. Dumb column read.
   */
  async getAllowRecording(tenantId: string, accountId: string): Promise<boolean | null> {
    const settings = await this.findByTenantAndAccount(tenantId, accountId);
    return settings?.allow_recording ?? null;
  }

  /**
   * The account-level cap on a bridged call's length in seconds, or null when
   * unset (row absent or column NULL). The caller applies the process default on
   * null. Dumb column read.
   *
   * PORT NOTE (magick-agency): added, no core source. Plan §3.2 folds core's
   * `webrtc_max_duration_seconds` feature flag into this per-account row
   * (baseline column `account_settings.webrtc_max_duration_seconds`).
   */
  async getWebrtcMaxDurationSeconds(tenantId: string, accountId: string): Promise<number | null> {
    const settings = await this.findByTenantAndAccount(tenantId, accountId);
    return settings?.webrtc_max_duration_seconds ?? null;
  }

  async listByTenant(tenantId: string): Promise<AccountSettingsRecord[]> {
    const pool = getPool();
    const result = await pool.query<AccountSettingsRecord>(
      `SELECT * FROM account_settings WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId]
    );
    return result.rows;
  }
}

export const accountSettingsRepository = new AccountSettingsRepository();
