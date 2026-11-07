import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../../../src/app-context.js';

/*
 * prepareMediaPrimary's fallback: with MEDIA_WORKERS set, a Node that cannot stop a socket
 * reading (`socket-pause.ts`, probed once at boot) runs the server as one process. It must
 * fork nothing and install nothing: a handoff without the read stop loses the frames a
 * client sends during the primary's hooks.
 */
const probe = vi.hoisted(() => ({ ok: true, calls: 0 }));
vi.mock('../../../src/cluster/socket-pause.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/cluster/socket-pause.js')>()),
  probeSocketReadStop: vi.fn(async () => { probe.calls++; return probe.ok; }),
}));

const { prepareMediaPrimary, relayDialableInvalidations } = await import('../../../src/cluster/primary.js');
const { invalidateDialableCallerIds } = await import('../../../src/agency/campaign-dialability.js');

function ctx(mediaWorkers: number): AppContext {
  return {
    config: {
      processes: { mediaWorkers, mediaWorkerHeapMb: 768, crashLoopMax: 5, mediaWorkerDbPoolMax: 10, mediaSnapshotRefreshMs: 0 },
      redis: { keyPrefix: '' },
      concurrency: { maxConcurrentCalls: 1000 },
    },
    pool: {},
    redis: {},
  } as unknown as AppContext;
}

describe('prepareMediaPrimary', () => {
  it('without the socket read stop: one process, nothing forked, the probe consulted once', async () => {
    probe.ok = false;
    probe.calls = 0;
    const forkChild = vi.fn();
    const cluster = await prepareMediaPrimary(ctx(2), { forkChild, onFatal: vi.fn() });
    expect(cluster).toBeNull();
    expect(probe.calls).toBe(1);
    expect(forkChild).not.toHaveBeenCalled();
  });

  it('MEDIA_WORKERS=0: one process, and the probe is not even run', async () => {
    probe.ok = true;
    probe.calls = 0;
    expect(await prepareMediaPrimary(ctx(0), { onFatal: vi.fn() })).toBeNull();
    expect(probe.calls).toBe(0);
  });

  it('with it: a cluster of the configured size (forked later, by startMediaWorkers)', async () => {
    probe.ok = true;
    probe.calls = 0;
    const forkChild = vi.fn();
    const cluster = await prepareMediaPrimary(ctx(3), { forkChild, onFatal: vi.fn() });
    expect(cluster?.count).toBe(3);
    expect(probe.calls).toBe(1);
    expect(forkChild).not.toHaveBeenCalled();
  });
});

describe('relayDialableInvalidations', () => {
  it('sends every dialable caller-ID clear made in the primary to the workers, until unsubscribed (PL13)', () => {
    const cluster = { invalidateDialableCallerIds: vi.fn() };
    const off = relayDialableInvalidations(cluster);
    invalidateDialableCallerIds();
    expect(cluster.invalidateDialableCallerIds).toHaveBeenCalledTimes(1);
    off();
    invalidateDialableCallerIds();
    expect(cluster.invalidateDialableCallerIds).toHaveBeenCalledTimes(1);
  });

  it('a relay that throws never fails the clear made here', () => {
    const off = relayDialableInvalidations({ invalidateDialableCallerIds: () => { throw new Error('channel closed'); } });
    expect(() => invalidateDialableCallerIds()).not.toThrow();
    off();
  });
});
