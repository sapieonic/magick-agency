// PORT NOTE (magick-agency, Phase 6): ported from core test/unit/agency/reaper.test.ts@4850d1d9 (41 → 41).
// Import/mock paths only (account settings, `webrtc-call.repository` → `agency-call.repository`,
// the metric reader is core's helper at the same path, see `test/helpers/otel-metric-reader.ts`), plus part B (the real bridge), which
// ran on VoBiz and now runs on VoiceLink (VoBiz and SIP deleted, plan §5): the `settlement-dispatcher`
// mock is gone (module deleted); the campaign fixture says `voicelink` and drops `sip_connection_id`;
// `intoGraceWindow` answers with VoiceLink's `start` frame on the PSTN socket (VoBiz's `<Stream>`
// connect was the answer); 'reaps the same attempt once the window has actually lapsed' drives the
// carrier's `call.ended` after the 30s advance, because an answered VoiceLink hangup waits in `ending`
// for it (45s timeout) where VoBiz finalized at once (without it that case reds). No case deleted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// AD-P2-C-08 — the periodic reaper and the no_disposition sweep.
//
// Crash recovery (§6.2). `gracefulShutdown` handles SIGTERM. It does not handle
// SIGKILL, OOM or a hard crash, and those strand contacts in `in_flight` (never
// re-claimed) and attempts in non-terminal states (counted against the tick's
// occupancy, permanently shrinking the dialing target).
//
// ── Why this file is shaped the way it is ─────────────────────────────────────
//
// The version of it that shipped with `AD-P1-C-08` contained a test named
// "only reaps attempts older than the leak threshold — never a live call" whose
// entire body asserted `Date.now() - cutoff > 1 hour`. That is §16.6's first
// question failing in one line: **it supplied the answer to the question it
// claimed to ask.** "Never a live call" was the claim; "the cutoff is a big
// number" was the check. The sweep consulted nothing about liveness at all, and
// the suite could not see it, because a large threshold was being treated as the
// safety property rather than as a filter.
//
// So the liveness assertions here are made against the REAL `AgencyDialer`,
// `StationRegistry` and `WebRtcBridgeManager` (part B), not against a stubbed
// deps object. The hardest instance of acceptance (c) is not the 30-call soak —
// it is a call inside the `AD-P2-C-07` deferred-hangup window, whose agent socket
// is *gone* and whose carrier leg is *live*. Part B establishes from observable
// bridge state that such a call is invisible to every liveness signal except the
// one arm that protects it.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' },
      voicelink: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/voicelink' },
    },
  },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      // Startup path.
      reapNonTerminal: vi.fn().mockResolvedValue([]),
      // Periodic leak path — a read and a guarded write, deliberately separate.
      findNonTerminalOlderThan: vi.fn().mockResolvedValue([]),
      reapByIds: vi.fn().mockResolvedValue([]),
      // Auto-disposition path.
      findLapsedWrapups: vi.fn().mockResolvedValue([]),
      recordAutoDisposition: vi.fn(),
      // Needed by the real dialer in part B.
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    contact: {
      // ⚠️ `true` — `markState` RETURNS whether the requested state landed, and
      // resolving `undefined` silently models a DNC refusal, which gates the
      // retirement counter below.
      markState: vi.fn().mockResolvedValue(true),
      unclaim: vi.fn().mockResolvedValue(undefined),
      // The OUR-FAULT ledger (`AD-P3-C-09`), separate from `attempt_count`.
      // Returns the post-bump count, which is what the bound is evaluated on —
      // `1` means "this is the first our-fault redial", so every existing case
      // below stays well inside the bound and keeps asserting the requeue.
      chargeOurFaultAttempt: vi.fn().mockResolvedValue(1),
    },
    session: {
      markAllOffline: vi.fn().mockResolvedValue(0),
      setState: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
  agencyCampaignRepository: {},
}));

// The retry seam is spied but NOT stubbed — the real decision runs, so a test
// asserting the contact lands in `completed` is observing the policy's answer
// rather than a mock's. Acceptance (b) wants the call proven; §16.6 rule 1 wants
// the answer to come from the code under test.
const { retrySpy } = vi.hoisted(() => ({ retrySpy: vi.fn() }));
vi.mock('../../../src/agency/retry-policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/agency/retry-policy.js')>();
  return {
    ...actual,
    resolveRetryDecision: (...args: Parameters<typeof actual.resolveRetryDecision>) => {
      retrySpy(...args);
      return actual.resolveRetryDecision(...args);
    },
  };
});

// ── Doubles the real bridge needs (part B only) ─────────────────────────────
const { mockWebrtcRepo } = vi.hoisted(() => ({
  mockWebrtcRepo: {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mockWebrtcRepo,
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: { getAllowRecording: vi.fn().mockResolvedValue(null) },
}));
const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response><Stream/></Response>'),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class { get() { return mockAdapter; } },
}));
// PORT NOTE: core mocked `src/webhooks/settlement-dispatcher.js` here; the bridge's
// settlement dispatch is deleted (plan §5, lane C), so there is nothing to double.
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));
// `isEnabled` and `agency_late_binding` are here because `executeDial` resolves
// the late-binding flag on every dial. `false` keeps these cases on the
// early-binding path they were written for — the flag's own registry default, so
// this double agrees with production for a tenant nobody has enrolled.
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => ({
    getValue: vi.fn().mockResolvedValue(1800),
    isEnabled: vi.fn().mockResolvedValue(false),
  }),
  FLAGS: {
    webrtc_max_duration_seconds: { default: 1800 },
    agency_late_binding: { key: 'agency_late_binding', type: 'boolean', default: false },
  },
}));

import { AgencyReaper, type AgencyReaperDeps } from '../../../src/agency/reaper.js';
// The real meter provider, installed before `metrics.ts` creates its instruments:
// the claim is about the value an export (or the `:9090` scrape) would read.
const { reader } = await vi.hoisted(async () => {
  const { installMetricReader } = await import('../../helpers/otel-metric-reader.js');
  return { reader: installMetricReader() };
});
import { collectMetric } from '../../helpers/otel-metric-reader.js';
import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';
import { AgencyDialer } from '../../../src/agency/agency-dialer.js';
import { AgentStateMachine, AGENT_LEASE_MS } from '../../../src/agency/agent-state-machine.js';
import { StationRegistry } from '../../../src/agency/station-registry.js';
import { BreakRegistry } from '@magick-agency/domain/break-manager';
import { AUTO_DISPOSITION_CODE } from '../../../src/agency/disposition.js';
import type { DialCommand } from '../../../src/agency/dial-dispatcher.js';

/** The constants under test, restated so a drift shows up here rather than live. */
const SWEEP_INTERVAL_MS = 60_000;
const EXPECTED_LEAK_THRESHOLD_MS = 5 * 60 * 1000;
const EXPECTED_WRAPUP_GRACE_SECONDS = 120;

// ─── Deps helpers ──────────────────────────────────────────────────────────

/** Nothing is alive. The default for every leak-sweep test that isn't about liveness. */
function noDeps(over: Partial<AgencyReaperDeps> = {}): AgencyReaperDeps {
  return { activeAttemptIds: () => [], ownerOf: async () => null, ...over };
}

function attemptRow(over: Record<string, unknown> = {}): any {
  return {
    id: 'att-1', contact_id: 'c1', reserved_agent_id: null, state: 'ringing',
    outcome: null, disposition_code: null, bridged_at: new Date(), ended_at: new Date(),
    wrapup_seconds: 30, campaign_disposition_catalog: [], campaign_retry_policy: null,
    // The contact's retry budget (`AD-P3-C-01`). Deliberately NOT 0: a default of 0
    // would make "the reaper forwards the stored count" and "the reaper forwards
    // zero" indistinguishable in every test that does not override it.
    contact_attempt_count: 2,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repos.attempt.reapNonTerminal.mockResolvedValue([]);
  repos.attempt.findNonTerminalOlderThan.mockResolvedValue([]);
  repos.attempt.reapByIds.mockResolvedValue([]);
  repos.attempt.findLapsedWrapups.mockResolvedValue([]);
  // The guarded UPDATE's success case: it returns the row it stamped.
  repos.attempt.recordAutoDisposition.mockImplementation(async (id: string, code: string) =>
    ({ id, disposition_code: code }));
  repos.session.markAllOffline.mockResolvedValue(0);
});

// ═══ PART A — startup, and the leak sweep's decision ════════════════════════

describe('AgencyReaper startup', () => {
  it('reaps EVERY non-terminal attempt regardless of age (D2)', async () => {
    repos.attempt.reapNonTerminal.mockResolvedValue([
      { id: 'a1', contact_id: 'c1' }, { id: 'a2', contact_id: 'c2' },
    ]);
    const result = await new AgencyReaper(noDeps()).reapOnStartup();

    // With one replica, ANY non-terminal attempt at boot is dead by definition —
    // there is no other process that could own it. Hence a null age threshold.
    expect(repos.attempt.reapNonTerminal).toHaveBeenCalledWith(null);
    expect(result.attempts).toBe(2);
  });

  it('asks NOTHING about liveness at boot — and must not', async () => {
    // The inverse of the periodic sweep's rule, and the reason the two paths are
    // separate methods. Nothing can be alive in a process that has not finished
    // starting, so consulting `liveByAttempt` (empty) or Redis (holding keys the
    // DEAD process wrote, TTLs not yet lapsed) would at best be noise and at
    // worst would decline to reap the very rows startup exists to clear.
    const ownerOf = vi.fn().mockResolvedValue('some-replica');
    const activeAttemptIds = vi.fn().mockReturnValue([]);
    repos.attempt.reapNonTerminal.mockResolvedValue([
      { id: 'a1', contact_id: 'c1', reserved_agent_id: 'sess-1' },
    ]);

    const result = await new AgencyReaper(noDeps({ ownerOf, activeAttemptIds })).reapOnStartup();

    expect(ownerOf).not.toHaveBeenCalled();
    expect(activeAttemptIds).not.toHaveBeenCalled();
    expect(result.attempts).toBe(1);
  });

  it('returns every orphaned contact to the roster as dialable', async () => {
    repos.attempt.reapNonTerminal.mockResolvedValue([{ id: 'a1', contact_id: 'c1' }]);
    await new AgencyReaper(noDeps()).reapOnStartup();

    // A contact left `in_flight` is invisible to the tick forever, so the campaign
    // silently loses it and can never complete.
    expect(repos.contact.markState).toHaveBeenCalledWith('c1', 'pending', expect.objectContaining({
      last_outcome: 'orphaned',
      next_attempt_at: expect.any(Date),
    }));
  });

  it('marks every agent offline — no socket survived the crash', async () => {
    repos.session.markAllOffline.mockResolvedValue(3);
    const result = await new AgencyReaper(noDeps()).reapOnStartup();

    // They rehydrate into `break` on reconnect, never `available` (D2): the engine
    // must not dial into a pool that has not demonstrably re-attached.
    expect(repos.session.markAllOffline).toHaveBeenCalled();
    expect(result.agents).toBe(3);
  });

  it('keeps going when one contact fails to requeue', async () => {
    repos.attempt.reapNonTerminal.mockResolvedValue([
      { id: 'a1', contact_id: 'c1' }, { id: 'a2', contact_id: 'c2' },
    ]);
    repos.contact.markState.mockRejectedValueOnce(new Error('db blip'));

    // One bad row must not abort recovery and leave the rest stranded — and it
    // must not prevent agents being marked offline.
    await expect(new AgencyReaper(noDeps()).reapOnStartup()).resolves.toMatchObject({ attempts: 2 });
    expect(repos.contact.markState).toHaveBeenCalledTimes(2);
    expect(repos.session.markAllOffline).toHaveBeenCalled();
  });

  it('is a quiet no-op on a clean boot', async () => {
    const result = await new AgencyReaper(noDeps()).reapOnStartup();
    expect(result).toEqual({ attempts: 0, agents: 0 });
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });
});

describe('AgencyReaper leak sweep — what it decides on', () => {
  it('never calls the boot-only reaper, whose justification does not hold here', async () => {
    // The shipped defect, locked. `reapNonTerminal`'s own comment says "ANY
    // non-terminal attempt found AT BOOT is dead by definition"; the periodic
    // sweep called it anyway with an age cutoff, silently widening a boot-only
    // argument into a general one. An *accurate* comment whose scope a second
    // caller exceeded — §16.6 rule 3's nastier variant, since a reviewer reads a
    // correct justification and never asks whether this caller is at boot.
    await new AgencyReaper(noDeps()).sweepOnce();
    expect(repos.attempt.reapNonTerminal).not.toHaveBeenCalled();
  });

  it('uses age only to narrow candidates, at exactly the documented floor', async () => {
    const before = Date.now();
    await new AgencyReaper(noDeps()).sweepOnce();
    const after = Date.now();

    const cutoff = repos.attempt.findNonTerminalOlderThan.mock.calls[0]![0] as Date;
    // EXACT value, not `> some big number`. The predecessor's `> 1 hour` both hid
    // the missing liveness check and would have silently accepted any regrowth of
    // the threshold; a bound this tight fails the moment the constant moves.
    //
    // Which end each bound is measured from is load-bearing, not incidental.
    // `sweepOnce` builds the cutoff from its OWN `Date.now()`, at some instant T
    // with `before <= T <= after`, so `cutoff = T - THRESHOLD`. That makes
    // `after - cutoff >= THRESHOLD` and `before - cutoff <= THRESHOLD`, and both
    // are tight: the pair pins the threshold to the millisecond while staying
    // true for every legal T. Measuring the lower bound from `before` instead
    // asserted `THRESHOLD - (T - before) >= THRESHOLD`, which holds only when the
    // clock does not tick across the awaits — green on a quiet machine and red at
    // 299999 the moment one millisecond passes.
    expect(after - cutoff.getTime()).toBeGreaterThanOrEqual(EXPECTED_LEAK_THRESHOLD_MS);
    expect(before - cutoff.getTime()).toBeLessThanOrEqual(EXPECTED_LEAK_THRESHOLD_MS);

    // And the floor is SHORT — the point of the change. A threshold long enough to
    // outlast a call is a threshold pretending to be a liveness check.
    expect(EXPECTED_LEAK_THRESHOLD_MS).toBeLessThan(60 * 60 * 1000);
  });

  it('skips an attempt this replica is driving (arm 1)', async () => {
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'live-1', contact_id: 'c-live' }),
      attemptRow({ id: 'leak-1', contact_id: 'c-leak' }),
    ]);
    repos.attempt.reapByIds.mockResolvedValue([{ id: 'leak-1', contact_id: 'c-leak' }]);

    const reaped = await new AgencyReaper(noDeps({ activeAttemptIds: () => ['live-1'] })).sweepOnce();

    expect(repos.attempt.reapByIds).toHaveBeenCalledWith(['leak-1']);
    expect(reaped).toBe(1);
    expect(repos.contact.markState).toHaveBeenCalledTimes(1);
    expect(repos.contact.markState).toHaveBeenCalledWith('c-leak', 'pending', expect.anything());
  });

  it('skips an attempt whose agent is held by ANOTHER replica (arm 2)', async () => {
    // The arm that survives scale-out. `liveByAttempt` is per-process, so with two
    // replicas a map-only check has replica A reaping replica B's live
    // conversations — a bug needing only a second replica, where the one it
    // replaced needed a >2h call.
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'remote-1', contact_id: 'c-remote', reserved_agent_id: 'sess-remote' }),
    ]);
    const ownerOf = vi.fn().mockResolvedValue('replica-B');

    const reaped = await new AgencyReaper(noDeps({ ownerOf })).sweepOnce();

    expect(ownerOf).toHaveBeenCalledWith('sess-remote');
    expect(repos.attempt.reapByIds).not.toHaveBeenCalled();
    expect(reaped).toBe(0);
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });

  it('reaps when the agent is held by NOBODY — §6.2s actual rule', async () => {
    // "non-terminal and owned by a replica whose heartbeat is gone". A null owner
    // is that clause: the ownership key has lapsed, so no replica is renewing it.
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'dead-1', contact_id: 'c-dead', reserved_agent_id: 'sess-dead' }),
    ]);
    repos.attempt.reapByIds.mockResolvedValue([{ id: 'dead-1', contact_id: 'c-dead' }]);

    expect(await new AgencyReaper(noDeps()).sweepOnce()).toBe(1);
    expect(repos.attempt.reapByIds).toHaveBeenCalledWith(['dead-1']);
  });

  it('fails CLOSED when ownership cannot be resolved', async () => {
    // Redis down. Reaping on an unreadable answer means hanging up on live
    // customers and returning their contacts to be dialed again, every minute,
    // for the duration of the incident. A leaked attempt surviving until Redis
    // recovers is the cheaper error by a wide margin.
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'x-1', contact_id: 'c-x', reserved_agent_id: 'sess-x' }),
    ]);
    const ownerOf = vi.fn().mockRejectedValue(new Error('redis down'));

    expect(await new AgencyReaper(noDeps({ ownerOf })).sweepOnce()).toBe(0);
    expect(repos.attempt.reapByIds).not.toHaveBeenCalled();
  });

  it('trusts the guarded UPDATE, not its own SELECT, for what was reaped', async () => {
    // The residual race: an attempt settles normally between the SELECT and the
    // UPDATE. `reapByIds` re-checks `state`, writes nothing, and returns nothing —
    // so no contact is requeued for a call that in fact just connected. §5.3's
    // exactly-one-writer rule, enforced rather than hoped for.
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'raced-1', contact_id: 'c-raced' }),
    ]);
    repos.attempt.reapByIds.mockResolvedValue([]); // the row was already terminal

    expect(await new AgencyReaper(noDeps()).sweepOnce()).toBe(0);
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });

  it('reads the live set BEFORE querying, so a settling attempt survives a cycle', async () => {
    // Ordering, not politeness. Read-after would let an attempt registered between
    // the query and the check be reaped; read-before can only ever be over-
    // cautious by one cycle, and the row it spares is already terminal by then.
    const order: string[] = [];
    const activeAttemptIds = vi.fn(() => { order.push('live-set'); return []; });
    repos.attempt.findNonTerminalOlderThan.mockImplementation(async () => {
      order.push('query'); return [];
    });

    await new AgencyReaper(noDeps({ activeAttemptIds })).sweepOnce();
    expect(order).toEqual(['live-set', 'query']);
  });

  it('does not touch agent sessions on a periodic sweep', async () => {
    // A running process has live sockets; marking them offline would log out every
    // working agent once a minute.
    await new AgencyReaper(noDeps()).sweepOnce();
    expect(repos.session.markAllOffline).not.toHaveBeenCalled();
  });

  it('leaves 30 healthy concurrent calls entirely alone — acceptance (c)', async () => {
    const live = Array.from({ length: 30 }, (_, i) => `att-${i}`);
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue(
      live.map((id, i) => attemptRow({ id, contact_id: `c-${i}`, reserved_agent_id: `sess-${i}` })),
    );

    const reaper = new AgencyReaper(noDeps({ activeAttemptIds: () => live }));
    // Two cycles: acceptance (a) allows a leak two cycles to be caught, so a
    // healthy call must survive at least that many.
    expect(await reaper.sweepOnce()).toBe(0);
    expect(await reaper.sweepOnce()).toBe(0);
    expect(repos.attempt.reapByIds).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });

  it('picks the 3 leaked out of 33 without disturbing the other 30', async () => {
    const live = Array.from({ length: 30 }, (_, i) => `att-${i}`);
    const leaked = ['leak-a', 'leak-b', 'leak-c'];
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      ...live.map((id, i) => attemptRow({ id, contact_id: `c-${i}` })),
      ...leaked.map((id) => attemptRow({ id, contact_id: `c-${id}` })),
    ]);
    repos.attempt.reapByIds.mockImplementation(async (ids: string[]) =>
      ids.map((id) => ({ id, contact_id: `c-${id}` })));

    expect(await new AgencyReaper(noDeps({ activeAttemptIds: () => live })).sweepOnce()).toBe(3);
    expect(repos.attempt.reapByIds).toHaveBeenCalledWith(leaked);
  });

  it('requeues WITHOUT consuming the contact retry allowance', async () => {
    // A product decision, not an oversight: our crash must not spend the
    // customer's retries. With `max_attempts: 3`, three core restarts would
    // otherwise exhaust a contact and mark them `exhausted` having never been
    // spoken to — silent contact loss behind a plausible-looking audit trail.
    repos.attempt.reapNonTerminal.mockResolvedValue([
      { id: 'att-1', contact_id: 'c1' }, { id: 'att-2', contact_id: 'c2' },
    ]);
    await new AgencyReaper(noDeps()).reapOnStartup();

    expect(repos.contact.markState).toHaveBeenCalledTimes(2);
    for (const call of repos.contact.markState.mock.calls) {
      expect(call[1]).toBe('pending');
      expect(call[2]).not.toHaveProperty('bump_attempt');
      expect(call[2]).toMatchObject({ last_outcome: 'orphaned' });
    }
  });

  it('applies the same accounting on the periodic sweep, not just at boot', async () => {
    // The scope trap: an in-process leak with no crash goes through `sweepOnce`,
    // and a fix applied only to the startup path leaves the leak path broken —
    // the path that fires without anybody restarting anything.
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([attemptRow({ id: 'att-9', contact_id: 'c9' })]);
    repos.attempt.reapByIds.mockResolvedValue([{ id: 'att-9', contact_id: 'c9' }]);

    await new AgencyReaper(noDeps()).sweepOnce();

    expect(repos.contact.markState).toHaveBeenCalledTimes(1);
    expect(repos.contact.markState.mock.calls[0]![2]).not.toHaveProperty('bump_attempt');
  });

  it('start/stop is idempotent and holds no handle open', () => {
    const reaper = new AgencyReaper(noDeps());
    reaper.start();
    reaper.start();
    expect(() => reaper.stop()).not.toThrow();
    expect(() => reaper.stop()).not.toThrow();
  });

  it('runs both sweeps per tick, and one failing does not skip the other', async () => {
    vi.useFakeTimers();
    try {
      repos.attempt.findNonTerminalOlderThan.mockRejectedValue(new Error('leak sweep exploded'));
      const reaper = new AgencyReaper(noDeps());
      reaper.start();
      await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);

      // A failing leak sweep silently disabling the auto-disposition sweep is how
      // the 5pm-laptop case comes back — with the reaper looking like it is running.
      expect(repos.attempt.findNonTerminalOlderThan).toHaveBeenCalled();
      expect(repos.attempt.findLapsedWrapups).toHaveBeenCalled();
      reaper.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ═══ PART B — the deferred-hangup window, against the real bridge ═══════════

class StationSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly frames: any[] = [];
  send(s: string): void { try { this.frames.push(JSON.parse(s)); } catch { /* media */ } }
  close(): void { this.drop(); }
  drop(): void { this.readyState = 3; this.emit('close'); }
}
class PstnSocket extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  send(): void { /* carrier media sink */ }
  close(): void { this.readyState = 3; }
}

/** Minimal in-memory Redis: enough for the state machine and the ownership key. */
class MiniRedis {
  private readonly hashes = new Map<string, Record<string, string>>();
  private readonly strings = new Map<string, string>();

  /**
   * `ioredis`'s Lua entry point, NOT JavaScript's `eval` — this is a method named
   * `eval` on a test double, and the script text is matched with `includes()` and
   * never executed. Interpreting the three agent-state scripts by shape is enough
   * for their semantics here. Same double as `presence-resilience.test.ts`.
   */
  async eval(script: string, _n: number, key: string, ...argv: string[]): Promise<number> {
    const h = this.hashes.get(key);
    if (script.includes('EXISTS')) return !h ? 0 : (h.state === argv[0] ? 1 : 0);
    if (script.includes('HGET')) {
      if (!h || h.state !== argv[0]) return 0;
      this.hashes.set(key, { state: argv[1]!, attempt: argv[2] ?? '' });
      return 1;
    }
    this.hashes.set(key, { state: argv[0]!, attempt: argv[1] ?? '' });
    return 1;
  }
  async hgetall(key: string) { return this.hashes.get(key) ?? {}; }
  async set(key: string, value: string) { this.strings.set(key, value); return 'OK' as const; }
  async get(key: string) { return this.strings.get(key) ?? null; }
  async del(key: string) { this.hashes.delete(key); return this.strings.delete(key) ? 1 : 0; }
}

const CAMPAIGN = {
  id: 'camp-1', name: 'Q3 Renewals', tenant_id: 't1', account_id: 'a1',
  // PORT NOTE: VoBiz and SIP are deleted (plan §5) — the campaign dials VoiceLink and
  // carries no `sip_connection_id`.
  telephony_provider: 'voicelink', record_calls: false,
  analysis_profile_id: null, caller_ids: ['+14155550100'],
  disposition_catalog: [], wrapup_seconds: 0, wrapup_auto_return: true,
  abandon_announcement_id: null, retry_policy: {},
} as any;

function makeCmd(): DialCommand {
  return {
    attemptId: 'att-grace', campaignId: 'camp-1', contactId: 'contact-1',
    sessionId: 's1', ownerReplica: 'r1', tenantId: 't1', accountId: 'a1',
    callerId: '+14155550100', attemptNumber: 1,
    campaign: CAMPAIGN,
    contact: { id: 'contact-1', phone_e164: '+919876543210', context: {}, attempt_count: 0 } as any,
  };
}

function fakeWrapup() {
  return {
    enter: vi.fn(async () => false), cancel: vi.fn(), force: vi.fn(async () => false),
    stateFor: vi.fn(() => null), noteDisposition: vi.fn(async () => false),
    stop: vi.fn(), active: vi.fn(() => 0),
  };
}

async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

describe('AgencyReaper vs the AD-P2-C-07 deferred-hangup window', () => {
  let world: {
    bridge: WebRtcBridgeManager; stations: StationRegistry; dialer: AgencyDialer;
    agents: AgentStateMachine;
  };
  let station: StationSocket;

  beforeEach(() => {
    mockWebrtcRepo.create.mockImplementation(async (i: any) => ({
      id: 'call-1', tenant_id: i.tenant_id, account_id: i.account_id,
      caller_id: i.caller_id, destination_phone: i.destination_phone,
      provider: i.provider, status: 'initiating', provider_call_id: null,
      created_at: new Date(), updated_at: new Date(),
    }));
    const redis = new MiniRedis();
    const callManager = {
      concurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
      accountConcurrencyGuard: { tryAcquire: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) },
      triggerDequeue: vi.fn(), wakeSelfHeal: vi.fn(),
    };
    const bridge = new WebRtcBridgeManager(callManager as any, redis as any);
    const stations = new StationRegistry(redis as any, '', 'r1');
    const agents = new AgentStateMachine(redis as any, '');
    const dialer = new AgencyDialer(bridge as any, stations, agents, fakeWrapup() as any, new BreakRegistry());
    dialer.start();
    world = { bridge, stations, dialer, agents };
    station = new StationSocket();
  });

  afterEach(() => {
    world.dialer.stop();
  });

  /** Dial, answer the carrier, then drop the agent's socket — arming the window. */
  async function intoGraceWindow() {
    await world.stations.attach({
      sessionId: 's1', campaignId: 'camp-1', tenantId: 't1', accountId: 'a1',
      agentUserId: 'user-1', ws: station as any,
    });
    // The reservation `executeDial` assumes — its lease-extension CAS aborts the
    // dial when it fails, and an unseeded agent has no state to CAS from.
    await world.agents.set('s1', 'reserved', {
      attemptId: 'att-grace',
      leaseMs: AGENT_LEASE_MS.reserved_predial,
    });
    await world.dialer.executeDial(makeCmd());
    // PORT NOTE: core answered with VoBiz, where the `<Stream>` connecting IS the
    // answer. On VoiceLink the media socket opens first and the carrier's `start`
    // frame is the answer (lane C's bridge, `handleProviderStart`), so it is sent.
    const pstn = new PstnSocket();
    world.bridge.attachPstnLeg('call-1', pstn as any);
    pstn.emit('message', JSON.stringify({
      event: 'start',
      start: { call_sid: 'carrier-1', stream_sid: 'st-1', media_format: { encoding: 'audio/alaw', sample_rate: '8000' } },
    }));
    await flush();

    // The agent's socket dies. This is the route's own close sequence: detach the
    // station FIRST (so "is this agent here?" answers truthfully), and do NOT
    // write them offline, because the drop is mid-attempt.
    station.drop();
    await world.stations.detach('s1', station as any);
    await flush();
  }

  it('the window really is armed, and the call really is bridgeless', async () => {
    await intoGraceWindow();
    const session = world.bridge.getSession('call-1');

    // Observed, not assumed — the premise every assertion below rests on. If the
    // window is not armed then this is an ordinary ended call and the rest of this
    // block proves nothing.
    expect(session?.browserLegGraceArmed, 'the deferred-hangup window is armed').toBe(true);
  });

  it('is invisible to station ownership — so arm 2 CANNOT protect it', async () => {
    await intoGraceWindow();

    // The agent's socket is gone, so `detach` deleted the Redis ownership key.
    // This is the fact that makes the mid-grace call the hardest instance of
    // acceptance (c): the multi-replica arm reads null here and would reap.
    expect(world.stations.isLocallyOwned('s1')).toBe(false);
    expect(await world.stations.ownerOf('s1')).toBeNull();
  });

  it('survives the sweep anyway, because the dialer still owns the attempt', async () => {
    await intoGraceWindow();
    // Aged past the floor, agent unowned: every filter except arm 1 says reap.
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'att-grace', contact_id: 'contact-1', reserved_agent_id: 's1', state: 'bridged' }),
    ]);

    const reaper = new AgencyReaper({
      activeAttemptIds: () => world.dialer.activeAttemptIds(),
      ownerOf: (id) => world.stations.ownerOf(id),
    });

    expect(world.dialer.activeAttemptIds()).toContain('att-grace');
    expect(await reaper.sweepOnce()).toBe(0);
    expect(repos.attempt.reapByIds).not.toHaveBeenCalled();
    // And the customer is still on a live call: nothing hung up the carrier leg
    // and nothing returned their contact to the roster to be dialed again.
    expect(repos.contact.markState).not.toHaveBeenCalledWith(
      'contact-1', 'pending', expect.anything(),
    );
  });

  it('reaps the same attempt once the window has actually lapsed', async () => {
    // The negative control. Without it, "survives the sweep" is satisfied by a
    // reaper that never reaps anything at all.
    //
    // Fake timers are installed BEFORE the window is armed, not after: a timer
    // scheduled under real timers is not controllable by a clock installed later,
    // and the first version of this test advanced 30s against an already-real
    // timer and concluded the window never lapses. `setImmediate` is left REAL so
    // `flush()` still drains the async teardown the expiry kicks off.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await intoGraceWindow();
      // Past DEFERRED_HANGUP_MS (8s): the call ends, the lifecycle handler settles
      // it, and the dialer drops the attempt.
      await vi.advanceTimersByTimeAsync(30_000);
      // PORT NOTE: on VoiceLink an ANSWERED call's local hangup waits in `ending`
      // for the carrier's `call.ended` (VoBiz finalized at once), so the carrier's
      // confirmation is driven here — the same step lane C's bridge suites drive.
      await world.bridge.handleVoicelinkStatus('call-1', {
        providerCallId: 'carrier-1', callId: 'call-1', eventType: 'hangup', timestamp: new Date(),
        metadata: { event: 'call.ended', call: { id: 'carrier-1', status: 'ended' } },
      } as any);
      await flush();
    } finally {
      vi.useRealTimers();
    }

    expect(world.dialer.activeAttemptIds()).not.toContain('att-grace');

    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'att-grace', contact_id: 'contact-1', reserved_agent_id: 's1' }),
    ]);
    repos.attempt.reapByIds.mockResolvedValue([{ id: 'att-grace', contact_id: 'contact-1' }]);

    const reaper = new AgencyReaper({
      activeAttemptIds: () => world.dialer.activeAttemptIds(),
      ownerOf: (id) => world.stations.ownerOf(id),
    });
    expect(await reaper.sweepOnce()).toBe(1);
  });
});

// ═══ PART C — the no_disposition sweep ═════════════════════════════════════

describe('AgencyReaper auto-disposition sweep', () => {
  it('stamps no_disposition on a conversation nobody wrote up', async () => {
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({
        id: 'att-1', contact_id: 'c1', outcome: 'connected',
        campaign_disposition_catalog: [{ code: 'sale', label: 'Sale' }],
      }),
    ]);

    expect(await new AgencyReaper(noDeps()).sweepLapsedWrapups()).toBe(1);

    // The shared constant, never a second literal: `dispositionRefusal` has to
    // recognise this exact code as "auto-closed" rather than "you already did
    // this", which is a different message to a different person.
    expect(repos.attempt.recordAutoDisposition).toHaveBeenCalledWith('att-1', AUTO_DISPOSITION_CODE);
    expect(AUTO_DISPOSITION_CODE).toBe('no_disposition');
  });

  it('releases the contact from `connected` — the actual harm being repaired', async () => {
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({
        id: 'att-1', contact_id: 'c1', outcome: 'connected',
        campaign_disposition_catalog: [{ code: 'sale' }],
      }),
    ]);

    await new AgencyReaper(noDeps()).sweepLapsedWrapups();

    // Nothing else in the system releases a contact from `connected` — the
    // disposition route is the only other path out. Without this the contact is
    // parked forever and the campaign can never reach `completed`.
    expect(repos.contact.markState).toHaveBeenCalledWith('c1', 'completed', expect.objectContaining({
      last_outcome: 'connected',
      last_disposition: AUTO_DISPOSITION_CODE,
    }));
  });

  it('does NOT bump the attempt count', async () => {
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({ id: 'att-1', contact_id: 'c1', outcome: 'connected', campaign_disposition_catalog: [{ code: 's' }] }),
    ]);
    await new AgencyReaper(noDeps()).sweepLapsedWrapups();

    // The attempt was counted when it ended. Bumping here charges a contact twice
    // for one dial and, at `max_attempts: 3`, exhausts someone after two real
    // conversations — the same reason the disposition route does not bump.
    expect(repos.contact.markState.mock.calls[0]![2]).not.toHaveProperty('bump_attempt');
  });

  it('writes NO disposition when the campaign never asked for one', async () => {
    // `requiresDisposition` is false for an empty catalog, so nothing was owed.
    // But such a campaign's contacts still park in `connected`, so they need the
    // same rescue — and stamping `no_disposition` on them would record an agent's
    // failure to do something nobody asked of them, and would poison the Phase 3
    // retry decision that reads the code.
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({ id: 'att-1', contact_id: 'c1', outcome: 'connected', campaign_disposition_catalog: [] }),
    ]);

    expect(await new AgencyReaper(noDeps()).sweepLapsedWrapups()).toBe(1);

    expect(repos.attempt.recordAutoDisposition).not.toHaveBeenCalled();
    expect(repos.contact.markState).toHaveBeenCalledWith('c1', 'completed', expect.anything());
    expect(repos.contact.markState.mock.calls[0]![2]).not.toHaveProperty('last_disposition');
  });

  it('passes the campaign catalog explicitly — never lets it default to undefined', async () => {
    // `requiresDisposition(outcome, undefined)` returns TRUE. A null column read
    // as `undefined` would therefore auto-disposition every campaign, including
    // the ones that never wanted a disposition at all. The direction of that
    // default is the trap, and it is invisible unless asserted on a null.
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({ id: 'att-1', contact_id: 'c1', outcome: 'connected', campaign_disposition_catalog: null }),
    ]);

    await new AgencyReaper(noDeps()).sweepLapsedWrapups();

    expect(repos.attempt.recordAutoDisposition).not.toHaveBeenCalled();
    expect(repos.contact.markState).toHaveBeenCalledWith('c1', 'completed', expect.anything());
  });

  it('never dispositions an outcome that required none', async () => {
    // Hazard (c). `requiresDisposition` is false for anything but `connected`, so
    // a no-answer must be released without a code even if a stale row reaches the
    // sweep — a rang-out call has nothing to write up and never will.
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({
        id: 'att-1', contact_id: 'c1', outcome: 'no_answer',
        campaign_disposition_catalog: [{ code: 'sale' }],
      }),
    ]);

    await new AgencyReaper(noDeps()).sweepLapsedWrapups();
    expect(repos.attempt.recordAutoDisposition).not.toHaveBeenCalled();
  });

  it('loses the race to an agent who submitted their real disposition', async () => {
    // The guarded UPDATE returns null when `disposition_code` is no longer NULL.
    // The agent's record of what was said to a customer stands, and the route has
    // already released the contact — so there is nothing here to repair.
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({ id: 'att-1', contact_id: 'c1', outcome: 'connected', campaign_disposition_catalog: [{ code: 's' }] }),
    ]);
    repos.attempt.recordAutoDisposition.mockResolvedValue(null);

    expect(await new AgencyReaper(noDeps()).sweepLapsedWrapups()).toBe(0);
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });

  it('evaluates the contact against the campaign OWN retry policy — acceptance (b)', async () => {
    // §2.4: with no disposition recorded, the outcome policy decides. Phase 2's
    // answer is a no-op, but the seam must receive the campaign's real policy and
    // the attempt's real outcome — a seam handed `{}` is discovered only on the
    // day Phase 3 starts reading it (§16.6 q2: true where CONSUMED).
    const policy = { connected: { max_attempts: 0 }, no_answer: { delay_minutes: 60, max_attempts: 3 } };
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({
        id: 'att-1', contact_id: 'c1', outcome: 'connected',
        campaign_disposition_catalog: [{ code: 'sale' }], campaign_retry_policy: policy,
        contact_attempt_count: 2,
      }),
    ]);

    await new AgencyReaper(noDeps()).sweepLapsedWrapups();

    expect(retrySpy).toHaveBeenCalledTimes(1);
    // The 4th argument is `attemptsUsed`, and **2 rather than 3 is the assertion**.
    // This path does not bump the budget — the attempt was charged when it ended —
    // so it must forward the stored count verbatim. The dial path is the mirror
    // image: it bumps and forwards the post-bump value. Getting this backwards in
    // either direction silently moves `max_attempts` by one, which on a
    // compliance-sensitive dialer is an extra call to a customer who was already
    // out of retries.
    expect(retrySpy).toHaveBeenCalledWith(policy, 'connected', expect.any(Date), 2);
  });

  it('asks for a grace longer than the sweep interval', async () => {
    await new AgencyReaper(noDeps()).sweepLapsedWrapups();

    const graceSeconds = repos.attempt.findLapsedWrapups.mock.calls[0]![0] as number;
    expect(graceSeconds).toBe(EXPECTED_WRAPUP_GRACE_SECONDS);
    // Below one tick, a disposition landing in the same minute as expiry races the
    // sweep for the row. The guarded UPDATE makes that safe, but the agent would
    // still lose their write-up about half the time.
    expect(graceSeconds * 1000).toBeGreaterThan(SWEEP_INTERVAL_MS);
  });

  it('keeps going when one row fails to close', async () => {
    repos.attempt.findLapsedWrapups.mockResolvedValue([
      attemptRow({ id: 'att-1', contact_id: 'c1', outcome: 'connected', campaign_disposition_catalog: [{ code: 's' }] }),
      attemptRow({ id: 'att-2', contact_id: 'c2', outcome: 'connected', campaign_disposition_catalog: [{ code: 's' }] }),
    ]);
    repos.contact.markState.mockRejectedValueOnce(new Error('db blip'));

    // One stuck contact must not leave the rest stranded — the sweep is the only
    // thing that will ever come back for them.
    expect(await new AgencyReaper(noDeps()).sweepLapsedWrapups()).toBe(2);
    expect(repos.contact.markState).toHaveBeenCalledTimes(2);
  });

  it('is a quiet no-op when nothing has lapsed', async () => {
    expect(await new AgencyReaper(noDeps()).sweepLapsedWrapups()).toBe(0);
    expect(repos.attempt.recordAutoDisposition).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// `agency_our_fault_retirement_total{outcome="orphaned"}` — the reaper's own
// producer of a permanent contact retirement.
//
// Added after review, which made the point by falsification: **disabling these
// two lines broke no test.** That is the same hole this workstream already found
// on the dialer's producer, one module over.
//
// The series matters because of what an increment MEANS: a real person removed
// from a campaign for good because our replica crashed or leaked an attempt —
// §11's "invisible in every view", which this counter exists to end. A metric
// that quietly stops, or that fires when nobody was retired, is worse than no
// metric, because the dashboard's own description tells an operator to page on it.
// ===========================================================================
describe('the reaper as a producer of our-fault retirements', () => {
  /** Read one label set off the real meter provider. */
  async function retirementCount(outcome: string): Promise<number> {
    const points = await collectMetric(reader, 'agency_our_fault_retirement_total');
    return points.find((p) =>
      p.attributes.outcome === outcome
      && p.attributes.tenant_id === 'ten-1'
      && p.attributes.campaign_id === 'camp-1')?.value ?? 0;
  }

  /** A leaked attempt whose contact is already at the our-fault bound. */
  function boundedLeak() {
    repos.contact.chargeOurFaultAttempt.mockResolvedValue(3);
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'leak-1', contact_id: 'c-leak', tenant_id: 'ten-1', campaign_id: 'camp-1' }),
    ]);
    repos.attempt.reapByIds.mockResolvedValue([
      { id: 'leak-1', contact_id: 'c-leak', tenant_id: 'ten-1', campaign_id: 'camp-1' },
    ]);
  }

  it('counts an orphaned retirement, labelled and attributed to the campaign', async () => {
    const before = await retirementCount('orphaned');
    boundedLeak();

    await new AgencyReaper(noDeps()).sweepOnce();

    // The contact really was retired — not requeued `pending`.
    expect(repos.contact.markState).toHaveBeenCalledWith(
      'c-leak', 'exhausted', expect.anything(),
    );
    expect(
      await retirementCount('orphaned') - before,
      'the reaper retired a contact and nothing counted it',
    ).toBe(1);
  });

  it('labels the reaper`s retirements `orphaned`, never the dial site`s causes', async () => {
    // The split is the whole operational value: `agent_disconnected`/`canceled`
    // point at agent workstations and our teardown paths, `orphaned` at replica
    // crashes and leaks — an infrastructure signal that arrives in bursts after a
    // restart rather than as a trickle. Collapsing them would send an operator
    // hunting wifi drops after a deploy.
    const beforeCanceled = await retirementCount('canceled');
    boundedLeak();

    await new AgencyReaper(noDeps()).sweepOnce();

    expect(await retirementCount('canceled') - beforeCanceled).toBe(0);
  });

  it('counts NOTHING when `markState` resolved but REFUSED the transition', async () => {
    /**
     * The hole `.then(() => true)` left, and the reason that idiom was wrong.
     *
     * `markState` does not throw when its DNC guard refuses: the row stays
     * `suppressed`, the statement succeeds, and only a WARN line records it. This
     * method's own comment already notes a DNC'd contact can be sitting here — so
     * crash recovery colliding with a mid-call DNC was reporting a retirement
     * this ledger never made, against a series the dashboard says to page on.
     */
    const before = await retirementCount('orphaned');
    boundedLeak();
    repos.contact.markState.mockResolvedValueOnce(false);

    await new AgencyReaper(noDeps()).sweepOnce();

    expect(repos.contact.markState).toHaveBeenCalled();
    expect(
      await retirementCount('orphaned') - before,
      'a refused transition was counted as a permanent retirement',
    ).toBe(0);
  });

  it('counts nothing when the retirement write REJECTED', async () => {
    const before = await retirementCount('orphaned');
    boundedLeak();
    repos.contact.markState.mockRejectedValueOnce(new Error('pool exhausted'));

    await new AgencyReaper(noDeps()).sweepOnce();

    expect(await retirementCount('orphaned') - before).toBe(0);
  });

  it('counts nothing while the contact is still inside the bound', async () => {
    // The control. Below the bound the contact goes back on the roster, and a
    // counter firing here would make every crash-recovery requeue look like a
    // permanent loss of a customer.
    const before = await retirementCount('orphaned');
    repos.contact.chargeOurFaultAttempt.mockResolvedValue(1);
    repos.attempt.findNonTerminalOlderThan.mockResolvedValue([
      attemptRow({ id: 'leak-1', contact_id: 'c-leak', tenant_id: 'ten-1', campaign_id: 'camp-1' }),
    ]);
    repos.attempt.reapByIds.mockResolvedValue([
      { id: 'leak-1', contact_id: 'c-leak', tenant_id: 'ten-1', campaign_id: 'camp-1' },
    ]);

    await new AgencyReaper(noDeps()).sweepOnce();

    expect(repos.contact.markState).toHaveBeenCalledWith(
      'c-leak', 'pending', expect.anything(),
    );
    expect(await retirementCount('orphaned') - before).toBe(0);
  });
});
