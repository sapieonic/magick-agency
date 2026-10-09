import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Self-contained harness (project convention: no shared test utilities).
// PacedAudioStreamer depends only on the logger (mocked).
// ---------------------------------------------------------------------------
vi.mock('@magick-agency/observability', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { PacedAudioStreamer, type PacedStreamSink } from '../../../src/core/paced-audio-streamer.js';

/**
 * Deterministic clock + sleep. `nowMs` is driven purely by the frames the pacer
 * asks to sleep for, so pacing is exact and reproducible (no wall-clock, no real
 * timers). Each sleep advances the virtual clock by exactly the requested ms.
 */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    nowMs: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => { now += ms; },
    setNow: (v: number) => { now = v; },
  };
}

function collectingSink(overrides: Partial<PacedStreamSink> = {}): PacedStreamSink & { frames: string[] } {
  const frames: string[] = [];
  return {
    frames,
    send: (p: string) => { frames.push(p); },
    isOpen: () => true,
    bufferedAmount: () => 0,
    ...overrides,
  };
}

describe('PacedAudioStreamer', () => {
  it('splits the buffer into EXACT fixed-size frames (A-law 8kHz 20ms = 160 bytes)', async () => {
    const clock = fakeClock();
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep });
    const sink = collectingSink();
    // 400 bytes → 2 full frames (160) + 1 partial (80).
    const audio = Buffer.alloc(400, 0x55);

    const result = await streamer.stream(audio, sink);

    expect(result).toBe('completed');
    expect(sink.frames.length).toBe(3);
    // Frame sizes in bytes (decode base64 back).
    const sizes = sink.frames.map((f) => Buffer.from(f, 'base64').length);
    expect(sizes).toEqual([160, 160, 80]);
  });

  it('paces against a monotonic clock: each frame targets index*frameMs, drift self-corrects', async () => {
    const clock = fakeClock();
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep });
    const sink = collectingSink();
    const audio = Buffer.alloc(160 * 5); // 5 frames

    await streamer.stream(audio, sink);

    // 5 frames → 5 sleeps of ~20ms each (last frame still sleeps to its target).
    expect(sink.frames.length).toBe(5);
    expect(clock.sleeps.length).toBe(5);
    for (const s of clock.sleeps) expect(s).toBeCloseTo(20, 5);
  });

  it('self-corrects accumulated drift instead of compounding per-frame sleeps', async () => {
    // Inject a clock that jumps 10ms of extra latency after the 1st frame's send;
    // the 2nd frame's sleep should be shortened to keep the schedule on target.
    let now = 0;
    const sleeps: number[] = [];
    let framesSent = 0;
    const sink: PacedStreamSink = {
      send: () => {
        framesSent++;
        if (framesSent === 1) now += 10; // event-loop hiccup after first send
      },
      isOpen: () => true,
      bufferedAmount: () => 0,
    };
    const streamer = new PacedAudioStreamer({
      frameBytes: 160, frameMs: 20,
      nowMs: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
    });
    await streamer.stream(Buffer.alloc(160 * 3), sink);

    // Frame1 target=20, elapsed=10 (hiccup) → sleep 10. Frame2 target=40,
    // after sleeping to 20 elapsed=20 → sleep 20. Frame3 target=60 → sleep 20.
    expect(sleeps[0]).toBeCloseTo(10, 5);
    expect(sleeps[1]).toBeCloseTo(20, 5);
    expect(sleeps[2]).toBeCloseTo(20, 5);
  });

  it('fires onUnderrun when a frame ships more than ~1.5 frames late', async () => {
    let now = 0;
    let sent = 0;
    const onUnderrun = vi.fn();
    const sink: PacedStreamSink = {
      send: () => { sent++; if (sent === 1) now += 200; }, // huge stall after frame 1
      isOpen: () => true,
      bufferedAmount: () => 0,
    };
    const streamer = new PacedAudioStreamer({
      frameBytes: 160, frameMs: 20,
      nowMs: () => now,
      sleep: async (ms) => { now += Math.max(0, ms); },
      onUnderrun,
    });
    await streamer.stream(Buffer.alloc(160 * 3), sink);
    expect(onUnderrun).toHaveBeenCalled();
  });

  it('aborts promptly on abort() and reports "aborted"', async () => {
    const clock = fakeClock();
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep });
    let sent = 0;
    const sink: PacedStreamSink = {
      send: () => { sent++; if (sent === 2) streamer.abort(); },
      isOpen: () => true,
      bufferedAmount: () => 0,
    };
    const result = await streamer.stream(Buffer.alloc(160 * 10), sink);
    expect(result).toBe('aborted');
    // Sent frame 1 and 2, then aborted before frame 3.
    expect(sent).toBe(2);
  });

  it('stops when the sink closes mid-stream (remote hangup)', async () => {
    const clock = fakeClock();
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep });
    let open = true;
    let sent = 0;
    const sink: PacedStreamSink = {
      send: () => { sent++; if (sent === 3) open = false; },
      isOpen: () => open,
      bufferedAmount: () => 0,
    };
    const result = await streamer.stream(Buffer.alloc(160 * 10), sink);
    expect(result).toBe('aborted');
    expect(sent).toBe(3);
  });

  it('applies backpressure: pauses (sleeps a frame) when bufferedAmount exceeds the cap', async () => {
    const clock = fakeClock();
    let buffered = 100000; // over the 64k default cap
    let sends = 0;
    const sink: PacedStreamSink = {
      send: () => { sends++; },
      isOpen: () => true,
      bufferedAmount: () => buffered,
    };
    // Drain the buffer after a couple of backpressure pauses so the stream can finish.
    let pauseCount = 0;
    const clockSleep = async (ms: number) => {
      await clock.sleep(ms);
      pauseCount++;
      if (pauseCount >= 2) buffered = 0; // pretend the socket drained
    };
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clockSleep });
    const result = await streamer.stream(Buffer.alloc(160), sink);
    expect(result).toBe('completed');
    expect(sends).toBe(1);
    expect(pauseCount).toBeGreaterThanOrEqual(2);
  });

  it('M4: does NOT burst-catch-up on resume from a backpressure pause', async () => {
    // 5 frames. bufferedAmount stays over the cap for several polls (wall-clock
    // advancing the whole time), then drops to 0. Post-pause frames must pace at
    // ~frameMs each — NOT a run of zero-delay "catch-up" sends that would re-flood
    // the jitter buffer the pause was protecting.
    const clock = fakeClock();
    let buffered = 100000; // over the 64k cap
    const sendSleeps: number[] = []; // sleeps recorded AFTER a frame actually shipped
    let sent = 0;
    const sink: PacedStreamSink = {
      send: () => { sent++; },
      isOpen: () => true,
      bufferedAmount: () => buffered,
    };
    let pausePolls = 0;
    const sleep = async (ms: number) => {
      // While backpressured (no frame sent yet in this poll cycle), simulate the
      // buffer staying full for 5 poll cycles (each advancing wall-clock 20ms).
      if (buffered > 0) {
        pausePolls++;
        clock.advance(ms);
        if (pausePolls >= 5) buffered = 0; // socket finally drains
        return;
      }
      sendSleeps.push(ms);
      clock.advance(ms);
    };
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep });
    const result = await streamer.stream(Buffer.alloc(160 * 5), sink);

    expect(result).toBe('completed');
    expect(sent).toBe(5);
    // Every post-send pacing sleep is ~frameMs (20ms) — no zero-delay burst.
    expect(sendSleeps.length).toBeGreaterThanOrEqual(4);
    for (const s of sendSleeps) expect(s).toBeCloseTo(20, 5);
  });

  it('M2: returns "aborted" once the absolute max-duration deadline is exceeded', async () => {
    const clock = fakeClock();
    // Big clip; deadline of 100ms. Each frame advances ~20ms, so we abort part-way.
    const streamer = new PacedAudioStreamer({
      frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep, maxDurationMs: 100,
    });
    const sink = collectingSink();
    const result = await streamer.stream(Buffer.alloc(160 * 1000), sink);
    expect(result).toBe('aborted');
    // Streamed some frames but nowhere near all 1000 — the deadline cut it off.
    expect(sink.frames.length).toBeGreaterThan(0);
    expect(sink.frames.length).toBeLessThan(20);
  });

  it('M4: aborts promptly during a backpressure pause when abort() is called', async () => {
    const clock = fakeClock();
    const buffered = 100000; // permanently over the cap
    const sink: PacedStreamSink = {
      send: () => { /* never reached while backpressured */ },
      isOpen: () => true,
      bufferedAmount: () => buffered,
    };
    let pauses = 0;
    const streamer = new PacedAudioStreamer({
      frameBytes: 160, frameMs: 20, nowMs: clock.nowMs,
      sleep: async (ms) => {
        clock.advance(ms);
        pauses++;
        if (pauses === 3) streamer.abort(); // abort mid-pause
      },
    });
    const result = await streamer.stream(Buffer.alloc(160 * 100), sink);
    expect(result).toBe('aborted');
    // Aborted shortly after the 3rd pause, not looping forever.
    expect(pauses).toBe(3);
  });

  it('empty buffer completes immediately with no frames', async () => {
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20 });
    const sink = collectingSink();
    const result = await streamer.stream(Buffer.alloc(0), sink);
    expect(result).toBe('completed');
    expect(sink.frames.length).toBe(0);
  });

  it('a send that throws aborts the stream (does not crash)', async () => {
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: () => 0, sleep: async () => {} });
    const sink: PacedStreamSink = {
      send: () => { throw new Error('socket exploded'); },
      isOpen: () => true,
      bufferedAmount: () => 0,
    };
    const result = await streamer.stream(Buffer.alloc(160), sink);
    expect(result).toBe('aborted');
  });

  // ── sendRaw: the byte path, preferred whenever the sink offers one ────────
  // `CallManager.makeIntroClipSink` hands frames to `sendAudioToTelephony`, which
  // takes BYTES and base64s them itself (or A-law-encodes them first). Routing
  // ~50 frames a second through base64 and straight back out again is pure waste,
  // and on the A-law path it is a decode the encoder immediately undoes.

  it('prefers sendRaw over send when the sink provides both, and passes Buffers', async () => {
    const clock = fakeClock();
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep });
    const raw: Buffer[] = [];
    const base64: string[] = [];
    const sink: PacedStreamSink = {
      send: (p: string) => { base64.push(p); },
      sendRaw: (f: Buffer) => { raw.push(Buffer.from(f)); },
      isOpen: () => true,
      bufferedAmount: () => 0,
    };

    const audio = Buffer.alloc(400, 0x77);
    const result = await streamer.stream(audio, sink);

    expect(result).toBe('completed');
    expect(base64).toHaveLength(0);
    expect(raw.map((f) => f.length)).toEqual([160, 160, 80]);
    expect(Buffer.concat(raw)).toEqual(audio);
    expect(streamer.sentFrames).toBe(3);
  });

  it('falls back to send, byte-identically, for a sink without sendRaw', async () => {
    const clock = fakeClock();
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: clock.nowMs, sleep: clock.sleep });
    const sink = collectingSink(); // no sendRaw — the original contract
    const audio = Buffer.alloc(400, 0x77);

    const result = await streamer.stream(audio, sink);

    expect(result).toBe('completed');
    expect(sink.frames).toHaveLength(3);
    expect(Buffer.concat(sink.frames.map((f) => Buffer.from(f, 'base64')))).toEqual(audio);
  });

  it('a sendRaw that throws aborts the stream, exactly as a throwing send does', async () => {
    const streamer = new PacedAudioStreamer({ frameBytes: 160, frameMs: 20, nowMs: () => 0, sleep: async () => {} });
    const sink: PacedStreamSink = {
      send: vi.fn(),
      sendRaw: () => { throw new Error('socket exploded'); },
      isOpen: () => true,
      bufferedAmount: () => 0,
    };

    expect(await streamer.stream(Buffer.alloc(160), sink)).toBe('aborted');
    // No silent fallback to `send` — the frame is gone, and pretending otherwise
    // would double-send every frame on a sink whose byte path is flaky.
    expect(sink.send).not.toHaveBeenCalled();
    expect(streamer.sentFrames).toBe(0);
  });
});
