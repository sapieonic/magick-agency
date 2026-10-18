import { useMemo } from 'react';
import { correctedInstant, elapsedSince, remainingUntil } from '../utils/agencyClock';

/**
 * The server-corrected clock (; acceptance criterion (b) — *matches the
 * server's timer within a second and does not drift over a shift*).
 *
 * `agencyClock.ts` has the estimator and the pure arithmetic; `useRepaintTick` has
 * the 250ms repaint and the `visibilitychange` recompute. This is the piece that
 * binds the offset to the arithmetic, and it exists so that **no component has to
 * hold the offset and the present in its head at the same time.**
 *
 * ── The repaint lives in the leaves, not here ────────────────────────────────
 * This hook used to run the repaint itself, and it was called at the console
 * root — so the whole console re-rendered four times a second for the whole
 * shift, offline included, to advance two timers and a chip row. The clock is now
 * a **stable object** (its identity moves only with the offset) whose helpers read
 * the present **when they are called**, and each counting leaf — the talk timer,
 * `WrapupTimer`, the callback chips, `RailPresenceRegion` — runs its own
 * `useRepaintTick` while it has something to advance. Stability is what lets a
 * callback hold the clock without rebuilding: `submit` reads `clock.now()` at fire
 * time rather than closing over a render's present.
 *
 * ── Why it hands back bound helpers rather than a number ─────────────────────
 * The rule "no component may call `Date.now()` directly" is unenforceable as
 * written — it is a habit, and habits lapse under deadline. What is enforceable is
 * making the corrected form the *convenient* one: a component that wants a
 * remaining time calls `clock.until(endsAt)` and cannot forget to pass
 * the offset, because there is nowhere to pass it. The raw `now` is exposed too
 * (the disposition form needs a present to compare a callback time against), but
 * every server instant goes through a helper that has the correction already
 * closed over.
 *
 * ── The repaint is a trigger, never a time source ────────────────────────────
 * Every value below is recomputed from an absolute anchor on each render.
 * Nothing accumulates, so there is nothing to drift — which is what makes "does
 * not drift over a shift" a property of the design rather than a hope. The classic
 * failure this replaces is `remaining -= 1` on a 1s interval: invisible over one
 * 30-second wrap-up, and exactly the named criterion failure over the two hundred
 * wrap-ups of a shift.
 */
export interface ServerClock {
  /**
   * The rolling median correction in ms, **subtracted** from a server instant to
   * express it in client time. Zero until the first `pong` sample lands.
   */
  offsetMs: number;
   /**
   * Client-clock ms, read **at call time**. Exposed for comparisons that are
   * genuinely against local time (a datetime picker's value is in the agent's own
   * clock, not the server's) — **not** as a substitute for the helpers below.
   *
   * A function rather than a number so it can never be a render's captured
   * instant: a value read off a render is stale the moment the render is.
   */
  now: () => number;
  /** A server instant in client ms, or null if absent/unparseable. */
  corrected: (instant: string | number | null | undefined) => number | null;
  /** Ms since a server anchor, floored at zero. The talk timer and break elapsed. */
  since: (anchor: string | number | null | undefined) => number | null;
  /** Ms until a server deadline, **clamped at zero**. The wrap-up countdown. */
  until: (deadline: string | number | null | undefined) => number | null;
}

/**
 * The clock for an offset, with the present read through `readNow`.
 *
 * Pure and exported so a test can hand a component a real `ServerClock` pinned to
 * an instant, rather than a hand-built stub that drifts from this shape.
 */
export function serverClock(
  offsetMs: number,
  // A lookup per call, not `= Date.now`: the global is read when the present is,
  // so a clock built before a test installs fake timers still obeys them.
  readNow: () => number = () => Date.now(),
): ServerClock {
  return {
    offsetMs,
    now: () => readNow(),
    corrected: (instant) => correctedInstant(instant, offsetMs),
    since: (anchor) => elapsedSince(anchor, offsetMs, readNow()),
    until: (deadline) => remainingUntil(deadline, offsetMs, readNow()),
  };
}

/**
 * @param offsetMs  from `useAgencyStation().clockOffsetMs`.
 *
 * The returned object keeps its identity until the offset moves, so it is safe in
 * a dependency list and in a memoized child's props.
 */
export function useServerClock(offsetMs: number): ServerClock {
  return useMemo(() => serverClock(offsetMs), [offsetMs]);
}
