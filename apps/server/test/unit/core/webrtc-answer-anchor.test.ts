import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// `markAnswered()`'s RETURN contract — the signal `anchorAnswer` uses to emit the
// carrier-answer lifecycle observation exactly once.
//
// A separate file rather than an addition to webrtc-bridge-session.test.ts. That
// file already covers the *anchor* being
// first-write-wins; what is new here is the boolean it now returns, and the
// one-shot emission that depends on it.
//
// Why this matters: FOUR call sites in the manager anchor an answer (the carrier answer
// webhook, VoiceLink stream start, the normalized `answer` event, and the PSTN
// socket backstop), and on a real call several of them fire. An observer keyed on
// anything other than this return value emits once per site — which would mean
// several redundant DB writes per answered attempt, and an `answered` count that
// silently varies by carrier.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { WebRtcBridgeSession } from '../../../src/core/webrtc-bridge-session.js';

function makeSession() {
  return new WebRtcBridgeSession({
    callId: 'call-1',
    tenantId: 't1',
    accountId: 'a1',
    callerId: '+14155550100',
    destinationPhone: '+14155550199',
    provider: 'vobiz',
  });
}

describe('WebRtcBridgeSession.markAnswered return contract', () => {
  it('returns true only on the call that actually anchors', () => {
    const s = makeSession();
    expect(s.markAnswered()).toBe(true);
    expect(s.markAnswered()).toBe(false);
    expect(s.markAnswered()).toBe(false);
  });

  it('reports true exactly once across every anchoring site on one call', () => {
    // Simulates the real shape: four independent sites all anchoring the same call.
    const s = makeSession();
    const anchored = [
      s.markAnswered(), // carrier answer webhook
      s.markAnswered(), // PSTN socket backstop
      s.markAnswered(), // normalized `answer` event
      s.markAnswered(), // VoiceLink stream start
    ];
    expect(anchored.filter(Boolean)).toHaveLength(1);
    expect(anchored[0]).toBe(true);
  });

  it('still leaves the anchor itself first-write-wins', () => {
    // The return value is new; the anchor semantics must not have shifted with it.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-11T10:00:00.000Z'));
      const s = makeSession();
      s.markAnswered();
      const first = s.answeredAt;

      vi.advanceTimersByTime(30_000);
      expect(s.markAnswered()).toBe(false);
      expect(s.answeredAt).toBe(first);
      expect(s.answeredAt!.toISOString()).toBe('2026-08-11T10:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });
});
