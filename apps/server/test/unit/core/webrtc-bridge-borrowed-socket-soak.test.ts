import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// The default provider is VoiceLink; every attempt here is unanswered, so its hangup
// finalizes at once. Each attempt ends via `forceEndWithOutcome(`att-${i}`, 'ended_by_user')`
// (a `localHangup` under that outcome).

// ---------------------------------------------------------------------------
// The borrowed-socket contract at SHIFT SCALE.
//
// `webrtc-bridge-manager.bridged.test.ts` already pins the contract at the bar
// the design proposed: "three sequential calls over one station socket". That
// bar cannot falsify the leak it targets. Node does not emit
// `MaxListenersExceededWarning` until the 11th listener on one event, so a
// per-attempt leak of one listener per event needs 11 attempts before it is even
// observable — three passes cleanly against a socket that is quietly filling up.
// An 8-hour shift is ~300 attempts at 1.6 min/call, and that is the real load.
//
// Two things here are deliberately different from the existing file, and both
// are load-bearing:
//
//  1. The socket is a REAL `EventEmitter`. The existing fake keeps handlers in a
//     plain object, so it can never emit the warning that IS the symptom — the
//     one signal a leak gives you in production. A real emitter can.
//  2. Listener counts are asserted as a SERIES, not just at the end, so a
//     failure names the cycle the growth started at rather than reporting a big
//     number 300 attempts later.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {
      vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' },
      voicelink: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/voicelink' },
    },
  },
}));

const { mockRepo } = vi.hoisted(() => ({
  mockRepo: {
    create: vi.fn(),
    findById: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/agency-call.repository', () => ({
  webrtcCallRepository: mockRepo,
}));

const { mockAccountSettings } = vi.hoisted(() => ({
  mockAccountSettings: {
    getAllowRecording: vi.fn().mockResolvedValue(null),
    getWebrtcMaxDurationSeconds: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('@magick-agency/db/repositories/account-settings.repository', () => ({
  accountSettingsRepository: mockAccountSettings,
}));

const { mockAdapter } = vi.hoisted(() => ({
  mockAdapter: {
    initiateCall: vi.fn().mockResolvedValue({ providerCallId: 'pcid-1' }),
    endCall: vi.fn().mockResolvedValue(undefined),
    generateAnswerResponse: vi.fn().mockReturnValue('<Response><Stream/></Response>'),
  },
}));
vi.mock('../../../src/telephony/factory.js', () => ({
  TelephonyProviderRegistry: class {
    get() { return mockAdapter; }
  },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
vi.mock('../../../src/analytics/posthog.js', () => ({
  trackWebrtcCallInitiated: vi.fn(),
  trackWebrtcCallRejected: vi.fn(),
  trackWebrtcCallCompleted: vi.fn(),
}));

import { WebRtcBridgeManager } from '../../../src/core/webrtc-bridge-manager.js';

/** A station socket backed by a real EventEmitter, so Node's own warning fires. */
class RealEmitterStation extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  readonly sent: unknown[] = [];
  closeCalls = 0;
  send(s: string): void { this.sent.push(s); }
  close(): void { this.closeCalls++; this.readyState = 3; }
}

function makeCallManager() {
  return {
    concurrencyGuard: {
      tryAcquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    },
    accountConcurrencyGuard: {
      tryAcquire: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
    },
    triggerDequeue: vi.fn(),
    wakeSelfHeal: vi.fn(),
  };
}

const BRIDGED = {
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  campaignId: 'camp-1',
  agencyAttemptId: 'att-1',
};

/** ~8 hours at 1.6 min/call. The real load a station socket sees. */
const SHIFT_ATTEMPTS = 300;

let seq = 0;
let warnings: Error[] = [];
let warningListener: (w: Error) => void;

/**
 * Let Node deliver any pending `process.emitWarning` before reading the capture.
 *
 * Warnings are dispatched on `nextTick`, so reading `warnings` synchronously
 * after the code that triggered one always sees an empty array — a warning
 * assertion without this drain silently passes forever.
 */
async function drainWarnings(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  mockRepo.create.mockImplementation(async (i: any) => ({
    id: `call-${++seq}`,
    tenant_id: i.tenant_id,
    account_id: i.account_id,
    caller_id: i.caller_id,
    destination_phone: i.destination_phone,
    provider: i.provider,
    status: 'initiating',
    provider_call_id: null,
    answered_at: null,
    ended_at: null,
    duration_seconds: null,
    talk_time_seconds: null,
    campaign_id: i.campaign_id ?? null,
    agency_attempt_id: i.agency_attempt_id ?? null,
  }));
  mockAdapter.initiateCall.mockResolvedValue({ providerCallId: 'pcid-1' });

  warnings = [];
  warningListener = (w: Error) => { warnings.push(w); };
  process.on('warning', warningListener);
});

afterEach(() => {
  process.off('warning', warningListener);
});

describe('borrowed station socket — 8-hour shift soak', () => {
  it('survives 300 sequential attempts with a flat listener profile', async () => {
    const mgr = new WebRtcBridgeManager(makeCallManager() as any, null);
    const ws = new RealEmitterStation();

    // The station's own control-plane handler, registered once at shift start
    // and expected to outlive every attempt.
    const stationHandler = vi.fn();
    ws.on('message', stationHandler);

    const EVENTS = ['message', 'close', 'error'] as const;
    const midAttempt: Record<string, number>[] = [];
    const betweenAttempts: Record<string, number>[] = [];

    for (let i = 1; i <= SHIFT_ATTEMPTS; i++) {
      await mgr.createBridgedCall({
        ...BRIDGED,
        agencyAttemptId: `att-${i}`,
        browserSocket: ws as any,
      });
      midAttempt.push(Object.fromEntries(EVENTS.map((e) => [e, ws.listenerCount(e)])));

      // end the attempt via `localHangup` with the `ended_by_user` outcome.
      await mgr.forceEndWithOutcome(`att-${i}`, 'ended_by_user');
      betweenAttempts.push(Object.fromEntries(EVENTS.map((e) => [e, ws.listenerCount(e)])));

      // The socket is the agent's session. It must never be closed by the bridge.
      expect(ws.readyState, `socket closed at attempt ${i}`).toBe(1);
    }

    expect(seq).toBe(SHIFT_ATTEMPTS);
    expect(ws.closeCalls).toBe(0);

    // ── The series assertions ────────────────────────────────────────────
    // Every mid-attempt sample identical to the first, and every between-attempt
    // sample identical to the first. Growth shows up as the FIRST differing
    // index, which names the cycle it started at.
    const firstMid = midAttempt[0]!;
    const driftMid = midAttempt.findIndex(
      (s) => EVENTS.some((e) => s[e] !== firstMid[e]),
    );
    expect(
      driftMid,
      `mid-attempt listener count drifted at attempt ${driftMid + 1}: ` +
      `${JSON.stringify(midAttempt[driftMid])} vs ${JSON.stringify(firstMid)}`,
    ).toBe(-1);

    const firstBetween = betweenAttempts[0]!;
    const driftBetween = betweenAttempts.findIndex(
      (s) => EVENTS.some((e) => s[e] !== firstBetween[e]),
    );
    expect(
      driftBetween,
      `post-teardown listener count drifted at attempt ${driftBetween + 1}: ` +
      `${JSON.stringify(betweenAttempts[driftBetween])} vs ${JSON.stringify(firstBetween)}`,
    ).toBe(-1);

    // Between attempts, only the station's own handler remains.
    expect(firstBetween).toEqual({ message: 1, close: 0, error: 0 });

    // ── Node's own leak signal never fired ──────────────────────────
    // `process.emitWarning` dispatches on nextTick, so the capture MUST be
    // drained before it is read. Without this the assertion below is vacuous —
    // it reads an empty array and passes no matter what happened. the detector-proof case below is what
    // caught that, and is why it exists.
    await drainWarnings();
    const maxListenerWarnings = warnings.filter((w) => w.name === 'MaxListenersExceededWarning');
    expect(
      maxListenerWarnings.map((w) => w.message),
      'the bridge leaked listeners onto the borrowed socket',
    ).toEqual([]);

    // ── no session leak ────────────────────────────────────────────
    for (let i = 1; i <= SHIFT_ATTEMPTS; i++) {
      expect(mgr.getSession(`call-${i}`), `session call-${i} leaked`).toBeUndefined();
    }

    // ── The socket is still functionally the agent's, after all of it ─────
    ws.emit('message', 'still wired');
    expect(stationHandler).toHaveBeenCalledTimes(1);
    expect(ws.readyState).toBe(1);
  }, 60_000);

  it('the harness can actually observe a listener leak (detector proof)', async () => {
    // A soak test that has never failed for the right reason is unproven. This
    // deliberately leaks on the SAME emitter type and asserts the detector
    // fires — so a future refactor that neuters the warning capture (or swaps
    // the real emitter back for a plain object) fails here rather than making
    // the soak above silently vacuous.
    const ws = new RealEmitterStation();
    for (let i = 0; i < 12; i++) ws.on('message', () => { /* leak */ });

    await drainWarnings();
    const maxListenerWarnings = warnings.filter((w) => w.name === 'MaxListenersExceededWarning');
    expect(maxListenerWarnings.length).toBeGreaterThan(0);
    expect(ws.listenerCount('message')).toBe(12);
  });
});
