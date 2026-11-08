import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { dialerAnalysisJobRepository as jobs } from '@magick-agency/db/repositories/dialer-analysis-job.repository';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertWebrtcCall } from '../../../../../packages/db/test/integration/setup/factories.js';
import type { ChildSupervisor } from '../../../src/cluster/child-supervisor.js';
import { createAnalysisChildren } from '../../../src/cluster/analysis-children.js';
import { forkServerChild } from '../../../src/cluster/fork.js';

/*
 * ANALYSIS_WORKERS (docs/scaling.md §1.3) with real processes: the primary's
 * ChildSupervisor forks real analysis children (`test/helpers/analysis-child-entry.ts`
 * runs the server's own `runAnalysisChildProcess`, with the AI vendors and the recording
 * host faked) on the real job table. Pins:
 *  - two processes drain one queue with no job claimed twice, and both take a share;
 *  - one process's vendor rate limit pauses the other, relayed over IPC by the primary;
 *  - a process killed mid-job leaves its claim for the stale recovery, which requeues it
 *    without using an attempt, and another process completes it;
 *  - a graceful stop requeues each process's own claims, generation-matched: a process
 *    whose claim was recovered and re-claimed elsewhere touches nothing.
 */

const ENTRY = resolve(__dirname, '../../helpers/analysis-child-entry.ts');
const HOST = 'recordings.voicelink.test';

interface Fleet {
  supervisor: ChildSupervisor;
  exits: Array<{ slot: number; code: number | null; signal: string | null }>;
  children: ChildProcess[];
}

function fleet(count: number, modeFor: (slot: number) => string, opts: { tally?: string; entered?: string; slots?: number; restartBackoffMs?: number[] } = {}): Fleet {
  const exits: Fleet['exits'] = [];
  const children: ChildProcess[] = [];
  // The production wiring (`bootstrap/analysis.ts` builds the same), with the fork pointed
  // at the test entry.
  const supervisor = createAnalysisChildren({
    count,
    fork: (slot) => {
      const child = forkServerChild({
        role: 'analysis', slot, entry: ENTRY, execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          ANALYSIS_TEST_MODE: modeFor(slot),
          ANALYSIS_TEST_SLOTS: String(opts.slots ?? 4),
          ...(opts.tally ? { ANALYSIS_TEST_TALLY: opts.tally } : {}),
          ...(opts.entered ? { ANALYSIS_TEST_ENTERED: opts.entered } : {}),
          LOG_LEVEL: 'warn',
        },
      });
      child.once('exit', (code, signal) => exits.push({ slot, code, signal }));
      children.push(child);
      return child;
    },
    readyTimeoutMs: 30_000,
    restartBackoffMs: opts.restartBackoffMs ?? [60_000],
  });
  const f = { supervisor, exits, children };
  fleets.push(f);
  return f;
}

/**
 * Every fleet a case started, stopped after it whether it passed or not: a case that fails
 * before its own stop must not leave processes claiming from the queue the next case fills.
 */
const fleets: Fleet[] = [];

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

interface JobRow { id: string; call_id: string; status: string; attempts: number; attempts_total: number; claim_generation: number }
async function rows(): Promise<JobRow[]> {
  return (await getTestPool().query<JobRow>(
    `SELECT id, call_id, status, attempts, attempts_total, claim_generation FROM dialer_analysis_jobs ORDER BY call_id`,
  )).rows;
}

async function until(what: string, ms: number, check: () => Promise<boolean>, diag?: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}${diag ? ` ${JSON.stringify(await diag())}` : ''}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const drained = (ms: number) => until('queue drained', ms, async () =>
  (await rows()).every((r) => !['queued', 'transcribing', 'analyzing'].includes(r.status)));

describe('analysis worker processes over real Postgres', () => {
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 10 }); });
  beforeEach(async () => { await truncateAll(); });
  afterEach(async () => {
    await Promise.all(fleets.splice(0).map((f) => f.supervisor.stop(5_000)));
  }, 30_000);
  afterAll(async () => { await closePool(); await closeTestPool(); });

  it('two processes drain one queue: every job claimed once and completed, both take a share, both exit 0 on stop', async () => {
    const tally = join(mkdtempSync(join(tmpdir(), 'ma-analysis-')), 'tally.txt');
    const callIds = await enqueue(120);
    const f = fleet(2, () => 'fast', { tally, slots: 6 });
    await f.supervisor.start();
    f.supervisor.broadcast('analysis.wake', {});
    await drained(45_000);

    const done = await rows();
    expect(done.map((r) => r.call_id).sort()).toEqual([...callIds].sort());
    expect(done.filter((r) => r.status !== 'completed' || r.claim_generation !== 1 || r.attempts_total !== 1)).toEqual([]);

    const lines = readFileSync(tally, 'utf8').trim().split('\n');
    const byUrl = new Map<string, number>();
    const byPid = new Map<string, number>();
    for (const line of lines) {
      const [pid, url] = line.split(' ') as [string, string];
      byUrl.set(url, (byUrl.get(url) ?? 0) + 1);
      byPid.set(pid, (byPid.get(pid) ?? 0) + 1);
    }
    expect(byUrl.size).toBe(120);
    expect([...byUrl.values()].every((n) => n === 1)).toBe(true);
    expect(byPid.size).toBe(2);

    await f.supervisor.stop(10_000);
    expect(f.exits.map((e) => e.code)).toEqual([0, 0]);
  }, 90_000);

  it("one process's vendor rate limit pauses the other, over IPC through the primary", async () => {
    await enqueue(30);
    const f = fleet(2, (slot) => (slot === 0 ? 'rate_limit_first' : 'slow'), { slots: 2 });
    await f.supervisor.start();
    f.supervisor.broadcast('analysis.wake', {});
    // Slot 0's first job is rate-limited: its breaker opens (30 s base pause) and slot 1,
    // which was never rate-limited itself, reports the same pause.
    await until('both slots paused', 20_000, async () => {
      const h = await f.supervisor.health();
      return (h[0]?.pausedForMs ?? 0) > 0 && (h[1]?.pausedForMs ?? 0) > 0;
    }, async () => ({ health: await f.supervisor.health(), jobs: (await rows()).map((r) => `${r.status}/${r.attempts}/${r.claim_generation}`) }));
    const h = await f.supervisor.health();
    expect(Math.abs(h[0]!.pausedForMs - h[1]!.pausedForMs)).toBeLessThan(2_000);
    // The rate-limited job went back without using an attempt. The runner trips the breaker
    // (and the primary relays the pause) BEFORE it writes the requeue, because the job's
    // backoff is at least that pause: both slots can report the pause while the row still
    // says `transcribing`. So wait for the row, not one read of it.
    const requeued = async (): Promise<JobRow[]> =>
      (await rows()).filter((r) => r.status === 'queued' && r.claim_generation === 1 && r.attempts === 0 && r.attempts_total === 0);
    await until('the rate-limited job requeued without using an attempt', 10_000, async () => (await requeued()).length >= 1,
      async () => ({ jobs: (await rows()).map((r) => `${r.status}/${r.attempts}/${r.attempts_total}/${r.claim_generation}`) }));
    expect((await requeued()).length).toBeGreaterThanOrEqual(1);
    await f.supervisor.stop(10_000);
  }, 60_000);

  it('a process killed mid-job: the stale recovery requeues it without using an attempt, and another process completes it', async () => {
    const [callId] = await enqueue(1);
    const hung = fleet(1, () => 'hang', { slots: 1 });
    await hung.supervisor.start();
    hung.supervisor.broadcast('analysis.wake', {});
    await until('the job is claimed', 15_000, async () => (await rows())[0]?.status === 'transcribing');
    expect((await rows())[0]).toMatchObject({ attempts: 1, attempts_total: 1, claim_generation: 1 });

    // SIGKILL: no graceful requeue runs. The claim stays, owned by a dead process.
    process.kill(hung.supervisor.pidOf(0)!, 'SIGKILL');
    await until('the child exited', 10_000, async () => hung.exits.length === 1);
    expect(hung.exits[0]).toMatchObject({ signal: 'SIGKILL' });
    expect((await rows())[0]).toMatchObject({ status: 'transcribing', claim_generation: 1 });
    await hung.supervisor.stop(1_000); // cancels the (60 s) restart

    // The sweep's own step, with "stale" meaning now: its heartbeat is past any threshold.
    const recovered = await jobs.recoverStale(new Date(Date.now() + 1_000), 8);
    expect(recovered).toHaveLength(1);
    expect((await rows())[0]).toMatchObject({ status: 'queued', attempts: 0, attempts_total: 1, claim_generation: 2 });

    const fresh = fleet(1, () => 'fast', { slots: 1 });
    await fresh.supervisor.start();
    fresh.supervisor.broadcast('analysis.wake', {});
    await drained(20_000);
    expect((await rows())[0]).toMatchObject({ call_id: callId, status: 'completed', attempts: 1, attempts_total: 2, claim_generation: 3 });
    await fresh.supervisor.stop(10_000);
  }, 60_000);

  it('a graceful stop requeues only its own claims: a claim recovered and re-claimed elsewhere is left alone', async () => {
    await enqueue(1);
    // Who has entered the vendor call. The row says `transcribing` from the claim on, but
    // the runner checks its claim once more before the call: a recovery landing before that
    // check fences A out at once, frees its one slot, and A claims the job again itself (so
    // the "B" claim below would be A's, and A's stop would requeue it). The recovery must
    // land after A is past that check, hung inside the call with generation 1 in memory.
    const entered = join(mkdtempSync(join(tmpdir(), 'ma-analysis-')), 'entered.txt');
    const enteredBy = (pid: number | undefined): boolean =>
      existsSync(entered) && readFileSync(entered, 'utf8').split('\n').includes(String(pid));
    const a = fleet(1, () => 'hang', { slots: 1, entered });
    await a.supervisor.start();
    a.supervisor.broadcast('analysis.wake', {});
    await until('A is inside the vendor call', 15_000, async () => enteredBy(a.supervisor.pidOf(0)));
    expect((await rows())[0]).toMatchObject({ status: 'transcribing', claim_generation: 1 });

    // A looks dead to the sweep (its heartbeat is "stale"), so its claim is recovered…
    await jobs.recoverStale(new Date(Date.now() + 1_000), 8);
    // …and B claims it: generation 3, while A still holds generation 1 in memory.
    const b = fleet(1, () => 'hang', { slots: 1, entered });
    await b.supervisor.start();
    b.supervisor.broadcast('analysis.wake', {});
    await until('B is inside the vendor call', 15_000, async () => enteredBy(b.supervisor.pidOf(0)));
    expect((await rows())[0]).toMatchObject({ status: 'transcribing', claim_generation: 3 });

    await a.supervisor.stop(10_000);
    expect(a.exits).toEqual([{ slot: 0, code: 0, signal: null }]);
    expect((await rows())[0]).toMatchObject({ status: 'transcribing', claim_generation: 3 });

    await b.supervisor.stop(10_000);
    expect(b.exits).toEqual([{ slot: 0, code: 0, signal: null }]);
    expect((await rows())[0]).toMatchObject({ status: 'queued', attempts: 0, claim_generation: 4 });
  }, 60_000);

  it('the entry under test is the one the children run', () => {
    expect(existsSync(ENTRY)).toBe(true);
  });
});
