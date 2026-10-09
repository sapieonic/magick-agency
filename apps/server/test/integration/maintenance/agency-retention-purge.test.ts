import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { DEFAULTS, insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';

/*
 * PORT NOTE (magick-agency): ported from core test/integration/db/dialer-retention-purge.test.ts
 * @4850d1d9 (2 cases -> 6), real Postgres 5436, against the agency slice of the purge
 * (`runRetentionPurge()` reads `AGENCY_RETENTION_DAYS` / `AGENCY_TRANSCRIPT_RETENTION_DAYS`).
 * The Phase 7 exit gate is here: the transcript (`conversation_log` AND `transcript_meta`)
 * is nulled at the transcript-retention day while the analysis (`call_analysis`,
 * `analysis_status`) survives to row expiry, and a LATER purge at the row window then
 * deletes the row and its job. Same two cases as core, plus the unset-window,
 * dry-run, and batch cases.
 */
const cfg = vi.hoisted(() => ({
  config: {
    server: { env: 'test' },
    retention: { minDays: 30, agencyRetentionDays: undefined as number | undefined, agencyTranscriptRetentionDays: undefined as number | undefined },
  },
}));
vi.mock('../../../src/config/index.js', () => cfg);
const { runRetentionPurge } = await import('../../../src/maintenance/retention-purge.js');

const analysis = () => JSON.stringify({ common: { overall_sentiment: { label: 'positive' }, summary: 'keep this summary' } });
const transcript = (c: string) => JSON.stringify([{ role: 'agent', content: c }]);
const meta = () => JSON.stringify({ provider: 'gemini', source_url: 'https://rec.example/x.mp3' });

describe('agency retention purge (integration)', () => {
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 }); });
  beforeEach(async () => {
    await truncateAll();
    cfg.config.retention.agencyRetentionDays = undefined;
    cfg.config.retention.agencyTranscriptRetentionDays = undefined;
  });
  afterEach(() => undefined);
  afterAll(async () => { await closePool(); await closeTestPool(); });

  async function age(id: string, days: number) {
    await getTestPool().query(`UPDATE agency_calls SET created_at = now() - make_interval(days => $2) WHERE id = $1`, [id, days]);
  }

  it('purges old jobs before old calls while preserving recent rows', async () => {
    cfg.config.retention.agencyRetentionDays = 85;
    const old = await insertWebrtcCall();
    const recent = await insertWebrtcCall();
    const pool = getTestPool();
    await pool.query(`INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3)`, [old.id, DEFAULTS.tenantId, DEFAULTS.accountId]);
    await pool.query(`INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id) VALUES ($1, $2, $3)`, [recent.id, DEFAULTS.tenantId, DEFAULTS.accountId]);
    await age(old.id, 90);
    await pool.query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '90 days' WHERE call_id = $1`, [old.id]);

    const report = await runRetentionPurge();

    expect(report.error).toBeUndefined();
    expect(report.tables['dialer_analysis_jobs']).toBe(1);
    expect(report.tables['agency_calls']).toBe(1);
    expect((await pool.query(`SELECT id FROM agency_calls WHERE id = $1`, [old.id])).rows).toEqual([]);
    expect((await pool.query(`SELECT id FROM agency_calls WHERE id = $1`, [recent.id])).rows).toHaveLength(1);
    expect((await pool.query(`SELECT 1 FROM dialer_analysis_jobs WHERE call_id = $1`, [recent.id])).rows).toHaveLength(1);
  });

  it('nulls only aged transcripts (and their provenance) while the analysis and the row survive', async () => {
    cfg.config.retention.agencyTranscriptRetentionDays = 30;
    const oldT = await insertWebrtcCall({ conversation_log: transcript('erase transcript'), transcript_meta: meta(), call_analysis: analysis(), analysis_status: 'completed' });
    const recentT = await insertWebrtcCall({ conversation_log: transcript('keep transcript'), transcript_meta: meta(), call_analysis: analysis(), analysis_status: 'completed' });
    await age(oldT.id, 31);

    const report = await runRetentionPurge();

    expect(report.agency_transcripts_nulled).toBe(1);
    const pool = getTestPool();
    const o = (await pool.query(`SELECT conversation_log, transcript_meta, call_analysis, analysis_status FROM agency_calls WHERE id = $1`, [oldT.id])).rows[0]!;
    expect(o).toMatchObject({ conversation_log: null, transcript_meta: null, analysis_status: 'completed' });
    expect(o.call_analysis).toMatchObject({ common: { overall_sentiment: { label: 'positive' }, summary: 'keep this summary' } });
    const r = (await pool.query(`SELECT conversation_log, transcript_meta FROM agency_calls WHERE id = $1`, [recentT.id])).rows[0]!;
    expect(r.conversation_log).not.toBeNull();
    expect(r.transcript_meta).not.toBeNull();
  });

  it('EXIT GATE: transcript nulled at the transcript day, analysis survives to row expiry, then the row goes', async () => {
    const call = await insertWebrtcCall({ conversation_log: transcript('t'), transcript_meta: meta(), call_analysis: analysis(), analysis_status: 'completed' });
    await getTestPool().query(`INSERT INTO dialer_analysis_jobs (call_id, tenant_id, account_id, status, analysis_audio_seconds) VALUES ($1, $2, $3, 'completed', 80)`, [call.id, DEFAULTS.tenantId, DEFAULTS.accountId]);
    cfg.config.retention.agencyRetentionDays = 400;
    cfg.config.retention.agencyTranscriptRetentionDays = 30;
    const pool = getTestPool();

    // Day 29: nothing yet.
    await age(call.id, 29);
    await runRetentionPurge();
    expect((await pool.query(`SELECT conversation_log FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!.conversation_log).not.toBeNull();

    // Day 31: transcript gone, analysis + row + job stay.
    await age(call.id, 31);
    await runRetentionPurge();
    let row = (await pool.query(`SELECT conversation_log, transcript_meta, call_analysis FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!;
    expect(row.conversation_log).toBeNull();
    expect(row.transcript_meta).toBeNull();
    expect(row.call_analysis.common.summary).toBe('keep this summary');
    expect((await pool.query(`SELECT analysis_audio_seconds FROM dialer_analysis_jobs WHERE call_id = $1`, [call.id])).rows[0]!.analysis_audio_seconds).toBe(80);

    // Day 399: analysis still there.
    await age(call.id, 399);
    await runRetentionPurge();
    row = (await pool.query(`SELECT call_analysis FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!;
    expect(row.call_analysis).not.toBeNull();

    // Day 401: row expiry takes the call and its job.
    await age(call.id, 401);
    await pool.query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '401 days' WHERE call_id = $1`, [call.id]);
    await runRetentionPurge();
    expect((await pool.query(`SELECT 1 FROM agency_calls WHERE id = $1`, [call.id])).rows).toEqual([]);
    expect((await pool.query(`SELECT 1 FROM dialer_analysis_jobs WHERE call_id = $1`, [call.id])).rows).toEqual([]);
  });

  it('with no window configured nothing is deleted or nulled', async () => {
    const call = await insertWebrtcCall({ conversation_log: transcript('t'), call_analysis: analysis() });
    await age(call.id, 3000);
    const report = await runRetentionPurge();
    expect(report.tables).toEqual({});
    expect((await getTestPool().query(`SELECT conversation_log FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!.conversation_log).not.toBeNull();
  });

  it('dry run counts but changes nothing', async () => {
    cfg.config.retention.agencyRetentionDays = 85;
    cfg.config.retention.agencyTranscriptRetentionDays = 30;
    const call = await insertWebrtcCall({ conversation_log: transcript('t'), transcript_meta: meta(), call_analysis: analysis() });
    await age(call.id, 90);
    const report = await runRetentionPurge({ dryRun: true });
    expect(report.tables['agency_calls']).toBe(1);
    expect(report.agency_transcripts_nulled).toBe(1);
    const row = (await getTestPool().query(`SELECT conversation_log FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!;
    expect(row.conversation_log).not.toBeNull();
  });

  it('a clean row (no transcript) is not touched by the transcript step', async () => {
    cfg.config.retention.agencyTranscriptRetentionDays = 30;
    const call = await insertWebrtcCall({ call_analysis: analysis() });
    await age(call.id, 100);
    expect((await runRetentionPurge()).agency_transcripts_nulled).toBe(0);
  });
});
