import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { slotFor } from '../../../src/cluster/roles.js';
import { DEFAULT_MAX_DIALS_IN_FLIGHT, MediaCluster } from '../../../src/cluster/media-cluster.js';
import { parseConfig } from '../../../src/config/load.js';
import { onCacheInvalidation, setCacheInvalidationForwarder } from '../../../src/cache/cache-invalidation.js';
import { EMPTY_SNAPSHOT, FakeChildProcess } from '../../helpers/fake-child-process.js';

/*
 * The primary's MediaCluster against fake media children: what it asks its workers and
 * when, without a database (no request here resolves a session from a row).
 */

function cluster(opts: Partial<ConstructorParameters<typeof MediaCluster>[0]> = {}) {
  const forks: FakeChildProcess[] = [];
  const c = new MediaCluster({
    count: 2,
    fork: (slot) => {
      const child = new FakeChildProcess('media', slot);
      child.handlers.set('reaper.snapshot', () => EMPTY_SNAPSHOT);
      // Answers a forwarded internal request with the slot it ran in.
      child.handlers.set('core.inject', () => ({ statusCode: 200, headers: {}, body: Buffer.from(String(slot)).toString('base64') }));
      forks.push(child);
      setImmediate(() => child.ready());
      return child.asChild();
    },
    readOwner: async () => null,
    setAgentOffline: async () => {},
    readyTimeoutMs: 2_000,
    ...opts,
  });
  return { c, forks };
}

let running: MediaCluster | null = null;
afterEach(async () => {
  await running?.stop(1_000);
  running = null;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('MediaCluster: a session id in upper case', () => {
  /** FNV-1a as hashed before the fix: case-sensitive. */
  function rawSlot(key: string, n: number): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h % n;
  }
  /**
   * A session id whose upper-case spelling hashed to another slot of three. (With two
   * slots they never split: a letter and its capital share their low bit, and FNV-1a's
   * multiplier is odd, so the hash's parity ignores case.)
   */
  function splitId(): string {
    for (let i = 0; i < 10_000; i++) {
      const id = randomUUID();
      if (rawSlot(id, 3) !== rawSlot(id.toUpperCase(), 3)) return id;
    }
    throw new Error('no id found whose case changes its slot');
  }

  it('is forwarded (callCore) and handed off (station upgrade) to the worker that owns the stored id', async () => {
    const { c, forks } = cluster({ count: 3 });
    running = c;
    await c.start();
    const id = splitId();
    const owner = slotFor(id, 3);

    const res = await c.coreInjector(
      { method: 'POST', url: `/api/v1/agency/sessions/${id.toUpperCase()}/break`, headers: {}, payload: '{}' },
      async () => { throw new Error('ran locally'); },
    );
    expect(res.rawPayload.toString()).toBe(String(owner));
    expect(forks[owner]!.requests('core.inject')).toHaveLength(1);
    for (const f of forks) if (f.slot !== owner) expect(f.requests('core.inject')).toHaveLength(0);

    expect(c.slotFor({ by: 'session', param: 'sessionId' }, { sessionId: id.toUpperCase() }, {})).toBe(owner);
  });
});

describe('MediaCluster: dials in flight to one worker', () => {
  const DIAL = { cmd: {}, grant: 1 } as never;

  it('a whole floor of dials outstanding on one worker (MAX_CONCURRENT_CALLS, 1000 by default) is never refused, nor does it refuse the other requests; one more is', async () => {
    const { c, forks } = cluster({ count: 1 });
    running = c;
    await c.start();
    const channel = c.supervisor.channel(0)!;
    const dials = Array.from({ length: DEFAULT_MAX_DIALS_IN_FLIGHT }, () =>
      channel.request('dial.execute', DIAL).then(() => 'ok', (e: { code: string }) => e.code));
    // The worker answers none of them (each is waiting on the carrier's add_lead).
    expect(forks[0]!.requests('dial.execute')).toHaveLength(DEFAULT_MAX_DIALS_IN_FLIGHT);
    // The floor's other requests still go: a forwarded agent action, a health ping.
    forks[0]!.handlers.set('health.ping', () => ({ role: 'media', slot: 0, pid: 1, elu: 0, inFlight: 0, pausedForMs: 0, loopDelayP99Ms: 0, draining: false }));
    await expect(channel.request('health.ping', {})).resolves.toMatchObject({ slot: 0 });
    await expect(channel.request('dial.execute', DIAL)).rejects.toMatchObject({ code: 'refused' });
    await c.stop(500);
    running = null;
    // None of the floor's dials was refused: each ended `gone` with the worker.
    expect(new Set(await Promise.all(dials))).toEqual(new Set(['gone']));
  });

  it('the bound is the one the primary passes (MAX_CONCURRENT_CALLS)', async () => {
    const { c } = cluster({ count: 1, maxDialsInFlight: 3 });
    running = c;
    await c.start();
    const channel = c.supervisor.channel(0)!;
    for (let i = 0; i < 3; i++) void channel.request('dial.execute', DIAL).catch(() => {});
    await expect(channel.request('dial.execute', DIAL)).rejects.toMatchObject({ code: 'refused' });
  });
});

describe('MediaCluster snapshot refresh', () => {
  it('MEDIA_SNAPSHOT_REFRESH_MS comes through config: 5 s by default, 0 allowed (off)', () => {
    const env = { DATABASE_URL: 'postgresql://u:p@localhost:5436/magick_agency', REDIS_URL: 'redis://localhost:6383/0' };
    const parse = (extra: Record<string, string>) => {
      const r = parseConfig({ ...env, ...extra });
      if (!r.ok) throw new Error(JSON.stringify(r.issues));
      return r.config.processes.mediaSnapshotRefreshMs;
    };
    expect(parse({})).toBe(5_000);
    expect(parse({ MEDIA_SNAPSHOT_REFRESH_MS: '0' })).toBe(0);
    expect(parseConfig({ ...env, MEDIA_SNAPSHOT_REFRESH_MS: '-1' }).ok).toBe(false);
  });

  it('refreshes every worker\'s snapshot at the configured interval', async () => {
    const { c, forks } = cluster({ snapshotRefreshMs: 20 });
    running = c;
    await c.start();
    await sleep(150);
    for (const f of forks) expect(f.requests('reaper.snapshot').length).toBeGreaterThanOrEqual(3);
  });

  it('with 0, asks once at start and never again', async () => {
    const { c, forks } = cluster({ snapshotRefreshMs: 0 });
    running = c;
    await c.start();
    await sleep(150);
    for (const f of forks) expect(f.requests('reaper.snapshot')).toHaveLength(1);
  });
});

describe('MediaCluster: invalidations the primary sends every worker', () => {
  it('a dialable caller-ID clear reaches every worker as `dialable.invalidate` (PL13)', async () => {
    const { c, forks } = cluster({ count: 2 });
    running = c;
    await c.start();
    c.invalidateDialableCallerIds();
    for (const f of forks) {
      expect(f.sent.filter((m) => m.kind === 'event' && m.type === 'dialable.invalidate')).toEqual([
        expect.objectContaining({ kind: 'event', type: 'dialable.invalidate', body: {} }),
      ]);
    }
  });

  it('a concurrency-limit change reaches every worker as `concurrency.invalidate`', async () => {
    const { c, forks } = cluster({ count: 2 });
    running = c;
    await c.start();
    c.invalidateLimits('t', 'a');
    for (const f of forks) {
      expect(f.sent.filter((m) => m.kind === 'event' && m.type === 'concurrency.invalidate'))
        .toEqual([expect.objectContaining({ body: { tenantId: 't', accountId: 'a' } })]);
    }
  });
});

describe('MediaCluster: what the workers tell the primary', () => {
  it('a worker\'s `cache.invalidate` reaches this process\'s listeners for that cache, and goes no further', async () => {
    const { c, forks } = cluster({ count: 2 });
    running = c;
    await c.start();
    const got = vi.fn();
    const forwarded = vi.fn();
    const off = onCacheInvalidation('agency-campaign-stats', got);
    // Were the primary to forward, the event would go back the way it came.
    setCacheInvalidationForwarder(forwarded);
    try {
      forks[1]!.emit('message', { v: 1, kind: 'event', type: 'cache.invalidate', body: { cache: 'agency-campaign-stats', key: 'camp-1' } });
      // A cache this channel does not list is dropped at the decoder.
      forks[0]!.emit('message', { v: 1, kind: 'event', type: 'cache.invalidate', body: { cache: 'made-up', key: 'camp-2' } });
      expect(got.mock.calls).toEqual([['camp-1']]);
      expect(forwarded).not.toHaveBeenCalled();
    } finally {
      off();
      setCacheInvalidationForwarder(null);
    }
  });
});
