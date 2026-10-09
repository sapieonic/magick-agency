import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, insertWebrtcCall } from '../setup/factories.js';
/*
 * Real Postgres. Rows live in `agency_calls`; ids come from the UUID
 * factories. The seeded profile row uses the factory tenant/account UUIDs and a UUID id.
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

describe('dialer analysis gating and snapshots', () => {
  beforeEach(truncateAll); afterAll(closeTestPool);
  it('keeps availability-gated calls NULL while eligible calls enqueue and profile snapshots survive deactivation', async () => {
    const unavailable = await insertWebrtcCall({ analysis_status: null });
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [unavailable.id])).rows[0]!.analysis_status).toBeNull();
    const call = await insertWebrtcCall({ recording_url: 'https://rec.example/a.wav' });
    const snapshot = { context: 'collections', language_hint: 'hi-IN', custom_dimensions: [{ key: 'promised', description: 'x', type: 'boolean' as const }] };
    const job = (await jobs.enqueueFromCall({ call_id: call.id, profile_id: '00000000-0000-0000-0000-000000000001', profile_snapshot: snapshot }))!;
    await getTestPool().query(`INSERT INTO call_analysis_profiles (id, tenant_id, account_id, name, is_active) VALUES ('00000000-0000-0000-0000-000000000001', $1, $2, 'Profile', false)`, [DEFAULTS.tenantId, DEFAULTS.accountId]);
    expect((await jobs.findById(job.id))!.profile_snapshot).toEqual(snapshot);
    expect((await jobs.findById(job.id))!.status).toBe('queued');
  });

  it('represents no recording as awaiting rather than silently skipping, then expires explicitly', async () => {
    const call = await insertWebrtcCall({ recording_url: null });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    expect(job.status).toBe('awaiting_recording');
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    await jobs.expireAwaitingRecording(new Date());
    expect((await jobs.findById(job.id))!.status).toBe('expired');
  });
});
