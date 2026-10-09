import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertWebrtcCall } from '../setup/factories.js';

/*
 * PORT NOTE (magick-agency): ported from core test/integration/db/dialer-analysis-migration.test.ts
 * @4850d1d9 (5 cases -> 6), against the squashed BASELINE instead of migration 059. Modified:
 * the first case checks the baseline's columns (8 analysis columns on `agency_calls`,
 * `dialer_analysis_jobs.call_id` NOT NULL, `analysis_audio_seconds` kept) and that the
 * settlement columns and `account_settings.analyze_dialer_calls` are NOT there; ids are
 * UUIDs; the profile names carry the factory tenant/account. New: the settlement
 * constraint / index and the dropped columns are asserted gone.
 */
const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;

describe('dialer-analysis baseline (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('creates the required tables and analysis columns, keeps analysis_audio_seconds, drops settlement', async () => {
    const { rows } = await getTestPool().query<{ table_name: string; column_name: string; is_nullable: string; data_type: string }>(
      `SELECT table_name, column_name, is_nullable, data_type FROM information_schema.columns
       WHERE (table_name = 'dialer_analysis_jobs' AND column_name IN ('call_id', 'status', 'analysis_audio_seconds', 'claim_generation'))
          OR (table_name = 'agency_calls' AND column_name IN ('analysis_profile_id', 'analysis_language', 'analysis_status', 'call_analysis', 'conversation_log', 'transcript_meta', 'analysis_consent', 'analysis_consent_at'))`,
    );
    expect(rows.filter((row) => row.table_name === 'agency_calls')).toHaveLength(8);
    expect(rows).toContainEqual(expect.objectContaining({ table_name: 'dialer_analysis_jobs', column_name: 'call_id', is_nullable: 'NO' }));
    expect(rows).toContainEqual(expect.objectContaining({ table_name: 'dialer_analysis_jobs', column_name: 'analysis_audio_seconds', data_type: 'integer' }));
    const gone = await getTestPool().query(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE column_name LIKE 'settlement%' OR (table_name = 'account_settings' AND column_name = 'analyze_dialer_calls')`,
    );
    expect(gone.rows).toEqual([]);
    const idx = await getTestPool().query(`SELECT indexname FROM pg_indexes WHERE tablename = 'dialer_analysis_jobs'`);
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([
      'dialer_analysis_jobs_pkey', 'idx_dialer_analysis_jobs_runnable', 'idx_dialer_analysis_jobs_stale', 'uq_dialer_analysis_jobs_call',
    ]);
  });

  it('cascades job deletion when its agency call is deleted', async () => {
    const call = await insertWebrtcCall();
    await getTestPool().query(`INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3)`, [call.id, T, A]);
    await getTestPool().query('DELETE FROM agency_calls WHERE id = $1', [call.id]);
    const { rows } = await getTestPool().query('SELECT * FROM dialer_analysis_jobs WHERE call_id = $1', [call.id]);
    expect(rows).toEqual([]);
  });

  it('enforces status checks and one job per call', async () => {
    const call = await insertWebrtcCall();
    await expect(getTestPool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, status) VALUES ($1, $2, $3, 'bogus')`,
      [call.id, T, A],
    )).rejects.toMatchObject({ code: '23514' });
    await expect(getTestPool().query(`UPDATE agency_calls SET analysis_status = 'bogus' WHERE id = $1`, [call.id]))
      .rejects.toMatchObject({ code: '23514' });

    await getTestPool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3)`,
      [call.id, T, A],
    );
    await expect(getTestPool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3)`,
      [call.id, T, A],
    )).rejects.toMatchObject({ code: '23505' });
  });

  it('a job defaults to awaiting_recording with zeroed counters', async () => {
    const call = await insertWebrtcCall();
    const { rows } = await getTestPool().query(
      `INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3) RETURNING *`,
      [call.id, T, A],
    );
    expect(rows[0]).toMatchObject({ status: 'awaiting_recording', attempts: 0, attempts_total: 0, claim_generation: 0, analysis_audio_seconds: null });
  });

  it('enforces partial active-name/default uniqueness and allows name reuse after soft delete', async () => {
    const pool = getTestPool();
    const first = await pool.query(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name, is_default) VALUES ($1, $2, 'Same', true) RETURNING id`, [T, A]);
    await expect(pool.query(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name) VALUES ($1, $2, 'Same')`, [T, A])).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name, is_default) VALUES ($1, $2, 'Other', true)`, [T, A])).rejects.toMatchObject({ code: '23505' });
    await pool.query(`UPDATE call_analysis_profiles SET is_active = false WHERE id = $1`, [first.rows[0]!.id]);
    await expect(pool.query(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name) VALUES ($1, $2, 'Same')`, [T, A])).resolves.toBeDefined();
  });

  it('updates updated_at through both triggers', async () => {
    const call = await insertWebrtcCall();
    const pool = getTestPool();
    const job = await pool.query(`INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3) RETURNING id`, [call.id, T, A]);
    await pool.query(`UPDATE dialer_analysis_jobs SET updated_at = now() - interval '1 hour' WHERE id = $1`, [job.rows[0]!.id]);
    await pool.query(`UPDATE dialer_analysis_jobs SET error_code = 'X' WHERE id = $1`, [job.rows[0]!.id]);
    const { rows } = await pool.query<{ updated_at: Date }>('SELECT updated_at FROM dialer_analysis_jobs WHERE id = $1', [job.rows[0]!.id]);
    expect(rows[0]!.updated_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
