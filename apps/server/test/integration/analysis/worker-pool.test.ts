import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { dialerAnalysisJobRepository as jobs } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';

/*
 * The analysis worker's slot pool over the real job table: a deep queue drains with N
 * slots full and never more, and two workers sharing one queue (two processes, as a
 * separate analysis process will) never claim the same job twice. The real repository
 * (`claimRunnable`, `FOR UPDATE SKIP LOCKED`) and runner run; only the recording fetch
 * (global `fetch`), the transcriber and the analysis service are fakes.
 */
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { DialerAnalysisWorker } = await import('../../../src/core/dialer-analysis-worker.js');
type Worker = InstanceType<typeof DialerAnalysisWorker>;
type Cfg = ConstructorParameters<typeof DialerAnalysisWorker>[0]['config'];

const HOST = 'recordings.voicelink.test';
const cfg = (concurrency: number) => ({
  enabled: true, transcriber: 'gemini', geminiModel: 'g', geminiApiKey: 'k',
  transcribeTimeoutMs: 5000, transcribeWindowSeconds: 600, transcribeMaxOutputTokens: 16384, maxRecordingBytes: 1_000_000,
  memoryBudgetBytes: 64 * 1024 * 1024,
  minTalkTimeSeconds: 10, recordingWaitMinutes: 30, maxAttempts: 3, maxAttemptsTotal: 8, concurrency,
  pollIntervalMs: 60000, settleSeconds: 0, recordingFetchRetries: 0, recordingFetchRetryDelaySeconds: 1,
}) as unknown as Cfg;

const ANALYSIS = {
  common: { overall_sentiment: { label: 'positive', score: 0.9 }, turn_sentiments: [], key_topics: ['x'], conversation_quality: { coherence: 8, resolution_achieved: true, effectiveness_score: 7 }, summary: 's' },
  custom: {},
  _meta: { model: 'fake', provider: 'openai', latency_ms: 1, prompt_tokens: 1, completion_tokens: 1, analyzed_at: new Date().toISOString() },
};

/**
 * A fake transcriber that counts how many transcriptions run at once (across every
 * worker sharing the `shared` tally) and which recording URL each one transcribed.
 */
function tallyingTranscriber(shared: { now: number; max: number; seen: string[] }, delayMs: () => number) {
  return {
    provider: 'gemini' as const,
    transcribe: vi.fn(async (req: { audio: Buffer }) => {
      shared.now++;
      shared.max = Math.max(shared.max, shared.now);
      shared.seen.push(req.audio.toString());
      await new Promise((r) => setTimeout(r, delayMs()));
      shared.now--;
      return {
        entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 95 }],
        detectedLanguage: 'en', durationSeconds: 95, model: 'fake', diarizationFailed: false,
      };
    }),
  };
}

function makeWorker(concurrency: number, transcriber: ReturnType<typeof tallyingTranscriber>): Worker {
  return new DialerAnalysisWorker({
    transcriber: transcriber as never,
    analysisService: { analyze: vi.fn().mockResolvedValue(ANALYSIS) } as never,
    config: cfg(concurrency),
    recordingHosts: [HOST],
  });
}

/** `n` calls with a recording and a queued job each. The recording body is the call id. */
async function enqueue(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const call = await insertWebrtcCall({ recording_url: `https://${HOST}/r/${i}.mp3`, recording_duration_seconds: 100, talk_time_seconds: 100 });
    const job = (await jobs.enqueueFromCall({ call_id: call.id }))!;
    expect(job.status).toBe('queued');
    ids.push(call.id);
  }
  return ids;
}

/** The fetch returns the call's recording URL path as the body, so the transcriber can tell calls apart. */
function stubRecordings() {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => new Response(Buffer.from(String(url)), { status: 200, headers: { 'content-type': 'audio/mpeg' } })));
}

/** Wait until no job is queued or in flight, or fail after `ms`. */
async function drained(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    const { rows } = await getTestPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM dialer_analysis_jobs WHERE status IN ('queued','transcribing','analyzing')`,
    );
    if (rows[0]!.n === '0') return;
    if (Date.now() > deadline) throw new Error(`queue not drained: ${rows[0]!.n} jobs left`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('dialer analysis worker slot pool over real Postgres', () => {
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 20 }); });
  beforeEach(async () => { await truncateAll(); stubRecordings(); });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(async () => { await closePool(); await closeTestPool(); });

  it('a deep queue drains with N slots full and never more, without waiting for the poll', async () => {
    await enqueue(40);
    const tally = { now: 0, max: 0, seen: [] as string[] };
    const w = makeWorker(4, tallyingTranscriber(tally, () => 30));
    const started = Date.now();
    w.wake(); // the poll is 60 s: only wake() and finishing jobs claim here
    await drained(15_000);
    await w.idle();
    const elapsedMs = Date.now() - started;

    const { rows } = await getTestPool().query<{ status: string; attempts: number; claim_generation: number }>(
      `SELECT status, attempts, claim_generation FROM dialer_analysis_jobs`,
    );
    expect(rows).toHaveLength(40);
    expect(rows.every((r) => r.status === 'completed' && r.attempts === 1 && r.claim_generation === 1)).toBe(true);
    expect(tally.max).toBe(4);
    expect(tally.seen).toHaveLength(40);
    // 40 jobs × 30 ms on 4 slots is ~0.3 s of transcription; the old sweep took 2 jobs a minute.
    expect(elapsedMs).toBeLessThan(15_000);
    await w.gracefulShutdown();
  });

  it('two workers sharing one queue never claim the same job twice', async () => {
    const callIds = await enqueue(120);
    const tally = { now: 0, max: 0, seen: [] as string[] };
    // Jobs of 0-4 ms: the two workers' refill claims constantly race each other.
    const a = tallyingTranscriber(tally, () => Math.floor(Math.random() * 5));
    const b = tallyingTranscriber(tally, () => Math.floor(Math.random() * 5));
    const wa = makeWorker(6, a);
    const wb = makeWorker(6, b);
    wa.wake();
    wb.wake();
    await drained(30_000);
    await Promise.all([wa.idle(), wb.idle()]);

    // Every recording was transcribed exactly once, and both workers took a share.
    const counts = new Map<string, number>();
    for (const url of tally.seen) counts.set(url, (counts.get(url) ?? 0) + 1);
    expect(counts.size).toBe(120);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(a.transcribe.mock.calls.length + b.transcribe.mock.calls.length).toBe(120);
    expect(a.transcribe.mock.calls.length).toBeGreaterThan(0);
    expect(b.transcribe.mock.calls.length).toBeGreaterThan(0);
    expect(tally.max).toBeLessThanOrEqual(12);

    // And the table agrees: each job was claimed once (generation 1, one attempt) and completed.
    const { rows } = await getTestPool().query<{ call_id: string; status: string; attempts_total: number; claim_generation: number }>(
      `SELECT call_id, status, attempts_total, claim_generation FROM dialer_analysis_jobs`,
    );
    expect(rows.map((r) => r.call_id).sort()).toEqual([...callIds].sort());
    expect(rows.filter((r) => r.status !== 'completed' || r.claim_generation !== 1 || r.attempts_total !== 1)).toEqual([]);
    await Promise.all([wa.gracefulShutdown(), wb.gracefulShutdown()]);
  });
});
