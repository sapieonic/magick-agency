import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * `CampaignStatsReads` (`src/agency/campaign-stats-reads.ts`): one campaign's two SQL reads,
 * shared between the supervisors polling its stats. What it must guarantee:
 *  - concurrent requests for one campaign run the reads once; different campaigns never share;
 *  - a settled read is served for `ttlMs`, then read again; `ttlMs = 0` shares only a read in
 *    flight and never serves a settled one;
 *  - a failed read is never kept;
 *  - the writes a supervisor re-reads after (`campaign_changed` on the pacing bus, this cache's
 *    name on the cache-invalidation channel) drop the read, and the next request reads afresh
 *    rather than joining a read that began before the write;
 *  - `contacts_changed`, which comes in bursts, lets the read in flight finish unkept: requests
 *    still join it, so a burst never runs two scans at once, and the first one after it reads
 *    afresh;
 *  - a `fresh` read is the caller's own: it neither joins, nor is joined by, nor replaces the
 *    shared read; every answer says whether it was read for its request (`scanned`);
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
  CAMPAIGN_STATS_CACHE,
  CAMPAIGN_STATS_READS_MAX_ENTRIES,
} from '../../../src/agency/campaign-stats-reads.js';
import { InProcessPacingInvalidationBus } from '../../../src/agency/pacing/invalidation-bus.js';
import { cacheInvalidationListenerCount, publishCacheInvalidation } from '../../../src/cache/cache-invalidation.js';

/** The force-available's (and the completed ingest's) drop of a campaign's read. */
const stale = (campaignId: string) => publishCacheInvalidation({ cache: CAMPAIGN_STATS_CACHE, key: campaignId });

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
    for (const a of answers) {
      expect(a.stats).toBe(answers[0]!.stats);
      expect(a.health).toBe(answers[0]!.health);
    }
    expect(answers[0]).toMatchObject({ stats: { id: A, scan: 1 }, health: { id: A } });
    // Each answer says whether it was read for its own request: one was.
    expect(answers.filter((a) => a.scanned)).toHaveLength(1);
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

    expect(await r.read(A)).toEqual({ stats: { id: A, scan: 2 }, health: { id: A }, scanned: true });
    expect(campaigns.healthInputs).toHaveBeenCalledTimes(2);
  });

  it.each(['campaign_changed', 'contacts_changed', 'the cache channel'] as const)('%s drops that campaign\'s settled read, and only that one', async (type) => {
    const { reads: r, bus } = open(60_000);
    await Promise.all([r.read(A), r.read(B)]);
    expect(campaigns.stats).toHaveBeenCalledTimes(2);

    if (type === 'the cache channel') stale(A);
    else bus.publish({ type, campaignId: A });

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

  it.each(['campaign_changed', 'the cache channel'] as const)('after %s, a request does not join the read that began BEFORE it', async (type) => {
    // Supervisor 2's poll is mid-read when supervisor 1 pauses the campaign (or forces an agent
    // back to available) and re-reads.
    const before = deferred<void>();
    campaigns.stats.mockImplementationOnce(async (id: string) => { await before.promise; return { id, scan: 'before-write' }; });
    const { reads: r, bus } = open(60_000);

    const poll = r.read(A);
    if (type === 'the cache channel') stale(A);
    else bus.publish({ type: 'campaign_changed', campaignId: A });
    const reread = r.read(A);
    before.resolve();

    expect((await poll).stats).toEqual({ id: A, scan: 'before-write' });
    expect((await reread).stats).toEqual({ id: A, scan: 1 });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
    // And the read from before the write is not the one kept.
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 1 });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
  });

  it('contacts_changed mid-read: requests still join the read in flight, which is not kept; the next reads afresh', async () => {
    const first = deferred<void>();
    campaigns.stats.mockImplementationOnce(async (id: string) => { await first.promise; return { id, scan: 'in-flight' }; });
    const { reads: r, bus } = open(60_000);

    const poll = r.read(A);
    bus.publish({ type: 'contacts_changed', campaignId: A });
    const joined = r.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(1);
    first.resolve();
    expect((await poll).stats).toEqual({ id: A, scan: 'in-flight' });
    expect(await joined).toMatchObject({ stats: { id: A, scan: 'in-flight' }, scanned: false });

    // Not kept: the first request after it settled reads afresh, and that one is kept.
    expect(await r.read(A)).toMatchObject({ stats: { id: A, scan: 1 }, scanned: true });
    expect((await r.read(A)).stats).toEqual({ id: A, scan: 1 });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
  });

  it('a burst of contacts_changed (one per roster chunk) never runs two scans of a campaign at once', async () => {
    let running = 0;
    let most = 0;
    const gates: Array<() => void> = [];
    campaigns.stats.mockImplementation((id: string) => new Promise((resolve) => {
      running += 1;
      most = Math.max(most, running);
      const scan = ++scans;
      gates.push(() => { running -= 1; resolve({ id, scan }); });
    }));
    const { reads: r, bus } = open(60_000);

    for (let chunk = 0; chunk < 5; chunk++) {
      // Supervisors poll while each chunk lands; the scan in flight ends after the chunk's event.
      const polls = [r.read(A)];
      for (let i = 0; i < 3; i++) {
        bus.publish({ type: 'contacts_changed', campaignId: A });
        polls.push(r.read(A));
      }
      await vi.waitFor(() => expect(gates).toHaveLength(1));
      gates.shift()!();
      await Promise.all(polls);
    }
    expect(most).toBe(1);
    expect(campaigns.stats).toHaveBeenCalledTimes(5);
  });

  it('a fresh read is the caller\'s own: it neither joins the shared read, nor is joined, nor replaces it', async () => {
    const shared = deferred<void>();
    campaigns.stats.mockImplementationOnce(async (id: string) => { await shared.promise; return { id, scan: 'shared' }; });
    const { reads: r } = open(60_000);

    const poll = r.read(A);
    const own = r.read(A, { fresh: true });
    const later = r.read(A);
    expect(await own).toMatchObject({ stats: { id: A, scan: 1 }, scanned: true });
    expect(campaigns.stats).toHaveBeenCalledTimes(2);
    shared.resolve();
    expect(await poll).toMatchObject({ stats: { id: A, scan: 'shared' }, scanned: true });
    expect(await later).toMatchObject({ stats: { id: A, scan: 'shared' }, scanned: false });

    // The shared read stays the supervisors': the next request is served it, not the fresh one.
    expect(await r.read(A)).toMatchObject({ stats: { id: A, scan: 'shared' }, scanned: false });
    // And a second fresh read reads again.
    expect(await r.read(A, { fresh: true })).toMatchObject({ stats: { id: A, scan: 2 }, scanned: true });
    expect(campaigns.stats).toHaveBeenCalledTimes(3);
    expect(reads.inc.mock.calls.map(([l]) => l.result)).toEqual(['scanned', 'scanned', 'shared', 'shared', 'scanned']);
  });

  it('an invalidation reaches every instance listening, and none once closed', async () => {
    const { reads: one, bus } = open(60_000);
    const two = open(60_000, bus).reads;
    await one.read(A);
    await two.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(2);

    stale(A);
    await one.read(A);
    await two.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(4);

    bus.publish({ type: 'campaign_changed', campaignId: A });
    await one.read(A);
    await two.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(6);

    two.close();
    stale(A);
    await one.read(A);
    expect(campaigns.stats).toHaveBeenCalledTimes(7);
  });

  it('close() unsubscribes from the bus and the cache channel, and holds nothing more', async () => {
    const bus = new InProcessPacingInvalidationBus();
    const listening = cacheInvalidationListenerCount(CAMPAIGN_STATS_CACHE);
    const r = new CampaignStatsReads({ ttlMs: 60_000, bus });
    expect(bus.subscriberCount).toBe(1);
    expect(cacheInvalidationListenerCount(CAMPAIGN_STATS_CACHE)).toBe(listening + 1);
    await r.read(A);
    r.close();
    r.close(); // idempotent
    expect(bus.subscriberCount).toBe(0);
    expect(cacheInvalidationListenerCount(CAMPAIGN_STATS_CACHE)).toBe(listening);
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
