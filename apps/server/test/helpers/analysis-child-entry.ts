/**
 * A real analysis worker process for the multi-process tests: `runAnalysisChildProcess`,
 * the code the server's own analysis children run, with the AI vendors and the recording
 * host faked. Forked by `test/integration/cluster/analysis-processes.test.ts` with
 * `--import tsx`; the role and slot come from the environment like any child's.
 *
 *   ANALYSIS_TEST_MODE   fast | slow | hang | rate_limit_first
 *   ANALYSIS_TEST_SLOTS  slots in this process (default 4)
 *   ANALYSIS_TEST_TALLY  a file: one line per transcription, `<pid> <recording url>`
 *   ANALYSIS_TEST_ENTERED  a file: one line, `<pid>`, each time a transcription is ENTERED
 *                        (past the runner's last claim check before the vendor call). A
 *                        test that needs a process provably inside a `hang` reads it.
 */
import { appendFileSync } from 'node:fs';
import { processIdentityFromEnv } from '../../src/cluster/roles.js';
import { runAnalysisChildProcess } from '../../src/cluster/analysis-child-main.js';
import { AiError } from '../../src/ai/index.js';
import type { DialerAnalysisConfig } from '../../src/core/dialer-analysis-runner.js';

export const TEST_RECORDING_HOST = 'recordings.voicelink.test';

const identity = processIdentityFromEnv(process.env);
if (identity.kind !== 'child' || identity.role !== 'analysis') throw new Error('analysis-child-entry needs MA_PROCESS_ROLE=analysis');

const mode = process.env['ANALYSIS_TEST_MODE'] ?? 'fast';
const tally = process.env['ANALYSIS_TEST_TALLY'];
const entered = process.env['ANALYSIS_TEST_ENTERED'];
const slots = Number(process.env['ANALYSIS_TEST_SLOTS'] ?? 4);

// The recording fetch returns the URL as the body, so a transcription names its call.
globalThis.fetch = (async (url: string | URL) =>
  new Response(Buffer.from(String(url)), { status: 200, headers: { 'content-type': 'audio/mpeg' } })) as typeof fetch;

let rateLimited = false;
const transcriber = {
  provider: 'gemini' as const,
  async transcribe(req: { audio: Buffer }) {
    if (entered) appendFileSync(entered, `${process.pid}\n`);
    if (mode === 'hang') await new Promise(() => {});
    if (mode === 'rate_limit_first' && !rateLimited) {
      rateLimited = true;
      throw new AiError('rate_limited', 'gemini', 'test: 429 from the vendor', 429);
    }
    await new Promise((r) => setTimeout(r, mode === 'slow' ? 150 : Math.floor(Math.random() * 5)));
    if (tally) appendFileSync(tally, `${process.pid} ${req.audio.toString()}\n`);
    return {
      entries: [{ role: 'agent', content: 'hi', start_seconds: 0, end_seconds: 95 }],
      detectedLanguage: 'en', durationSeconds: 95, model: 'fake', diarizationFailed: false,
    };
  },
};

const analysisService = {
  async analyze() {
    return {
      common: { overall_sentiment: { label: 'positive', score: 0.9 }, turn_sentiments: [], key_topics: ['x'], conversation_quality: { coherence: 8, resolution_achieved: true, effectiveness_score: 7 }, summary: 's' },
      custom: {},
      _meta: { model: 'fake', provider: 'openai', latency_ms: 1, prompt_tokens: 1, completion_tokens: 1, analyzed_at: new Date().toISOString() },
    };
  },
};

const config = {
  enabled: true, transcriber: 'gemini', geminiModel: 'g', geminiApiKey: 'k',
  transcribeTimeoutMs: 5000, transcribeWindowSeconds: 600, transcribeMaxOutputTokens: 16384, maxRecordingBytes: 1_000_000,
  memoryBudgetBytes: 64 * 1024 * 1024,
  minTalkTimeSeconds: 10, recordingWaitMinutes: 30, maxAttempts: 3, maxAttemptsTotal: 8, concurrency: slots,
  pollIntervalMs: 60_000, settleSeconds: 0, recordingFetchRetries: 0, recordingFetchRetryDelaySeconds: 1, processes: 0,
} as unknown as DialerAnalysisConfig;

void runAnalysisChildProcess({
  slot: identity.slot,
  overrides: { transcriber: transcriber as never, analysisService: analysisService as never, config, recordingHosts: [TEST_RECORDING_HOST] },
});
