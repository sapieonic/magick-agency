import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stale-call sweep lifecycle for the WebRTC calls. The unit under test is
// `TelephonyGuardHost` (apps/server/src/core/telephony-guard-host.ts), which runs
// the self-heal sweep over WebRTC rows only and settles nothing (decision S6).
// Only the modules the guard host loads are mocked: the logger
// (@magick-agency/observability, with the real `Traced` decorator, which the
// guards import from it), the voice metrics, the agency-call repository
// (`agencyCallRepository`, with the `webrtcCallRepository` alias), the
// provider-concurrency and account-settings repositories, config and audit.
//
// Because the host dispatches no settlement, "nothing swept" is observed as no
// stuck-call audit event, and an above-cap sweep is checked by every stale row
// being failed and audited exactly once. The child logger mock returns ONE shared
// spy (`logSpy`) so the host's shutdown log line is observable.

// High-altitude lifecycle scenarios for the stale-call incident. The real guard
// host owns sweep cutoffs; persistence and provider calls are mutable in-memory
// boundaries, so the sweep sees the same rows as in production (and therefore
// reproduces the production race).

type Row = Record<string, any>;

const stores = vi.hoisted(() => {
  const webrtc = new Map<string, Row>();

  const failRows = (
    rows: Map<string, Row>,
    olderThan: Date,
    excludeIds: string[] = [],
    ageField: 'initiated' | 'created' = 'initiated',
  ): Row[] => {
    const excluded = new Set(excludeIds);
    const failed: Row[] = [];
    for (const row of rows.values()) {
      const active = ['initiating', 'ringing', 'in_progress'].includes(row.status)
        || (row.status === 'voicemail' && row.ended_at == null);
      const anchor = ageField === 'created'
        ? row.created_at
        : (row.initiated_at ?? row.created_at);
      if (!active || excluded.has(row.id) || new Date(anchor).getTime() >= olderThan.getTime()) continue;

      Object.assign(row, {
        status: 'failed',
        outcome: 'stuck_active_call',
        error_code: 'STUCK_ACTIVE_CALL',
        error_message: 'stuck active call',
        ended_at: new Date(),
      });
      failed.push(row);
    }
    return failed;
  };

  return { webrtc, failRows };
});

const mocks = vi.hoisted(() => ({
  webrtcFailStale: vi.fn(async (olderThan: Date, excludeIds: string[] = []) =>
    stores.failRows(stores.webrtc, olderThan, excludeIds, 'created')),
  auditLog: vi.fn(),
}));

// One shared child-logger spy, so the host's shutdown log line is observable.
const { logSpy } = vi.hoisted(() => ({
  logSpy: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@magick-agency/db/repositories/provider-concurrency.repository', () => ({
  providerConcurrencyRepository: {
    getProviderLimit: vi.fn().mockResolvedValue({ mode: 'legacy_total', limit: null }),
  },
}));

// The guards import `Traced` from the logger's package; the real decorator is forwarded.
vi.mock('@magick-agency/observability', async () => ({
  Traced: (await import('@magick-agency/observability/tracing')).Traced,
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => logSpy,
}));

vi.mock('@magick-agency/observability/metrics/voice', () => ({
  trackProviderConcurrencyAdmission: vi.fn(),
  trackProviderConcurrencyReconciliation: vi.fn(),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: 'scenario:' },
    concurrency: {
      maxConcurrentCalls: 20,
      callTimeoutSeconds: 300,
      reconcileIntervalMs: 300_000,
      staleCallSweepMinutes: 30,
    },
    callDefaults: { machineDetection: false, hangupOnMachine: false },
    telephony: {
      defaultProvider: 'vobiz',
      vobiz: { webhookBaseUrl: 'https://voice.test/api/v1/webhooks/vobiz' },
      plivo: { webhookBaseUrl: 'https://voice.test/api/v1/webhooks/plivo' },
      twilio: { webhookBaseUrl: 'https://voice.test/api/v1/webhooks/twilio' },
      telnyx: { webhookBaseUrl: 'https://voice.test/api/v1/webhooks/telnyx' },
      exotel: { webhookBaseUrl: '', flowUrl: '' },
    },
    ai: { bargeInGracePeriodMs: 5_000, prewarmEnabled: false, prewarmRingDelayMs: 0 },
    postCallAnalysis: {
      enabled: false,
      provider: 'openai',
      model: 'gpt-4o-mini',
      timeoutMs: 30_000,
      maxConversationTurns: 200,
    },
    webhooks: { secret: 'scenario-secret', timeoutMs: 5_000, maxRetries: 1 },
  },
}));

vi.mock('@magick-agency/db/repositories/agency-call.repository', () => {
  const repo = { failStaleActive: mocks.webrtcFailStale };
  return { agencyCallRepository: repo, webrtcCallRepository: repo };
});

vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: {
    getMaxConcurrentCalls: vi.fn().mockResolvedValue(20),
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getAnalyzeCalls: vi.fn().mockResolvedValue(null),
    getDefaultAiPipeline: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: mocks.auditLog } }));

import { TelephonyGuardHost } from '../../../src/core/telephony-guard-host.js';

const NOW = new Date('2026-08-02T10:00:00.000Z');
const TENANT = 'tenant-incident';
const ACCOUNT = 'account-incident';

function ago(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000);
}

function baseRow(id: string, createdMinutesAgo = 180): Row {
  return {
    id,
    tenant_id: TENANT,
    account_id: ACCOUNT,
    batch_id: 'batch-incident',
    status: 'queued',
    initiated_at: null,
    answered_at: null,
    ended_at: null,
    duration_seconds: null,
    talk_time_seconds: null,
    created_at: ago(createdMinutesAgo),
    updated_at: ago(createdMinutesAgo),
  };
}

describe('stale-call sweep lifecycle — dequeue, answer, and recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    stores.webrtc.clear();
    // `clearAllMocks` keeps implementations, so undo a previous case's wedge.
    mocks.webrtcFailStale.mockImplementation(async (olderThan: Date, excludeIds: string[] = []) =>
      stores.failRows(stores.webrtc, olderThan, excludeIds, 'created'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses product-duration floors: a 45-minute IVR and 3-hour WebRTC call survive a generic 30-minute sweep', async () => {
    const webrtc: Row = {
      ...baseRow('webrtc-legitimate-long', 180),
      batch_id: null,
      status: 'in_progress',
      caller_id: '+911234567890',
      destination_phone: '+919876543210',
      provider: 'vobiz',
      outcome: null,
      error_code: null,
      error_message: null,
    };
    stores.webrtc.set(webrtc.id, webrtc);
    const manager = new TelephonyGuardHost(null);

    await expect(manager.sweepStaleActiveCalls('periodic')).resolves.toBe(false);

    expect(webrtc.status).toBe('in_progress');
    expect(mocks.webrtcFailStale).toHaveBeenCalledWith(
      new Date(NOW.getTime() - 245 * 60_000),
      [],
    );
    // The host settles nothing, so "nothing swept" is observed as no stuck-call audit event.
    expect(mocks.auditLog).not.toHaveBeenCalled();
  });

  it('bounds the WebRTC stale sweep too — the FIFTH copy of the loop', async () => {
    // Found only by re-reading the tree after the fix shipped. It has its own
    // sweep (a WebRTC call has no `batch_id`, so it cannot go through
    // `sweepStaleRows`), which is precisely why the file-level source assertion
    // in `settlement-fanout-wiring.test.ts` could not see it: `call-manager.ts`
    // already contained the bounded calls further down.
    // Three times the default fan-out cap of 10, written out as the literal 30.
    const rowCount = 30;
    for (let i = 0; i < rowCount; i += 1) {
      const row: Row = {
        ...baseRow(`webrtc-stale-${i}`, 300),
        batch_id: null,
        status: 'in_progress',
        caller_id: '+911234567890',
        destination_phone: '+919876543210',
        provider: 'vobiz',
        outcome: null,
        error_code: null,
        error_message: null,
      };
      stores.webrtc.set(row.id, row);
    }

    const manager = new TelephonyGuardHost(null);
    await expect(manager.sweepStaleActiveCalls('startup')).resolves.toBe(true);

    // The host dispatches no settlement; the point is that an above-cap sweep still
    // recovers every stale row — each failed and audited exactly once.
    for (const row of stores.webrtc.values()) {
      expect(row.status).toBe('failed');
      expect(row.error_code).toBe('STUCK_ACTIVE_CALL');
    }
    expect(mocks.auditLog).toHaveBeenCalledTimes(rowCount);
    expect(mocks.auditLog).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'call.failed',
      eventData: expect.objectContaining({ errorCode: 'STUCK_ACTIVE_CALL', dispatchType: 'webrtc_call' }),
    }));
  });

  // ── The in-flight poll and shutdown ──────────────────────────────────────
  //
  // `runSelfHealPoll` nulls its own timer at entry and detaches, so
  // `gracefulShutdown`'s `clearTimeout` cannot stop a sweep that has already
  // started. That matters because the sweep FANS OUT: it stamps rows `failed`
  // and enqueues their settlements, so a sweep finishing after shutdown has
  // moved on has its releases drained by nobody and killed by `closePool()` —
  // rows terminal in the database, holds never released, and
  // `webhook_fanout_abandoned_total` reading zero over all of it.

  /** Hold `webrtcFailStale` open, so a sweep can be parked mid-flight. */
  // The host's only sweep is the WebRTC one.
  function wedgeWebrtcSweep() {
    const real = mocks.webrtcFailStale.getMockImplementation()!;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    mocks.webrtcFailStale.mockImplementation(async (olderThan: Date, excludeIds: string[] = []) => {
      await gate;
      return real(olderThan, excludeIds);
    });
    return { open };
  }

  it('shutdown waits for an in-flight poll, and a poll re-armed mid-sweep cannot cancel that wait', async () => {
    // The C1 half: `selfHealInFlight` was assigned unconditionally, so a timer
    // re-armed by ordinary call activity could fire DURING a sweep and replace
    // the running poll's promise with its own. The second body returns almost
    // immediately (`runSelfHealSweep` refuses re-entry via `selfHealing`), and
    // its `.finally` then nulled the field — so shutdown awaited nothing while
    // the real sweep was still going. Both halves are needed for this to bite,
    // which is why the test drives both.
    // Three times the default fan-out cap of 10, as stale WebRTC rows.
    const rowCount = 30;
    for (let i = 0; i < rowCount; i += 1) {
      const row: Row = {
        ...baseRow(`webrtc-poll-${i}`, 300),
        batch_id: null,
        status: 'in_progress',
        caller_id: '+911234567890',
        destination_phone: '+919876543210',
        provider: 'vobiz',
        outcome: null,
        error_code: null,
        error_message: null,
      };
      stores.webrtc.set(row.id, row);
    }
    const wedge = wedgeWebrtcSweep();

    const manager = new TelephonyGuardHost(null);
    manager.wakeSelfHeal();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(mocks.webrtcFailStale).toHaveBeenCalledTimes(1);

    // A call starting or ending mid-sweep re-arms the timer; the next tick then
    // lands while the first poll is still parked in the repository.
    manager.wakeSelfHeal();
    await vi.advanceTimersByTimeAsync(300_000);

    let shutdownDone = false;
    const shutdown = manager.gracefulShutdown().then(() => { shutdownDone = true; });
    await vi.advanceTimersByTimeAsync(0);

    // THE assertion: shutdown is still holding for the real sweep. With the
    // overwrite it had already returned here.
    expect(shutdownDone).toBe(false);

    wedge.open();
    await vi.advanceTimersByTimeAsync(0);
    await shutdown;
    expect(shutdownDone).toBe(true);

    // The host settles nothing; what the wait bought is that the sweep finished
    // before shutdown returned — every stale row failed and audited.
    for (const row of stores.webrtc.values()) {
      expect(row.status).toBe('failed');
    }
    expect(mocks.auditLog).toHaveBeenCalledTimes(rowCount);
    expect(logSpy.error).not.toHaveBeenCalledWith(
      expect.anything(),
      'Self-heal sweep did not finish within the shutdown budget — proceeding without it',
    );
  });

  it('bounds that wait, so a wedged sweep cannot hold the whole shutdown open', async () => {
    // The C2 half. The wait sits in FRONT of the 60s call drain, the fan-out
    // drain and `closePool()`, and the sweep's own work is `UPDATE ... LIMIT
    // 1000` against a pool with no `statement_timeout`. Unbounded, one stuck row
    // lock meant shutdown never reached the drain at all and was SIGKILLed with
    // the whole queue in memory — strictly worse than the loss the wait exists
    // to prevent.
    //
    // Deliberately advanced by exactly the budget (`SELF_HEAL_SHUTDOWN_WAIT_MS`, 15s),
    // asserting shutdown has resolved by then and that the give-up log carries
    // `waitMs: 15_000` — so it pins the constant as well as the bound. A change to
    // the budget is meant to red here and be re-decided.
    const wedge = wedgeWebrtcSweep();

    const manager = new TelephonyGuardHost(null);
    manager.wakeSelfHeal();
    await vi.advanceTimersByTimeAsync(300_000);

    let shutdownDone = false;
    const shutdown = manager.gracefulShutdown().then(() => { shutdownDone = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(shutdownDone).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(shutdownDone).toBe(true);
    await shutdown;

    // Giving up is not an all-clear: the sweep is still running and may yet
    // enqueue settlements nothing will drain, so the fan-out refuses to report
    // a clean drain over an empty queue afterwards.
    // The host's record of giving up is its error line.
    expect(logSpy.error).toHaveBeenCalledWith(
      { waitMs: 15_000 },
      'Self-heal sweep did not finish within the shutdown budget — proceeding without it',
    );

    wedge.open();
    await vi.advanceTimersByTimeAsync(0);
  });
});
