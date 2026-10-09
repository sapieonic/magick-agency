import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Self-contained (project convention: no shared test utilities). PaceSchedule is
// deliberately import-free, so there is nothing to mock — which is the point:
// it can be reasoned about without a clock, a socket or a config module.
//
// The one import beyond it is `PacedAudioStreamer`, for the single case below
// that pins the streamer's never-throws contract against this class's
// construction guard. Its own suite is deliberately frozen (it is the evidence
// that extracting PaceSchedule preserved its behaviour), so the contract the
// extraction nearly broke is pinned from this side instead. It reaches the
// logger and nothing further — no config, no metrics — exactly as
// `paced-audio-streamer.test.ts` already does.
// ---------------------------------------------------------------------------
import { PaceSchedule } from '../../../src/core/pace-schedule.js';
import { PacedAudioStreamer, type PacedStreamSink } from '../../../src/core/paced-audio-streamer.js';

describe('PaceSchedule', () => {
  it('rejects a non-positive frame period at construction', () => {
    expect(() => new PaceSchedule(0)).toThrow(/frameMs/);
    expect(() => new PaceSchedule(-20)).toThrow(/frameMs/);
  });

  it('degrades a NON-FINITE frame period to "no cadence" instead of throwing', () => {
    // Deliberately not symmetric with the case above, and the asymmetry is the
    // streamer's never-throws contract: `PacedAudioStreamer` builds its schedule
    // INSIDE `stream()`, and its own guard (`frameMs <= 0`) is false for NaN — so
    // a throw here rejects a promise documented never to reject. A period that
    // cannot be paced against means no pacing: every slot is already due.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const s = new PaceSchedule(bad);
      s.start(0);
      expect(s.framePeriodMs).toBe(0);
      expect(s.delayUntilNext(0)).toBe(0);
      s.noteSent();
      // Still due immediately, and NOT NaN — a NaN slot would poison every
      // `delay > 0` comparison downstream rather than simply not pacing.
      expect(s.delayUntilNext(0)).toBe(0);
      s.noteSent();
      expect(s.nextSlotAt).toBe(0);
    }
  });

  // This one belongs to `PacedAudioStreamer`, but its own suite is the frozen
  // regression evidence that extracting `PaceSchedule` preserved its behaviour,
  // so the contract the extraction nearly broke is pinned here instead.
  it('keeps PacedAudioStreamer.stream() on its never-throws contract for a NaN frame period', async () => {
    const written: Buffer[] = [];
    const sink: PacedStreamSink = {
      send: (b64: string) => { written.push(Buffer.from(b64, 'base64')); },
      isOpen: () => true,
      bufferedAmount: () => 0,
    };
    const streamer = new PacedAudioStreamer({
      frameBytes: 160,
      frameMs: Number.NaN, // slips the streamer's own `frameMs <= 0` guard
      nowMs: () => 0,
      sleep: async () => {},
    });
    // Before the schedule learned to degrade, this REJECTED — a behaviour change
    // on a path whose whole contract is that it resolves, driven from callers
    // with no rejection handler above them.
    await expect(streamer.stream(Buffer.alloc(320, 7), sink)).resolves.toBe('completed');
    expect(Buffer.concat(written)).toEqual(Buffer.alloc(320, 7));
  });

  it('releases the first frame with ZERO added latency', () => {
    const s = new PaceSchedule(20);
    s.start(1_000);
    // The cadence exists to stop us running ahead of real time, never to hold the
    // first frame back. Any positive delay here would be latency the pacer added.
    expect(s.delayUntilNext(1_000)).toBe(0);
  });

  it('spaces slots exactly one frame period apart from the anchor', () => {
    const s = new PaceSchedule(20);
    s.start(0);
    for (let i = 0; i < 5; i++) {
      expect(s.delayUntilNext(i * 20)).toBe(0);
      s.noteSent();
    }
    expect(s.nextSlotAt).toBe(100);
    expect(s.delayUntilNext(90)).toBe(10);
  });

  it('self-corrects drift: a late frame does not push the whole schedule late', () => {
    const s = new PaceSchedule(20);
    s.start(0);
    // Frame 0 ships on time; frame 1 ships 7ms late (event-loop hiccup).
    s.noteSent();
    expect(s.delayUntilNext(27)).toBe(-7); // we are 7ms behind its slot
    s.noteSent();
    // The next slot is 40 — absolute — not 27+20. The 7ms is absorbed, not carried.
    expect(s.nextSlotAt).toBe(40);
    expect(s.delayUntilNext(27)).toBe(13);
  });

  it('a negative delay is exactly how late we are — the underrun signal', () => {
    const s = new PaceSchedule(20);
    s.start(0);
    s.noteSent();
    // 1.5 frames late is the threshold both pacers test against.
    expect(-s.delayUntilNext(20 + 31)).toBeGreaterThan(20 * 1.5);
    expect(-s.delayUntilNext(20 + 29)).toBeLessThan(20 * 1.5);
  });

  it('reanchor DROPS the slots lost to a hold instead of owing them back', () => {
    const s = new PaceSchedule(20);
    s.start(0);
    s.noteSent();
    s.noteSent();
    // 500ms hold (backpressure, or a confirmation pause). Against the original
    // anchor we would now be 460ms — 23 frames — "behind", and a pacer that
    // honoured that debt would fire 23 zero-delay releases and re-flood the very
    // jitter buffer the hold was protecting.
    expect(s.delayUntilNext(500)).toBe(-460);
    s.reanchor(500);
    expect(s.delayUntilNext(500)).toBe(0); // one frame now...
    s.noteSent();
    expect(s.delayUntilNext(500)).toBe(20); // ...and the next a full period later
  });

  it('start() re-opens the schedule from a fresh anchor', () => {
    const s = new PaceSchedule(20);
    s.start(0);
    s.noteSent();
    s.noteSent();
    s.start(9_000);
    expect(s.delayUntilNext(9_000)).toBe(0);
    expect(s.nextSlotAt).toBe(9_000);
  });

  it('exposes the frame period it was built with', () => {
    expect(new PaceSchedule(20).framePeriodMs).toBe(20);
  });

  it('is symmetric for a negative `now` — no special-casing of wall-clock zero', () => {
    const s = new PaceSchedule(20);
    s.start(-1_000);
    expect(s.delayUntilNext(-1_000)).toBe(0);
    s.noteSent();
    expect(s.nextSlotAt).toBe(-980);
    expect(s.delayUntilNext(-990)).toBe(10);
    expect(s.delayUntilNext(-970)).toBe(-10);
  });

  it('nextSlotAt defaults to 0 before start() is ever called', () => {
    // Not a documented contract to lean on, but it must be a finite, sane
    // number (never undefined/NaN) so a caller that ticks before starting
    // does not poison every downstream comparison.
    const s = new PaceSchedule(20);
    expect(s.nextSlotAt).toBe(0);
    expect(s.delayUntilNext(0)).toBe(0);
  });

  it('handles a degenerate sub-millisecond frame period without losing precision', () => {
    const s = new PaceSchedule(0.5);
    s.start(0);
    for (let i = 0; i < 10; i++) {
      expect(s.delayUntilNext(i * 0.5)).toBe(0);
      s.noteSent();
    }
    expect(s.nextSlotAt).toBe(5);
  });

  it('handles a degenerate huge frame period without overflowing to Infinity', () => {
    const huge = Number.MAX_SAFE_INTEGER / 2;
    const s = new PaceSchedule(huge);
    s.start(0);
    expect(s.delayUntilNext(0)).toBe(0);
    s.noteSent();
    expect(s.nextSlotAt).toBe(huge);
    expect(Number.isFinite(s.nextSlotAt)).toBe(true);
    expect(s.delayUntilNext(0)).toBe(huge);
  });

  it('is arithmetically identical to anchor + n*frameMs, the form it replaced', () => {
    // The streamer's original expression, kept here as the equivalence proof the
    // refactor rests on.
    const frameMs = 20;
    const s = new PaceSchedule(frameMs);
    const anchorStart = 1_234;
    s.start(anchorStart);
    let anchor = anchorStart;
    let framesSent = 0;
    let now = anchorStart;
    for (let i = 0; i < 25; i++) {
      now += i % 7; // ragged real-world lateness
      if (i === 11) {
        // the post-backpressure re-anchor, both ways
        anchor = now - framesSent * frameMs;
        s.reanchor(now);
      }
      framesSent += 1;
      s.noteSent();
      const original = framesSent * frameMs - (now - anchor);
      expect(s.delayUntilNext(now)).toBe(original);
    }
  });
});
