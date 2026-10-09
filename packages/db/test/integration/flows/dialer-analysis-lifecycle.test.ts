import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertWebrtcCall } from '../setup/factories.js';
/*
 * Real Postgres. Rows live in `agency_calls`; ids come from the UUID
 * factories. There is no settlement: the case ends at the completed job with `analysis_audio_seconds` recorded and no settlement column.
 */
vi.mock('../../../src/connection.js', () => ({ getPool: () => getTestPool() }));
const { dialerAnalysisJobRepository: jobs } = await import('../../../src/repositories/dialer-analysis-job.repository.js');

describe('dialer analysis lifecycle scenario', () => {
  beforeEach(truncateAll); afterAll(closeTestPool);
  it('moves recording-ready work through transcript-before-analysis completion', async () => {
    const call = await insertWebrtcCall({ recording_url: null, recording_duration_seconds: 90, talk_time_seconds: 90 });
    const job = (await jobs.enqueueFromCall({ call_id: call.id, profile_snapshot: { custom_dimensions: [] } }))!;
    expect(job.status).toBe('awaiting_recording');
    await getTestPool().query(`UPDATE agency_calls SET recording_url = 'https://rec.example/a.wav' WHERE id = $1`, [call.id]);
    await jobs.markRecordingReady(call.id, 0);
    const [claim] = await jobs.claimRunnable(1);
    const transcript = { conversation_log: [{ role: 'agent' as const, content: 'hello', start_seconds: 0, end_seconds: 80 }], transcript_meta: { provider: 'gemini' as const, model: 'fake', detected_language: 'en', duration_seconds: 80, turn_count: 1, latency_ms: 1, transcribed_at: new Date().toISOString() } };
    expect(await jobs.persistTranscript(job.id, call.id, claim!.claim_generation, transcript)).toBe(true);
    const beforeAnalysis = await getTestPool().query(`SELECT conversation_log, call_analysis FROM agency_calls WHERE id = $1`, [call.id]);
    expect(beforeAnalysis.rows[0]).toMatchObject({ conversation_log: transcript.conversation_log, call_analysis: null });
    await jobs.markAnalyzing(job.id, claim!.claim_generation);
    const analysis = { common: { overall_sentiment: { label: 'positive', score: 1 }, turn_sentiments: [], key_topics: [], conversation_quality: { coherence: 1, resolution_achieved: true, effectiveness_score: 1 }, summary: 'summary' }, custom: {}, _meta: { model: 'fake', provider: 'fake', latency_ms: 1, analyzed_at: new Date().toISOString() } } as any;
    expect(await jobs.completeWithAnalysis(job.id, call.id, claim!.claim_generation, { call_analysis: analysis, analysis_audio_seconds: 80 })).toBe(true);
    const complete = await jobs.findById(job.id);
    expect(complete).toMatchObject({ status: 'completed', analysis_audio_seconds: 80 });
    expect(complete).not.toHaveProperty('settlement_status');
    expect((await getTestPool().query(`SELECT analysis_status FROM agency_calls WHERE id = $1`, [call.id])).rows[0]!.analysis_status).toBe('completed');
  });
});
