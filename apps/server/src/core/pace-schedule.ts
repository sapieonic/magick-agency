/**
 * The frame-release schedule shared by both pacers (ClickUp 14ygtkj860a, C1).
 *
 * WHY THIS IS ITS OWN MODULE. `PacedAudioStreamer` (pull-based: it owns a buffer
 * and a loop) and `PacedFrameQueue` (push-based: audio arrives from a live model
 * and it owns a timer) are the same clock problem wearing two different shapes.
 * Both have to answer "may I release a frame yet, and if not, how long until I
 * may?" — and both have to answer it the way the streamer already did, because
 * the way it does it is load-bearing:
 *
 *  - **Anchor-relative, not incremental.** The slot for the next frame is
 *    `anchor + n * frameMs`, never `lastSendTime + frameMs`. A per-frame
 *    `sleep(frameMs)` compounds every scheduling hiccup into permanent drift; an
 *    anchored schedule absorbs one and self-corrects on the next frame. Here that
 *    is expressed as a running `nextAt` that advances by exactly `frameMs` per
 *    released frame regardless of when the frame actually went out, which is
 *    arithmetically identical to `anchor + n * frameMs` and cheaper to read.
 *
 *  - **Re-anchoring after a hold is not the same as catching up.** When release
 *    was suspended — backpressure on the streamer, an interruption-confirmation
 *    pause on the queue — the slots that elapsed during the hold are gone, not
 *    owed. Resuming against the original anchor would fire a run of zero-delay
 *    releases to "catch up", which re-floods the very jitter buffer the hold was
 *    protecting. {@link PaceSchedule.reanchor} drops the debt instead.
 *
 * DELIBERATELY PURE AND IMPORT-FREE. Every method takes `now` rather than
 * reading a clock, so the schedule has no notion of wall time, no I/O and no
 * imports at all — the same discipline `playout-clock.ts` and
 * `credential-seam.ts` follow, for the reason recorded in docs/reference/magic-voice-core/CLAUDE.md: a module
 * that reads `src/config/index.js` drags in a module body that can
 * `process.exit(1)`, which passes locally and kills the suite in CI. It is also
 * what makes the streamer's refactor onto this class provably behaviour-
 * preserving: there is nothing in here that can disagree with the caller about
 * what time it is.
 */
export class PaceSchedule {
  /** Epoch (ms, caller's clock) at which the next frame may be released. */
  private nextAt = 0;

  private readonly frameMs: number;

  /**
   * A non-positive period is a programmer error and throws, as it always has.
   *
   * A NON-FINITE one deliberately does not, and the asymmetry is not fastidious.
   * `PacedAudioStreamer.stream()` is documented never to throw — it runs on the
   * media hot path from un-awaited callers — and it builds its schedule INSIDE
   * that promise, while its own construction guard (`opts.frameMs <= 0`) is
   * `false` for `NaN`. So a throw here for a NaN period would reject a
   * never-throws path for a value that, before the schedule was extracted, simply
   * blasted. Degrading to a zero-length period reproduces that blast exactly:
   * every slot is already due, so {@link delayUntilNext} is never positive and
   * release is immediate and un-paced — which is the only honest meaning of an
   * un-paceable frame period. (`PacedFrameQueue` rejects a non-finite `frameMs`
   * in its own constructor, before it ever gets here, so this costs it nothing.)
   */
  constructor(frameMs: number) {
    if (Number.isFinite(frameMs)) {
      if (frameMs <= 0) throw new Error('frameMs must be positive');
      this.frameMs = frameMs;
    } else {
      this.frameMs = 0;
    }
  }

  /** Real-time span one frame represents, in ms. */
  get framePeriodMs(): number {
    return this.frameMs;
  }

  /** The epoch the next frame is due. Meaningless before {@link start}. */
  get nextSlotAt(): number {
    return this.nextAt;
  }

  /**
   * Open the schedule: the first frame is due immediately at `now`.
   *
   * Zero added latency on the first frame is deliberate and is the property both
   * pacers depend on — the cadence exists to stop us running AHEAD of real time,
   * never to hold the first frame back.
   */
  start(now: number): void {
    this.nextAt = now;
  }

  /**
   * How long until the next frame may be released, in ms.
   *
   * Positive: wait that long. Zero or negative: release now — and the magnitude
   * of a negative value is how LATE we are, which is the underrun signal both
   * pacers report on (`-delay > frameMs * 1.5`, i.e. more than about a frame and
   * a half behind schedule).
   */
  delayUntilNext(now: number): number {
    return this.nextAt - now;
  }

  /**
   * Account for a released frame: the next slot moves on by exactly one frame
   * period from the SCHEDULED slot, not from now. This is the self-correction —
   * a frame that shipped 7 ms late does not push the whole rest of the stream
   * 7 ms later.
   */
  noteSent(): void {
    this.nextAt += this.frameMs;
  }

  /**
   * Restart the cadence from `now`: the next frame is due immediately and the
   * one after it a frame period later.
   *
   * Called after any interval in which release was suspended (backpressure,
   * pause, a lead-filling burst). See the module header: the elapsed slots are
   * dropped rather than owed, so there is no catch-up burst.
   */
  reanchor(now: number): void {
    this.nextAt = now;
  }
}
