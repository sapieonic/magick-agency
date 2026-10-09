import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { dialerAnalysisJobRepository as jobs } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';

/*
 * The runner and worker are unit-tested against mocked repositories and the flow tests
 * drive the repository by hand; nothing else runs the WORKER and RUNNER over the real job
 * table. This does, with the REAL recording fetcher (only
 * global `fetch` is stubbed) and fake transcriber / analysis service (Gemini, Sarvam and
 * OpenAI are never called). Cases: skip, resume, truncation-retry and
 * backoff on real rows, `analysis_audio_seconds` recorded, off-list recording host a
 * permanent failure. "One real recording transcribed and analysed on the pilot account" is
 * NOT attempted (no vendor account; see docs/seams.md).
 */
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { DialerAnalysisWorker } = await import('../../../src/core/dialer-analysis-worker.js');
type Cfg = ConstructorParameters<typeof DialerAnalysisWorker>[0]['config'];

const HOST = 'recordings.voicelink.test';
const URL_OK = `https://${HOST}/r/a.mp3`;
const CFG = {
  enabled: true, transcriber: 'gemini', geminiModel: 'g', geminiApiKey: 'k',
  transcribeTimeoutMs: 5000, transcribeWindowSeconds: 600, transcribeMaxOutputTokens: 16384, maxRecordingBytes: 1_000_000,
  minTalkTimeSeconds: 10, recordingWaitMinutes: 30, maxAttempts: 3, maxAttemptsTotal: 8, concurrency: 2,
  pollIntervalMs: 60000, settleSeconds: 0, recordingFetchRetries: 0, recordingFetchRetryDelaySeconds: 1,
} as unknown as Cfg;

const ANALYSIS = {
  common: { overall_sentiment: { label: 'positive', score: 0.9 }, turn_sentiments: [], key_topics: ['x'], conversation_quality: { coherence: 8, resolution_achieved: true, effectiveness_score: 7 }, summary: 'the summary' },
  custom: { ptp: true },
  _meta: { model: 'fake', provider: 'openai', latency_ms: 1, prompt_tokens: 1, completion_tokens: 1, analyzed_at: new Date().toISOString() },
};
const ENTRIES = (end: number) => [
  { role: 'agent' as const, content: 'hello', start_seconds: 0, end_seconds: end / 2 },
  { role: 'customer' as const, content: 'hi', start_seconds: end / 2, end_seconds: end },
];

function makeTranscriber(over: Partial<{ entries: unknown[]; durationSeconds: number }> = {}) {
  return {
    provider: 'gemini' as const,
    transcribe: vi.fn().mockResolvedValue({
      entries: over.entries ?? ENTRIES(95), detectedLanguage: 'en', durationSeconds: over.durationSeconds ?? 95, model: 'fake', diarizationFailed: false,
    }),
  };
}
const analysisService = () => ({ analyze: vi.fn().mockResolvedValue(ANALYSIS) });

function worker(transcriber = makeTranscriber(), svc = analysisService(), hosts: readonly string[] = [HOST]) {
  return { transcriber, svc, w: new DialerAnalysisWorker({ transcriber: transcriber as never, analysisService: svc as never, config: CFG, recordingHosts: hosts }) };
}
async function newCall(over: Record<string, unknown> = {}) {
  const call = await insertWebrtcCall({ recording_url: URL_OK, recording_duration_seconds: 100, talk_time_seconds: 100, ...over });
  const job = (await jobs.enqueueFromCall({ call_id: call.id, profile_snapshot: { context: 'ctx', custom_dimensions: [{ key: 'ptp', description: 'd', type: 'boolean' }] } }))!;
  return { call, job };
}
const callRow = async (id: string) => (await getTestPool().query(`SELECT * FROM agency_calls WHERE id = $1`, [id])).rows[0]!;
const stubAudio = () => vi.stubGlobal('fetch', vi.fn(async () => new Response(Buffer.from('mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } })));

describe('dialer analysis pipeline over real Postgres', () => {
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 }); });
  beforeEach(async () => { await truncateAll(); stubAudio(); });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await closePool(); await closeTestPool(); });

  it('happy path: sweep claims, fetches, transcribes, analyses and completes; analysis_audio_seconds is recorded', async () => {
    const { call, job } = await newCall();
    const { w, transcriber, svc } = worker();

    expect(await w.sweepOnce()).toBe(true);

    const done = (await jobs.findById(job.id))!;
    // analysis_audio_seconds = min(recording duration 100, transcriber duration 95).
    expect(done).toMatchObject({ status: 'completed', analysis_audio_seconds: 95, attempts: 1, error_code: null });
    const row = await callRow(call.id);
    expect(row.analysis_status).toBe('completed');
    expect(row.conversation_log).toHaveLength(2);
    expect(row.transcript_meta).toMatchObject({ provider: 'gemini', model: 'fake', source_url: URL_OK, turn_count: 2 });
    expect(row.call_analysis.common.summary).toBe('the summary');
    // The snapshot, not a live profile, reached the analysis service.
    expect(svc.analyze.mock.calls[0]![2]).toEqual({ custom_dimensions: [{ key: 'ptp', description: 'd', type: 'boolean' }] });
    expect(svc.analyze.mock.calls[0]![3]).toEqual({ context: 'ctx' });
    // The fetch carried no credentials and followed no redirect automatically.
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.headers).toBeUndefined();
    expect(init.redirect).toBe('manual');
    expect(transcriber.transcribe).toHaveBeenCalledOnce();
    await w.gracefulShutdown();
  });

  it('a recording that arrives later is promoted by the sweep before it can expire', async () => {
    const call = await insertWebrtcCall({ recording_url: null, recording_duration_seconds: 100 });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    expect(job.status).toBe('awaiting_recording');
    await getTestPool().query(`UPDATE agency_calls SET recording_url = $2 WHERE id = $1`, [call.id, URL_OK]);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET created_at = now() - interval '2 hours' WHERE id = $1`, [job.id]);
    const { w } = worker();
    await w.sweepOnce();
    expect((await jobs.findById(job.id))!.status).toBe('completed');
    await w.gracefulShutdown();
  });

  it('SKIP: a silent recording is skipped, not failed, and nothing is retried', async () => {
    const { call, job } = await newCall();
    const { w, svc } = worker(makeTranscriber({ entries: [], durationSeconds: 0 }));
    await w.sweepOnce();
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'skipped', error_code: 'TRANSCRIPTION_EMPTY' });
    expect((await callRow(call.id)).analysis_status).toBe('skipped');
    expect(svc.analyze).not.toHaveBeenCalled();
    await w.gracefulShutdown();
  });

  it('SKIP: an already-analysed call is skipped ALREADY_ANALYSED', async () => {
    const { call, job } = await newCall();
    await getTestPool().query(`UPDATE agency_calls SET analysis_status = 'completed' WHERE id = $1`, [call.id]);
    const { w, transcriber } = worker();
    await w.sweepOnce();
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'skipped', error_code: 'ALREADY_ANALYSED' });
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    await w.gracefulShutdown();
  });

  it('RESUME: a persisted transcript is analysed without fetching or transcribing again', async () => {
    const { call, job } = await newCall();
    await getTestPool().query(
      `UPDATE agency_calls SET conversation_log = $2::jsonb, transcript_meta = $3::jsonb WHERE id = $1`,
      [call.id, JSON.stringify(ENTRIES(90)), JSON.stringify({ provider: 'gemini', model: 'prior', detected_language: 'en', duration_seconds: 90, turn_count: 2, latency_ms: 1, transcribed_at: new Date().toISOString() })],
    );
    const { w, transcriber } = worker();
    await w.sweepOnce();
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    // min(recording 100, transcript meta 90)
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'completed', analysis_audio_seconds: 90 });
    await w.gracefulShutdown();
  });

  it('TRUNCATION RETRY + BACKOFF: a short transcript requeues with a future next_attempt_at, then succeeds on the next attempt', async () => {
    const { call, job } = await newCall();
    const short = makeTranscriber({ entries: ENTRIES(40), durationSeconds: 40 });
    const { w } = worker(short);
    await w.sweepOnce();
    const retried = (await jobs.findById(job.id))!;
    expect(retried).toMatchObject({ status: 'queued', attempts: 1, attempts_total: 1, error_code: 'AUDIO_TOO_SHORT' });
    expect(retried.next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 10_000);
    // The short transcript was NOT persisted (the cross-check throws before persisting).
    expect((await callRow(call.id)).conversation_log).toBeNull();

    // Not due yet: another sweep claims nothing.
    await w.sweepOnce();
    expect((await jobs.findById(job.id))!.attempts).toBe(1);

    await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [job.id]);
    short.transcribe.mockResolvedValue({ entries: ENTRIES(98), detectedLanguage: 'en', durationSeconds: 98, model: 'fake', diarizationFailed: false });
    await w.sweepOnce();
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'completed', attempts: 2, analysis_audio_seconds: 98 });
    await w.gracefulShutdown();
  });

  it('BACKOFF CEILING: a retryable failure past maxAttempts is terminal and mirrors failed onto the call', async () => {
    const { call, job } = await newCall();
    const bad = makeTranscriber();
    bad.transcribe.mockRejectedValue(new Error('boom'));
    const { w } = worker(bad);
    for (let i = 0; i < 3; i++) {
      await w.sweepOnce();
      await getTestPool().query(`UPDATE dialer_analysis_jobs SET next_attempt_at = now() - interval '1 second' WHERE id = $1 AND status = 'queued'`, [job.id]);
    }
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'failed', attempts: 3, error_code: 'ANALYSIS_FAILED' });
    expect((await callRow(call.id)).analysis_status).toBe('failed');
    await w.gracefulShutdown();
  });

  it('RATE LIMIT: requeues without consuming an attempt', async () => {
    const { job } = await newCall();
    const { TranscriptionError } = await import('../../../src/transcription/types.js');
    const limited = makeTranscriber();
    limited.transcribe.mockRejectedValue(new TranscriptionError('RATE_LIMITED', '429'));
    const { w } = worker(limited);
    await w.sweepOnce();
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'queued', attempts: 0, error_code: 'RATE_LIMITED' });
    await w.gracefulShutdown();
  });

  it('an off-list recording host is a PERMANENT failure with a clear error, and nothing is fetched', async () => {
    const { call, job } = await newCall({ recording_url: 'https://evil.example/r/a.mp3' });
    const { w, transcriber } = worker();
    await w.sweepOnce();
    const failed = (await jobs.findById(job.id))!;
    expect(failed).toMatchObject({ status: 'failed', attempts: 1, error_code: 'TRANSCRIPTION_FAILED' });
    expect(failed.error_message).toContain('allow-list');
    expect(fetch).not.toHaveBeenCalled();
    expect(transcriber.transcribe).not.toHaveBeenCalled();
    expect((await callRow(call.id)).analysis_status).toBe('failed');
    await w.gracefulShutdown();
  });

  it('an allow-listed host that redirects off the list is a permanent failure and the redirect is never followed', async () => {
    const { job } = await newCall();
    const fetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest/meta-data/' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { w } = worker();
    await w.sweepOnce();
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'failed', attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await w.gracefulShutdown();
  });

  it('with no allow-list configured every fetch is refused (fail closed)', async () => {
    const { job } = await newCall();
    const { w } = worker(makeTranscriber(), analysisService(), []);
    await w.sweepOnce();
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'failed', error_code: 'TRANSCRIPTION_FAILED' });
    expect(fetch).not.toHaveBeenCalled();
    await w.gracefulShutdown();
  });

  it('the sweep recovers a stale in-flight job (dead owner) without burning an attempt, then runs it', async () => {
    const { job } = await newCall();
    await jobs.claimRunnable(1);
    await getTestPool().query(`UPDATE dialer_analysis_jobs SET heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [job.id]);
    const { w } = worker();
    await w.sweepOnce(); // recovers -> queued (attempts 0)
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'queued', attempts: 0, attempts_total: 1 });
    await w.sweepOnce(); // claims and completes
    expect(await jobs.findById(job.id)).toMatchObject({ status: 'completed', attempts: 1 });
    await w.gracefulShutdown();
  });
});
