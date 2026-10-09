import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Self-contained mock harness (project convention: no shared test utilities).
// WebRtcBridgeSession only depends on the logger (mocked) and a type-only import.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { WebRtcBridgeSession } from '../../../src/core/webrtc-bridge-session.js';

// ── Fake WebSocket ───────────────────────────────────────────────────────
// readyState semantics match the `ws` package: CONNECTING=0, OPEN=1, CLOSING=2, CLOSED=3
function fakeWs(readyState = 1) {
  return {
    readyState,
    OPEN: 1,
    closeCalls: 0,
    sent: [] as any[],
    send(s: string) { this.sent.push(s); },
    close() { this.closeCalls += 1; this.readyState = 3; },
  };
}

const PARAMS = {
  callId: 'call-1',
  tenantId: 't1',
  accountId: 'a1',
  callerId: '+14155550100',
  destinationPhone: '+14155550199',
  provider: 'vobiz',
};

function makeSession() {
  return new WebRtcBridgeSession({ ...PARAMS });
}

describe('WebRtcBridgeSession constructor + defaults', () => {
  it('stores the constructor params unchanged on readonly fields', () => {
    const s = makeSession();
    expect(s.callId).toBe('call-1');
    expect(s.tenantId).toBe('t1');
    expect(s.accountId).toBe('a1');
    expect(s.callerId).toBe('+14155550100');
    expect(s.destinationPhone).toBe('+14155550199');
    expect(s.provider).toBe('vobiz');
    expect(s.startedAt).toBeInstanceOf(Date);
  });

  it('initialises lifecycle defaults', () => {
    const s = makeSession();
    expect(s.status).toBe('initiating');
    expect(s.providerCallId).toBeNull();
    expect(s.answeredAt).toBeNull();
    expect(s.browserWs).toBeNull();
    expect(s.pstnWs).toBeNull();
    expect(s.concurrencyKey).toBeNull();
    expect(s.slotsHeld).toBe(false);
    expect(s.endHandled).toBe(false);
  });

  it('stamps startedAt at construction time', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-24T00:00:00.000Z'));
      const s = makeSession();
      expect(s.startedAt.toISOString()).toBe('2026-06-24T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WebRtcBridgeSession.markAnswered', () => {
  it('sets answeredAt on first call', () => {
    const s = makeSession();
    expect(s.answeredAt).toBeNull();
    s.markAnswered();
    expect(s.answeredAt).toBeInstanceOf(Date);
  });

  it('is first-write-wins — a second call does not move the anchor', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-24T00:00:00.000Z'));
      const s = makeSession();
      s.markAnswered();
      const firstAnchor = s.answeredAt;
      expect(firstAnchor).not.toBeNull();

      vi.advanceTimersByTime(10_000);
      s.markAnswered();
      expect(s.answeredAt).toBe(firstAnchor); // same Date instance, unchanged
      expect(s.answeredAt!.toISOString()).toBe('2026-06-24T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('WebRtcBridgeSession.getTalkTimeSeconds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns 0 before the call is answered (never billed for ring/dial)', () => {
    const s = makeSession();
    vi.advanceTimersByTime(30_000); // time passes but no answer
    expect(s.getTalkTimeSeconds()).toBe(0);
  });

  it('measures from answeredAt (not startedAt)', () => {
    vi.setSystemTime(new Date('2026-06-24T00:00:00.000Z'));
    const s = makeSession();
    // ring for 20s before answer — must NOT count toward talk time
    vi.advanceTimersByTime(20_000);
    s.markAnswered();
    // 15s of actual talk
    vi.advanceTimersByTime(15_000);
    expect(s.getTalkTimeSeconds()).toBe(15);
    expect(s.getDurationSeconds()).toBe(35); // duration counts ring + talk
  });

  it('rounds to whole seconds', () => {
    const s = makeSession();
    s.markAnswered();
    vi.advanceTimersByTime(2_600); // 2.6s rounds to 3
    expect(s.getTalkTimeSeconds()).toBe(3);
  });
});

describe('WebRtcBridgeSession.getDurationSeconds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('measures from session start regardless of answer', () => {
    const s = makeSession();
    vi.advanceTimersByTime(12_000);
    expect(s.getDurationSeconds()).toBe(12);
  });

  it('is 0 immediately at construction', () => {
    const s = makeSession();
    expect(s.getDurationSeconds()).toBe(0);
  });
});

describe('WebRtcBridgeSession.bothLegsConnected', () => {
  it('false when no sockets are set', () => {
    expect(makeSession().bothLegsConnected).toBe(false);
  });

  it('false with only the browser leg open', () => {
    const s = makeSession();
    s.browserWs = fakeWs(1) as any;
    expect(s.bothLegsConnected).toBe(false);
  });

  it('false with only the PSTN leg open', () => {
    const s = makeSession();
    s.pstnWs = fakeWs(1) as any;
    expect(s.bothLegsConnected).toBe(false);
  });

  it('true when both legs are open (readyState 1)', () => {
    const s = makeSession();
    s.browserWs = fakeWs(1) as any;
    s.pstnWs = fakeWs(1) as any;
    expect(s.bothLegsConnected).toBe(true);
  });

  it('false when browser leg is not open (e.g. CONNECTING/CLOSING)', () => {
    const s = makeSession();
    s.browserWs = fakeWs(0) as any;
    s.pstnWs = fakeWs(1) as any;
    expect(s.bothLegsConnected).toBe(false);
  });

  it('false when PSTN leg is closed (readyState 3)', () => {
    const s = makeSession();
    s.browserWs = fakeWs(1) as any;
    s.pstnWs = fakeWs(3) as any;
    expect(s.bothLegsConnected).toBe(false);
  });
});

describe('WebRtcBridgeSession max-duration timer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires the callback after seconds*1000 ms', () => {
    const s = makeSession();
    const cb = vi.fn();
    s.setMaxDurationTimer(5, cb);
    vi.advanceTimersByTime(4_999);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('clearMaxDurationTimer cancels a pending callback', () => {
    const s = makeSession();
    const cb = vi.fn();
    s.setMaxDurationTimer(5, cb);
    s.clearMaxDurationTimer();
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('clearMaxDurationTimer is safe to call with no timer armed', () => {
    const s = makeSession();
    expect(() => s.clearMaxDurationTimer()).not.toThrow();
    expect(() => s.clearMaxDurationTimer()).not.toThrow();
  });

  it('re-arming replaces the prior timer (only the latest fires)', () => {
    const s = makeSession();
    const first = vi.fn();
    const second = vi.fn();
    s.setMaxDurationTimer(5, first);
    s.setMaxDurationTimer(10, second);
    vi.advanceTimersByTime(5_000);
    expect(first).not.toHaveBeenCalled(); // superseded
    vi.advanceTimersByTime(5_000);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('leaks no real timers (fake timer count drains to zero)', () => {
    const s = makeSession();
    s.setMaxDurationTimer(30, vi.fn());
    expect(vi.getTimerCount()).toBe(1);
    s.clearMaxDurationTimer();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('WebRtcBridgeSession.destroy', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clears the max-duration timer', () => {
    const s = makeSession();
    const cb = vi.fn();
    s.setMaxDurationTimer(5, cb);
    s.destroy();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('closes both sockets when open and nulls them out', () => {
    const s = makeSession();
    const browser = fakeWs(1);
    const pstn = fakeWs(1);
    s.browserWs = browser as any;
    s.pstnWs = pstn as any;
    s.destroy();
    expect(browser.closeCalls).toBe(1);
    expect(pstn.closeCalls).toBe(1);
    expect(s.browserWs).toBeNull();
    expect(s.pstnWs).toBeNull();
  });

  it('does not close a socket that is already closed (readyState !== OPEN)', () => {
    const s = makeSession();
    const browser = fakeWs(3); // already closed
    s.browserWs = browser as any;
    s.destroy();
    expect(browser.closeCalls).toBe(0);
    expect(s.browserWs).toBeNull();
  });

  it('is safe when no sockets are attached', () => {
    const s = makeSession();
    expect(() => s.destroy()).not.toThrow();
    expect(s.browserWs).toBeNull();
    expect(s.pstnWs).toBeNull();
  });

  it('swallows a throwing close() and still nulls the socket', () => {
    const s = makeSession();
    const bad = {
      readyState: 1,
      OPEN: 1,
      close() { throw new Error('boom'); },
    };
    s.browserWs = bad as any;
    expect(() => s.destroy()).not.toThrow();
    expect(s.browserWs).toBeNull();
  });

  it('is idempotent — a second destroy is a no-op', () => {
    const s = makeSession();
    const browser = fakeWs(1);
    s.browserWs = browser as any;
    s.destroy();
    expect(browser.closeCalls).toBe(1);
    expect(() => s.destroy()).not.toThrow();
    expect(browser.closeCalls).toBe(1); // not re-closed (already nulled)
  });
});

// ── Borrowed browser leg ──────────────────
describe('WebRtcBridgeSession borrowed browser leg', () => {
  it('defaults to owning its browser socket', () => {
    expect(makeSession().browserWsOwned).toBe(true);
  });

  it('detaches — never closes — a borrowed socket at destroy, and still closes the PSTN leg', () => {
    const s = makeSession();
    const station = fakeWs(1);
    const pstn = fakeWs(1);
    const teardown = vi.fn();
    s.adoptBorrowedBrowserLeg(station as any);
    s.setBrowserLegTeardown(teardown);
    s.pstnWs = pstn as any;

    s.destroy();

    expect(station.closeCalls).toBe(0);   // the agent stays logged in
    expect(station.readyState).toBe(1);
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(pstn.closeCalls).toBe(1);      // the carrier leg IS ours
    expect(s.browserWs).toBeNull();
    expect(s.pstnWs).toBeNull();
  });

  it('runs the listener teardown exactly once across releaseBrowserLeg + destroy', () => {
    const s = makeSession();
    const teardown = vi.fn();
    s.adoptBorrowedBrowserLeg(fakeWs(1) as any);
    s.setBrowserLegTeardown(teardown);

    s.releaseBrowserLeg();
    s.releaseBrowserLeg();
    s.destroy();

    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing teardown so one bad detach cannot break call teardown', () => {
    const s = makeSession();
    s.adoptBorrowedBrowserLeg(fakeWs(1) as any);
    s.setBrowserLegTeardown(() => { throw new Error('boom'); });
    expect(() => s.destroy()).not.toThrow();
    expect(s.browserWs).toBeNull();
  });
});
