import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `CampaignStatsReads` (`src/agency/campaign-stats-reads.ts`): one campaign's two SQL reads,
 * shared between the supervisors polling its stats. What it must guarantee:
 *  - concurrent requests for one campaign run the reads once; different campaigns never share;
 *  - a settled read is served for `ttlMs`, then read again; `ttlMs = 0` shares only a read in
 *    flight and never serves a settled one;
 *  - a failed read is never kept;
 *  - the writes a supervisor re-reads after (`campaign_changed`, `contacts_changed`,
 *    `campaign_stats_stale`) drop the read, and the next request reads afresh rather
 *    than joining a read that began before the write;
 *  - closing it stops all of that.
 * The route's use of it (authorisation first, per-request strip) is
 * `campaign-stats-route-sharing.test.ts`; on real Postgres, `agency-campaign-stats-sharing.test.ts`.
 */

const { campaigns, reads } = vi.hoisted(() => ({
  campaigns: { stats: vi.fn(), healthInputs: vi.fn() },
  reads: { inc: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({ agencyCampaignRepository: campaigns }));
vi.mock('@magick-agency/observability/metrics/agency', () => ({ agencyCampaignStatsReadsTotal: reads }));

import {
  CampaignStatsReads,
  CAMPAIGN_STATS_READS_MAX_ENTRIES,
} from '../../../src/agency/campaign-stats-reads.js';
import { InProcessPacingInvalidationBus } from '../../../src/agency/pacing/invalidation-bus.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Each stats read answers a new object naming the campaign and how many reads came before. */
let scans = 0;
function answerByCampaign(): void {
  campaigns.stats.mockImplementation(async (id: string) => ({ id, scan: ++scans }));
  campaigns.healthInputs.mockImplementation(async (id: string) => ({ id }));
}

const opened: CampaignStatsReads[] = [];
function open(ttlMs: number, bus = new InProcessPacingInvalidationBus(), maxEntries?: number) {
  const r = new CampaignStatsReads({ ttlMs, bus, ...(maxEntries === undefined ? {} : { maxEntries }) });
  opened.push(r);
  return { reads: r, bus };
}

beforeEach(() => {
  vi.clearAllMocks();
  scans = 0;
  answerByCampaign();
});

afterEach(() => {
  for (const r of opened.splice(0)) r.close();
  vi.useRealTimers();
});

describe('CampaignStatsReads', () => {
  it('runs both reads ONCE for concurrent requests on one campaign, and hands every caller the same pair', async () => {
    const gate = deferred<void>();
    campaigns.stats.mockImplementation(async (id: string) => { await gate.promise; return { id, scan: ++scans }; });
    const { reads: r } = open(2_000);

    const pending = Array.from({ length: 8 }, () => r.read(A));
    gate.resolve();
    const answers = await Promise.all(pending);

    expect(campaigns.stats).toHaveBeenCalledTimes(1);
    expect(campaigns.healthInputs).toHaveBeenCalledTimes(1);
    expect(campaigns.stats).toHaveBeenCalledWith(A);
    expect(campaigns.healthInputs).toHaveBeenCalledWith(A);
    for (const a of answers) expect(a).toBe(answers[0]);
    expect(answers[0]).toEqual({ stats: { id: A, scan: 1 }, health: { id: A } });
    // One request scanned; seven shared it.
    expect(reads.inc).toHaveBeenCalledTimes(8);
    expect(reads.inc.mock.calls.filter(([l]) => l.result === 'scanned')).toHaveLength(1);
    expect(reads.inc.mock.calls.filter(([l]) => l.result === 'shared')).toHaveLength(7);
  });

  it('never shares between campaigns', async () => {
    const { reads: r } = open(2_000);
    const [a, b] = await Promise.all([r.read(A), r.read(B)]);
    expect(a.stats).toEqual({ id: A, scan: expect.any(Number) });
    expect(b.stats).toEqual({ id: B, scan: expect.any(Number) });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
    // And a settled read of one is not served for the other.
    expect((await r.read(B)).stats).toBe(b.stats);
    expect((await r.read(A)).stats).toBe(a.stats);
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
  });

  it('serves a settled read until ttlMs has passed, then reads again', async () => {
    vi.useFakeTimers();
    const { reads: r } = open(2_000);
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 1 });
    vi.advanceTimersByTime(1_999);
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 1 });
    expect(campaigns.stats).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 2 });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
  });

  it('ttlMs = 0 still shares a read in flight, but never serves a settled one', async () => {
    const gate = deferred<void>();
    campaigns.stats.mockImplementationOnce(async (id: string) => { await gate.promise; return { id, scan: ++scans }; });
    const { reads: r } = open(0);

    const together = [r.read(A), r.read(A), r.read(A)];
    gate.resolve();
    const answers = await Promise.all(together);
    expect(campaigns.stats).toHaveBeenCalledTimes(1);
    for (const a of answers) expect(a.stats).toEqual({ id: A, scan: 1 });

    // Settled: the next request reads again, however soon.
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 2 });
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 3 });
    expect(campaigns.stats).toHaveBeenCalledTimes(3);
  });

  it('keeps no failed read: every caller of it sees the failure, and the next request reads again', async () => {
    const gate = deferred<void>();
    campaigns.healthInputs.mockImplementationOnce(async () => { await gate.promise; throw new Error('pool exhausted'); });
    const { reads: r } = open(60_000);

    const together = [r.read(A), r.read(A)];
    gate.resolve();
    for (const p of together) await expect(p).rejects.toThrow('pool exhausted');
    expect(campaigns.healthInputs).toHaveBeenCalledTimes(1);
    // A failed request is not counted as served.
    expect(reads.inc).not.toHaveBeenCalled();

    expect(await r.read(A)).toEqual({ stats: { id: A, scan: 2 }, health: { id: A } });
    expect(campaigns.healthInputs).toHaveBeenCalledTimes(2);
  });

  it.each(['campaign_changed', 'contacts_changed', 'campaign_stats_stale'] as const)('%s on the bus drops that campaign\'s read, and only that one', async (type) => {
    const { reads: r, bus } = open(60_000);
    await Promise.all([r.read(A), r.read(B)]);
    expect(campaigns.stats).toHaveBeenCalledTimes(2);

    bus.publish({ type, campaignId: A });

    expect((await r.read(A)).stats).toEqual({ id: A, scan: 3 });
    expect((await r.read(B)).stats).toEqual({ id: B, scan: expect.any(Number) });
    expect(campaigns.stats).toHaveBeenCalledTimes(3);
  });

  it('ignores the bus events that move all the time (an agent available, a station ready, caller IDs)', async () => {
    const { reads: r, bus } = open(60_000);
    await r.read(A);
    bus.publish({ type: 'agent_available', sessionId: 's1', campaignId: A });
    bus.publish({ type: 'station_ready', sessionId: 's1', campaignId: A });
    bus.publish({ type: 'dedications_changed', campaignId: A });
    await r.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(1);
  });

  it('after an invalidation, a request does not join the read that began BEFORE it', async () => {
    // Supervisor 2's poll is mid-read when supervisor 1 pauses the campaign and re-reads.
    const before = deferred<void>();
    campaigns.stats.mockImplementationOnce(async (id: string) => { await before.promise; return { id, scan: 'before-write' }; });
    const { reads: r, bus } = open(60_000);

    const poll = r.read(A);
    bus.publish({ type: 'campaign_changed', campaignId: A });
    const reread = r.read(A);
    before.resolve();

    expect((await poll).stats).toEqual({ id: A, scan: 'before-write' });
    expect((await reread).stats).toEqual({ id: A, scan: 1 });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
    // And the read from before the write is not the one kept.
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 1 });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
  });

  it('an event on the bus reaches every instance listening on it, and none once closed', async () => {
    const { reads: one, bus } = open(60_000);
    const two = open(60_000, bus).reads;
    await one.read(A);
    await two.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(2);

    bus.publish({ type: 'campaign_stats_stale', campaignId: A });
    await one.read(A);
    await two.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(4);

    two.close();
    bus.publish({ type: 'campaign_stats_stale', campaignId: A });
    await one.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(5);
  });

  it('close() unsubscribes from the bus and holds nothing more', async () => {
    const bus = new InProcessPacingInvalidationBus();
    const r = new CampaignStatsReads({ ttlMs: 60_000, bus });
    expect(bus.subscriberCount).toBe(1);
    await r.read(A);
    r.close();
    r.close(); // idempotent
    expect(bus.subscriberCount).toBe(0);
    await r.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
    r.close();
  });

  it('holds at most maxEntries campaigns, dropping the least recently read', async () => {
    expect(CAMPAIGN_STATS_READS_MAX_ENTRIES).toBe(500);
    const { reads: r } = open(60_000, undefined, 2);
    const C = '33333333-3333-4333-8333-333333333333';
    await r.read(A);
    await r.read(B);
    await r.read(A); // A is now the most recent
    await r.read(C); // evicts B
    expect(campaigns.stats).toHaveBeenCalledTimes(3);
    await r.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(3);
    await r.read(B);
    expect(campaigns.stats).toHaveBeenCalledTimes(4);
  });
});
