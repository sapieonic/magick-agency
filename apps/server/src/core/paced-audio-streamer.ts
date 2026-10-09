import { createChildLogger } from '@magick-agency/observability';
import { PaceSchedule } from './pace-schedule.js';

const log = createChildLogger({ component: 'paced-audio-streamer' });

/**
 * The WebSocket-ish sink a {@link PacedAudioStreamer} writes frames to. Kept
 * minimal (and injectable) so the pacer is testable without a real socket:
 *  - `send` writes one base64-encoded audio frame,
 *  - `sendRaw` (optional) writes the same frame as bytes, preferred when present,
 *  - `isOpen` gates writes (a closed leg aborts the stream promptly),
 *  - `bufferedAmount` drives backpressure (we hold off when the socket's own
 *    outbound buffer is backing up, so a slow consumer can't make us balloon).
 */
export interface PacedStreamSink {
  send(payloadBase64: string): void;
  /**
   * Byte-level alternative to {@link send}, used in preference to it when the
   * sink provides one.
   *
   * It exists for sinks that do not write to a socket directly but hand the frame
   * to something that needs the BYTES — an encoder or coalescer that operates on
   * a Buffer and base64s it itself. Going through `send` there would mean
   * base64-encoding every 20 ms frame only for the callee to immediately decode
   * it again, ~50 times a second per call.
   *
   * Optional, and the fallback is exact: a sink without it keeps the base64
   * contract. The bridge's clip sink (`WebRtcBridgeManager.makeClipSink`) does
   * not implement it.
   */
  sendRaw?(frame: Buffer): void;
  isOpen(): boolean;
  bufferedAmount(): number;
}

export interface PacedAudioStreamerOptions {
  /** Bytes per frame on the wire (e.g. 160 for A-law/8kHz @ 20ms). */
  frameBytes: number;
  /** Real-time span each frame represents, in ms (typically 20). */
  frameMs: number;
  /**
   * Backpressure ceiling: if the sink's `bufferedAmount()` exceeds this we pause
   * (sleep one frame) rather than pushing more, so a stalled consumer can't drive
   * unbounded memory growth on the send side. Default 64 KB (~8 s of A-law).
   */
  maxBufferedBytes?: number;
  /** Monotonic clock (ms). Injected for deterministic tests. Defaults to Date.now. */
  nowMs?: () => number;
  /** Sleep primitive. Injected for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called once per frame that ships late by more than a frame-and-a-half (i.e. a
   * pacing underrun — the event loop or backpressure fell behind real time). Lets
   * the caller record an observability metric.
   */
  onUnderrun?: () => void;
  /**
   * Absolute wall-clock budget for the whole `stream()` call, in ms (measured
   * against the same monotonic clock as `nowMs`). Once exceeded, `stream` returns
   * `'aborted'` at the next frame boundary regardless of backpressure — a
   * belt-and-suspenders guard so a carrier holding the socket open with a
   * perpetually-full send buffer can't loop forever and strand the call. Omit for
   * no deadline.
   */
  maxDurationMs?: number;
  /** Correlation id for logs only. */
  callId?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Streams a fully-materialized audio buffer to a telephony WebSocket in paced,
 * fixed-size real-time frames against a **monotonic clock** — the provider-neutral
 * part of clip playback over a carrier media socket.
 *
 * Why paced (not blasted): telephony media sockets expect ~20 ms frames arriving
 * at ~real time. Dumping the whole clip at once overruns the carrier's jitter
 * buffer (audio is dropped/garbled) and defeats prompt abort on remote hangup.
 *
 * The schedule is anchored to a wall-clock start and each frame's target is
 * `frameIndex * frameMs` from that anchor, so scheduling jitter self-corrects
 * (drift never accumulates) instead of compounding a per-frame `sleep(frameMs)`.
 * `abort()` stops promptly (checked every frame); a closed sink also aborts.
 *
 * That schedule lives in {@link PaceSchedule}: the anchor-relative targets and
 * the post-backpressure re-anchor, expressed as a running slot instead of an
 * anchor plus a frame count.
 */
export class PacedAudioStreamer {
  private aborted = false;
  private framesSent = 0;
  private readonly frameBytes: number;
  private readonly frameMs: number;
  private readonly maxBufferedBytes: number;
  private readonly maxDurationMs?: number;
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onUnderrun?: () => void;
  private readonly callId?: string;

  constructor(opts: PacedAudioStreamerOptions) {
    if (opts.frameBytes <= 0) throw new Error('frameBytes must be positive');
    if (opts.frameMs <= 0) throw new Error('frameMs must be positive');
    this.frameBytes = opts.frameBytes;
    this.frameMs = opts.frameMs;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 64000;
    if (opts.maxDurationMs !== undefined && opts.maxDurationMs > 0) this.maxDurationMs = opts.maxDurationMs;
    this.nowMs = opts.nowMs ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
    if (opts.onUnderrun) this.onUnderrun = opts.onUnderrun;
    if (opts.callId) this.callId = opts.callId;
  }

  /** Stop streaming at the next frame boundary. Idempotent. */
  abort(): void {
    this.aborted = true;
  }

  /** Number of frames actually written so far. */
  get sentFrames(): number {
    return this.framesSent;
  }

  /**
   * Stream `audio` frame-by-frame to `sink`. Resolves `'completed'` when the whole
   * buffer drained, or `'aborted'` if `abort()` was called or the sink closed
   * mid-stream. Never throws — a send error aborts.
   */
  async stream(audio: Buffer, sink: PacedStreamSink): Promise<'completed' | 'aborted'> {
    if (audio.length === 0) return 'completed';

    const startWall = this.nowMs();
    // Anchor the pacing schedule; re-anchored after a backpressure pause (below)
    // so a drained buffer doesn't trigger a catch-up burst.
    const schedule = new PaceSchedule(this.frameMs);
    schedule.start(startWall);
    const deadline = this.maxDurationMs !== undefined ? startWall + this.maxDurationMs : undefined;
    let offset = 0;

    while (offset < audio.length) {
      if (this.aborted || !sink.isOpen()) return 'aborted';
      // Absolute deadline: a stalled/backpressured socket can't loop forever.
      if (deadline !== undefined && this.nowMs() >= deadline) {
        log.warn({ callId: this.callId, framesSent: this.framesSent }, 'Paced audio stream hit max-duration deadline — aborting');
        return 'aborted';
      }

      // Backpressure: if the socket's own buffer is backing up, pause a frame and
      // re-check rather than piling on. Guards against a slow/stalled consumer.
      if (sink.bufferedAmount() > this.maxBufferedBytes) {
        await this.sleep(this.frameMs);
        // Re-anchor the schedule so post-pause frames pace forward from *now*
        // instead of bursting to "catch up" to a target that advanced during the
        // pause — which would re-flood the jitter buffer the backpressure pause
        // was protecting.
        schedule.reanchor(this.nowMs());
        continue;
      }

      const end = Math.min(offset + this.frameBytes, audio.length);
      const frame = audio.subarray(offset, end);
      offset = end;

      try {
        // Prefer the byte path when the sink offers one; `send` stays the
        // contract for every sink that doesn't (see `sendRaw`'s note).
        if (sink.sendRaw) sink.sendRaw(frame);
        else sink.send(frame.toString('base64'));
      } catch (err) {
        log.warn({ err, callId: this.callId }, 'Paced audio frame send failed — aborting');
        return 'aborted';
      }
      this.framesSent += 1;
      schedule.noteSent();

      // Monotonic pacing: sleep until this frame's scheduled wall-clock target
      // (relative to the — possibly re-anchored — schedule anchor).
      const delay = schedule.delayUntilNext(this.nowMs());
      if (delay > 0) {
        await this.sleep(delay);
      } else if (-delay > this.frameMs * 1.5 && offset < audio.length) {
        // We shipped this frame more than ~1.5 frames late — a pacing underrun.
        this.onUnderrun?.();
      }
    }

    return this.aborted || !sink.isOpen() ? 'aborted' : 'completed';
  }
}
