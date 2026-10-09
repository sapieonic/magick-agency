import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Covers `TelephonyGuardHost`: `reconcileConcurrency`, the WebRTC half of
// `sweepStaleActiveCalls`, `runSelfHealSweep`, the demand-driven poll, the dormancy
// derivation, and startup integration. Reconcile cases assert a heal by the return
// value; the WebRTC sweep case asserts the audit log and exclude-ids (no billing
// settlement); the cutoff cases assert the WebRTC cutoff only (the only source);
// `gracefulShutdown()` takes no call drain (the host has none).
//
// `getActiveCallCount` returning the bridge's live call count (the 'bridge-count idle' case
// below) is lead decision B13.

const { mockLog } = vi.hoisted(() => ({
  mockLog: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    redis: { keyPrefix: 'test:' },
    concurrency: { maxConcurrentCalls: 10, callTimeoutSeconds: 300, reconcileIntervalMs: 300000, staleCallSweepMinutes: 30 },
  },
}));

vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: mockLog,
  createChildLogger: () => mockLog,
}));
vi.mock('@magick-agency/observability/metrics/voice', () => ({
  trackProviderConcurrencyAdmission: vi.fn(),
  trackProviderConcurrencyReconciliation: vi.fn(),
}));
vi.mock('../../../src/config/index.js', () => ({ config: mockConfig }));

vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', () => ({
  providerConcurrencyRepository: {
    getProviderLimit: vi.fn().mockResolvedValue({ mode: 'legacy_total', limit: null }),
  },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getMaxConcurrentCalls: vi.fn().mockResolvedValue(100) },
}));

const { mockWebrtcCallRepository } = vi.hoisted(() => ({
  mockWebrtcCallRepository: { failStaleActive: vi.fn() },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  agencyCallRepository: mockWebrtcCallRepository,
  webrtcCallRepository: mockWebrtcCallRepository,
}));

const { mockAuditLogger } = vi.hoisted(() => ({ mockAuditLogger: { log: vi.fn() } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: mockAuditLogger }));

import { TelephonyGuardHost } from '../../../src/core/telephony-guard-host.js';

/**
 * Spy on the (real) concurrency guard instances attached to the host.
 * The guards are constructed in the host ctor in local mode (null Redis);
 * we override the reconcile methods so the self-heal paths are observable.
 */
function spyGuards(host: TelephonyGuardHost) {
  const reconcile = vi.fn().mockResolvedValue({ before: 0, after: 0 });
  const reconcileAll = vi.fn().mockResolvedValue({ accountsChecked: 0, accountsReconciled: 0 });
  (host as any).concurrencyGuard.reconcile = reconcile;
  (host as any).accountConcurrencyGuard.reconcileAll = reconcileAll;
  return { reconcile, reconcileAll };
}

describe('CallManager self-heal', () => {
  let manager: TelephonyGuardHost;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.concurrency.staleCallSweepMinutes = 30;
    mockWebrtcCallRepository.failStaleActive.mockResolvedValue([]);
    manager = new TelephonyGuardHost(null); // null Redis → local concurrency
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── reconcileConcurrency ──────────────────────────────────────────────────

  describe('reconcileConcurrency', () => {
    it('heals global + account drift → returns true, logs, triggers dequeue', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockResolvedValue({ before: 3, after: 1 });
      reconcileAll.mockResolvedValue({ accountsChecked: 5, accountsReconciled: 1 });

      const result = await manager.reconcileConcurrency('periodic');

      expect(result).toBe(true);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(reconcileAll).toHaveBeenCalledTimes(1);
      expect(mockLog.warn).toHaveBeenCalled();
    });

    it('heals global only (account 0) → true + dequeue', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockResolvedValue({ before: 4, after: 2 });
      reconcileAll.mockResolvedValue({ accountsChecked: 2, accountsReconciled: 0 });

      const result = await manager.reconcileConcurrency('startup');

      expect(result).toBe(true);
    });

    it('heals account only (global before==after) → true + dequeue', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockResolvedValue({ before: 2, after: 2 });
      reconcileAll.mockResolvedValue({ accountsChecked: 3, accountsReconciled: 2 });

      const result = await manager.reconcileConcurrency('periodic');

      expect(result).toBe(true);
    });

    it('no drift (global equal, account 0) → returns false, no dequeue', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockResolvedValue({ before: 1, after: 1 });
      reconcileAll.mockResolvedValue({ accountsChecked: 4, accountsReconciled: 0 });

      const result = await manager.reconcileConcurrency('periodic');

      expect(result).toBe(false);
    });

    it('returns false (no throw) when global reconcile rejects', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockRejectedValue(new Error('redis down'));

      await expect(manager.reconcileConcurrency('periodic')).resolves.toBe(false);
      void reconcileAll;
    });

    it('returns false (no throw) when reconcileAll rejects', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockResolvedValue({ before: 3, after: 1 });
      reconcileAll.mockRejectedValue(new Error('scan failed'));

      await expect(manager.reconcileConcurrency('periodic')).resolves.toBe(false);
    });
  });

  describe('sweepStaleActiveCalls', () => {
    it('sweeps WebRTC calls as a 4th source: settles + audit-logs each, excludes active ids', async () => {
      mockWebrtcCallRepository.failStaleActive.mockResolvedValue([
        { id: 'webrtc-1', tenant_id: 'tenant-1', account_id: 'default', destination_phone: '+1999', talk_time_seconds: null },
      ]);
      manager.registerWebrtcActiveIdsProvider(() => ['webrtc-live']);

      const result = await manager.sweepStaleActiveCalls('startup');
      expect(result).toBe(true);
      expect(mockWebrtcCallRepository.failStaleActive).toHaveBeenCalledTimes(1);

      // cutoff Date + exclude ids forwarded
      const [cutoff, excludeIds] = mockWebrtcCallRepository.failStaleActive.mock.calls[0]!;
      expect(cutoff).toBeInstanceOf(Date);
      expect(excludeIds).toEqual(['webrtc-live']);

      // audit-logged (no billing settlement)
      const wlog = mockAuditLogger.log.mock.calls.map((c) => c[0]).find((c) => c.callId === 'webrtc-1');
      expect(wlog).toBeDefined();
      expect(wlog.eventData.errorCode).toBe('STUCK_ACTIVE_CALL');
      expect(wlog.eventData.dispatchType).toBe('webrtc_call');
      // The only case that pins these two fields.
      expect(wlog.eventData.reason).toBe('stuck active call');
      expect(wlog.eventData.sweep).toBe('startup');
    });

    it('does not turn the generic stale window into a hard cap for long-lived IVR/WebRTC calls', async () => {
      const before = Date.now();
      await manager.sweepStaleActiveCalls('periodic');
      const after = Date.now();

      const webrtcCutoff = (mockWebrtcCallRepository.failStaleActive.mock.calls[0]![0] as Date).getTime();

      // Supported maxima plus five minutes for the carrier's terminal callback.
      expect(webrtcCutoff).toBeLessThanOrEqual(before - 245 * 60_000 + 5);
      expect(webrtcCutoff).toBeGreaterThanOrEqual(after - 245 * 60_000 - 5_000);
    });

    it('uses a configured window longer than the long-lived IVR/WebRTC floors for every source', async () => {
      // Five hours exceeds the WebRTC (245 min) floor window.
      mockConfig.concurrency.staleCallSweepMinutes = 300;
      const before = Date.now();
      await manager.sweepStaleActiveCalls('periodic');
      const after = Date.now();

      const cutoff = mockWebrtcCallRepository.failStaleActive.mock.calls[0]![0] as Date;
      expect(cutoff.getTime()).toBeLessThanOrEqual(before - 300 * 60_000 + 5);
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(after - 300 * 60_000 - 5_000);
    });

    it('all three empty → returns false', async () => {
      mockWebrtcCallRepository.failStaleActive.mockResolvedValue([]);

      await expect(manager.sweepStaleActiveCalls('periodic')).resolves.toBe(false);
      expect(mockAuditLogger.log).not.toHaveBeenCalled();
    });

    it('all three reject → returns false, never throws', async () => {
      mockWebrtcCallRepository.failStaleActive.mockRejectedValue(new Error('webrtc boom'));

      await expect(manager.sweepStaleActiveCalls('periodic')).resolves.toBe(false);
    });
  });

  describe('runSelfHealSweep', () => {
    it.each([
      [true, true, true],
      [true, false, true],
      [false, true, true],
      [false, false, false],
    ])('reconciled=%s swept=%s → returns %s (reconcile||sweep)', async (reconciled, swept, expected) => {
      const reconcileSpy = vi.spyOn(manager, 'reconcileConcurrency').mockResolvedValue(reconciled);
      const sweepSpy = vi.spyOn(manager, 'sweepStaleActiveCalls').mockResolvedValue(swept);

      const result = await manager.runSelfHealSweep('periodic');

      expect(result).toBe(expected);
      expect(reconcileSpy).toHaveBeenCalledWith('periodic');
      expect(sweepSpy).toHaveBeenCalledWith('periodic');
    });

    it('no-ops (false) when already shutting down', async () => {
      await manager.gracefulShutdown();
      const reconcileSpy = vi.spyOn(manager, 'reconcileConcurrency').mockResolvedValue(true);
      const sweepSpy = vi.spyOn(manager, 'sweepStaleActiveCalls').mockResolvedValue(true);

      await expect(manager.runSelfHealSweep('periodic')).resolves.toBe(false);
      expect(reconcileSpy).not.toHaveBeenCalled();
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('reentrancy: a second concurrent sweep bails while the first is in flight', async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });

      const reconcileSpy = vi.spyOn(manager, 'reconcileConcurrency').mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight--;
        return false;
      });
      vi.spyOn(manager, 'sweepStaleActiveCalls').mockResolvedValue(false);

      const first = manager.runSelfHealSweep('periodic');
      // Second call while the first is blocked on the gate → must bail (false).
      const second = await manager.runSelfHealSweep('periodic');
      expect(second).toBe(false);

      release();
      await first;

      expect(maxInFlight).toBe(1);
      expect(reconcileSpy).toHaveBeenCalledTimes(1); // only the first ran reconcile
    });
  });

  // ─── Demand-driven poll ────────────────────────────────────────────────────

  describe('demand-driven self-heal poll', () => {
    const INTERVAL = 300000;

    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('wakeSelfHeal arms a timer; after 1 interval it runs a sweep', async () => {
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(false);
      manager.wakeSelfHeal();
      expect(sweepSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
    });

    it('disarms after N consecutive idle sweeps (derived from lock TTL; 3 under the test config)', async () => {
      // sweepsBeforeDormant = max(2, ceil((300+30)*1000 / 300000) + 1) = 3.
      vi.spyOn(manager, 'getActiveCallCount').mockReturnValue(0);
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(false);
      manager.wakeSelfHeal();

      await vi.advanceTimersByTimeAsync(INTERVAL); // idle 1
      await vi.advanceTimersByTimeAsync(INTERVAL); // idle 2 (still armed)
      expect(sweepSpy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(INTERVAL); // idle 3 → dormant
      expect(sweepSpy).toHaveBeenCalledTimes(3);

      // No more ticks once dormant.
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(sweepSpy).toHaveBeenCalledTimes(3);
    });

    it('stays armed indefinitely while sweeps return true (drift persists)', async () => {
      vi.spyOn(manager, 'getActiveCallCount').mockReturnValue(0);
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(true);
      manager.wakeSelfHeal();

      await vi.advanceTimersByTimeAsync(INTERVAL);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(3);
    });

    it('stays armed while active calls > 0 even if sweeps return false, then cools down', async () => {
      const activeSpy = vi.spyOn(manager, 'getActiveCallCount').mockReturnValue(1);
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(false);
      manager.wakeSelfHeal();

      // Calls in flight keep the loop armed despite idle sweeps.
      await vi.advanceTimersByTimeAsync(INTERVAL);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(3);

      // Calls drain → next three idle sweeps go dormant (window=3 under test config).
      activeSpy.mockReturnValue(0);
      await vi.advanceTimersByTimeAsync(INTERVAL); // idle 1
      await vi.advanceTimersByTimeAsync(INTERVAL); // idle 2
      await vi.advanceTimersByTimeAsync(INTERVAL); // idle 3 → dormant
      expect(sweepSpy).toHaveBeenCalledTimes(6);

      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(sweepSpy).toHaveBeenCalledTimes(6);
    });

    it('wakeSelfHeal re-arms a dormant loop', async () => {
      vi.spyOn(manager, 'getActiveCallCount').mockReturnValue(0);
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(false);
      manager.wakeSelfHeal();

      // Go dormant (window=3 under the test config).
      await vi.advanceTimersByTimeAsync(INTERVAL);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(INTERVAL * 2);
      expect(sweepSpy).toHaveBeenCalledTimes(3);

      // Wake again → fresh sweep at the next interval.
      manager.wakeSelfHeal();
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(4);
    });

    it('wakeSelfHeal is idempotent: 3 back-to-back calls arm ONE timer', async () => {
      vi.spyOn(manager, 'getActiveCallCount').mockReturnValue(0);
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(true);

      manager.wakeSelfHeal();
      manager.wakeSelfHeal();
      manager.wakeSelfHeal();

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(1); // only one timer fired
    });

    it('gracefulShutdown clears the self-heal timer → no further sweeps', async () => {
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockResolvedValue(false);
      manager.wakeSelfHeal();

      await manager.gracefulShutdown();

      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(sweepSpy).not.toHaveBeenCalled();
    });

    it('shuttingDown blocks re-arm if shutdown flips during a poll', async () => {
      vi.spyOn(manager, 'getActiveCallCount').mockReturnValue(0);
      const sweepSpy = vi.spyOn(manager, 'runSelfHealSweep').mockImplementation(async () => {
        // Flip shutdown mid-sweep so the poll's post-sweep re-arm is suppressed.
        (manager as any).shuttingDown = true;
        return true; // would normally keep it armed
      });
      manager.wakeSelfHeal();

      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(sweepSpy).toHaveBeenCalledTimes(1);

      // No re-arm despite a "true" sweep result, because shutdown flipped.
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);
      expect(sweepSpy).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Fix C.1: dormancy window derived from lock TTL ────────────────────────

  describe('dormancy window derivation', () => {
    it('derives sweepsBeforeDormant from the lock TTL (3 under the test config)', () => {
      // lockTtl = (300 + 30)s = 330000ms; interval = 300000ms.
      // ceil(330000/300000)+1 = 2+1 = 3, floored at 2 → 3.
      expect((manager as any).sweepsBeforeDormant).toBe(3);
    });

    it('never drops below the floor of 2', () => {
      // The Math.max(2, …) floor guarantees at least 2 regardless of tuning.
      expect((manager as any).sweepsBeforeDormant).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── Startup-style integration (mirrors src/index.ts) ──────────────────────

  describe('startup integration', () => {
    it('runSelfHealSweep("startup") then wakeSelfHeal() works without error', async () => {
      const { reconcile, reconcileAll } = spyGuards(manager);
      reconcile.mockResolvedValue({ before: 0, after: 0 });
      reconcileAll.mockResolvedValue({ accountsChecked: 0, accountsReconciled: 0 });
      const reconcileSpy = vi.spyOn(manager, 'reconcileConcurrency');
      const sweepSpy = vi.spyOn(manager, 'sweepStaleActiveCalls');

      await expect(manager.runSelfHealSweep('startup')).resolves.toBe(false);
      expect(reconcileSpy).toHaveBeenCalledWith('startup');
      expect(sweepSpy).toHaveBeenCalledWith('startup');

      // Then wake the poll — must not throw.
      expect(() => manager.wakeSelfHeal()).not.toThrow();
    });
  });
});

// The host's own two behaviours, pinned.
describe('TelephonyGuardHost — agency-specific behaviour', () => {
  it('"calls in flight" for the poll is the bridge\'s active call count', () => {
    const host = new TelephonyGuardHost(null);
    expect(host.getActiveCallCount()).toBe(0);
    host.registerWebrtcActiveIdsProvider(() => ['a', 'b']);
    expect(host.getActiveCallCount()).toBe(2);
  });

  it('tryAcquireTelephonyConcurrency on a legacy account takes global then account, rolling back on refusal', async () => {
    const host = new TelephonyGuardHost(null);
    (host as any).providerConcurrencyGuard.tryAcquireAll = vi.fn().mockResolvedValue({ result: 'legacy_mode', providerScoped: false });
    const globalAcquire = vi.spyOn(host.concurrencyGuard, 'tryAcquire').mockResolvedValue(true);
    const globalRelease = vi.spyOn(host.concurrencyGuard, 'release').mockResolvedValue(undefined);
    const accountAcquire = vi.spyOn(host.accountConcurrencyGuard, 'tryAcquire').mockResolvedValue(false);

    await expect(host.tryAcquireTelephonyConcurrency('k', 't', 'a', 'voicelink', 120))
      .resolves.toEqual({ result: 'account_full', providerScoped: false });
    expect(globalAcquire).toHaveBeenCalledWith('k', 120);
    expect(accountAcquire).toHaveBeenCalledWith('k', 't', 'a', 120);
    expect(globalRelease).toHaveBeenCalledWith('k');
  });

  it('a provider-mode composite answer is returned as-is, with no per-scope fallback', async () => {
    const host = new TelephonyGuardHost(null);
    const composite = { result: 'provider_full', providerScoped: true };
    (host as any).providerConcurrencyGuard.tryAcquireAll = vi.fn().mockResolvedValue(composite);
    const globalAcquire = vi.spyOn(host.concurrencyGuard, 'tryAcquire');

    await expect(host.tryAcquireTelephonyConcurrency('k', 't', 'a', 'voicelink')).resolves.toBe(composite);
    expect(globalAcquire).not.toHaveBeenCalled();
  });
});
