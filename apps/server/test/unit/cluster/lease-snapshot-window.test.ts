import { describe, expect, it, vi } from 'vitest';

/*
 * The slot reap releases exactly the telephony slots a dead media worker held
 * (docs/scaling.md §6.1): the primary keeps them from the worker's `call.lease` deltas and
 * replaces them with each `reaper.snapshot`'s `leases`. A real bridge on the worker side, a
 * real MediaCluster on the primary side, a fake child process between them.
 *
 * The windows: a call is admitted (`held` told) before its row is written and its session
 * registered, and its session is dropped before its release goes out. A snapshot taken in
 * either window must still list the lease, or the reconcile deletes the delta the primary
 * already had, and a crash then leaves the call's slots held until the lock TTL.
 */

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' } },
  },
}));

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: { create: vi.fn(), findById: vi.fn().mockResolvedValue(null), update: vi.fn().mockResolvedValue(null) },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({ webrtcCallRepository: mockRepo }));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() {
      return {
        initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
        endCall: vi.fn().mockResolvedValue(undefined),
        generateAnswerResponse: vi.fn().mockReturnValue('<Response/>'),
      };
    }
  },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(), trackWebrtcCallRejected: vi.fn(), trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { MediaCluster } from '../../../src/cluster/media-cluster.js';
import type { CallLease } from '../../../src/cluster/ipc-protocol.js';
import { EMPTY_SNAPSHOT, FakeChildProcess } from '../../helpers/fake-child-process.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const until = async (check: () => boolean, ms = 2_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

/** One media worker: the real bridge, forwarding its lease deltas and answering snapshots from it. */
async function harness() {
  const guards = {
    concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
  const bridge = new WebRtcBridgeManager(guards as never, null);
  const reaped: CallLease[][] = [];
  const forks: FakeChildProcess[] = [];
  const cluster = new MediaCluster({
    count: 1,
    fork: (slot) => {
      const child = new FakeChildProcess('media', slot);
      if (forks.length === 0) {
        bridge.observeLeases((change) => {
          if (child.connected) child.emit('message', { v: 1, kind: 'event', type: 'call.lease', body: change });
        });
        child.handlers.set('reaper.snapshot', () => ({ ...EMPTY_SNAPSHOT, leases: bridge.heldLeases() }));
      } else {
        child.handlers.set('reaper.snapshot', () => EMPTY_SNAPSHOT);
      }
      forks.push(child);
      setImmediate(() => child.ready());
      return child.asChild();
    },
    readOwner: async () => null,
    setAgentOffline: async () => {},
    onWorkerExit: async (_slot, _last, leases) => { reaped.push(leases); },
    snapshotRefreshMs: 0,
    readyTimeoutMs: 2_000,
    restartBackoffMs: [5],
  });
  await cluster.start();
  const dial = () => bridge.createBridgedCall({
    tenantId: 't1', accountId: 'a1', callerId: '+14155550100', destinationPhone: '+14155550199', provider: 'voicelink',
    browserSocket: { readyState: 1, OPEN: 1, send() {}, on() {}, off() {}, close() {} } as never,
    correlation: { kind: 'attempt', campaignId: 'camp-1', agencyAttemptId: 'att-1' },
  });
  const crash = async (): Promise<CallLease[]> => {
    forks[0]!.exit(null, 'SIGKILL');
    await until(() => reaped.length === 1);
    return reaped[0]!;
  };
  return { guards, bridge, cluster, dial, crash, keyOf: () => guards.concurrencyGuard.tryAcquire.mock.calls[0]![0] as string };
}

const row = (i: Record<string, unknown>) => ({
  id: 'call-1', tenant_id: i['tenant_id'], account_id: i['account_id'], caller_id: i['caller_id'],
  destination_phone: i['destination_phone'], provider: i['provider'], status: 'initiating', provider_call_id: null,
  answered_at: null, ended_at: null, duration_seconds: null, talk_time_seconds: null,
  campaign_id: i['campaign_id'] ?? null, agency_attempt_id: i['agency_attempt_id'] ?? null,
});

describe('the lease reconcile keeps every admitted lease', () => {
  it('a snapshot answered between admission and the call registering keeps the lease, and the crash reap releases it', async () => {
    const insert = deferred<ReturnType<typeof row>>();
    mockRepo.create.mockImplementationOnce(() => insert.promise);
    const { cluster, dial, crash, keyOf } = await harness();
    const placing = dial();
    // Admitted (`held` told) and now waiting on the row: no session yet.
    await until(() => mockRepo.create.mock.calls.length === 1);
    const snap = await cluster.freshSnapshots();
    expect(snap?.leases.map((l) => l.concurrencyKey)).toEqual([keyOf()]);

    const reaped = await crash();
    expect(reaped.map((l) => l.concurrencyKey)).toEqual([keyOf()]);
    expect(reaped[0]).toMatchObject({ tenantId: 't1', accountId: 'a1', provider: 'voicelink' });

    insert.reject(new Error('the worker is gone'));
    await expect(placing).rejects.toThrow();
    await cluster.stop(500);
  });

  it('a snapshot answered while a call\'s release is in flight keeps the lease; the release then removes it', async () => {
    mockRepo.create.mockImplementationOnce(async (i: Record<string, unknown>) => row(i));
    const { guards, bridge, cluster, dial, keyOf } = await harness();
    await dial();
    expect((await cluster.freshSnapshots())?.leases).toEqual([expect.objectContaining({ callId: 'call-1', concurrencyKey: keyOf() })]);

    const release = deferred<undefined>();
    guards.accountConcurrencyGuard.release.mockImplementationOnce(() => release.promise);
    const ending = bridge.forceEndWithOutcome('att-1', 'ended_by_user');
    await until(() => guards.accountConcurrencyGuard.release.mock.calls.length === 1);
    // The session is gone, the slots are not released yet.
    expect(bridge.getActiveCallIds()).toEqual([]);
    expect((await cluster.freshSnapshots())?.leases.map((l) => l.concurrencyKey)).toEqual([keyOf()]);

    release.resolve(undefined);
    await ending;
    expect(bridge.heldLeases()).toEqual([]);
    expect((await cluster.freshSnapshots())?.leases).toEqual([]);
    await cluster.stop(500);
  });
});
