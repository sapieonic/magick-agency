import { useRepaintTick } from './useRepaintTick';
import { correctedInstant, elapsedSince, remainingUntil } from '../utils/agencyClock';

/**
 * The server-corrected clock (§A.13.10; acceptance criterion (b) — *matches the
 * server's timer within a second and does not drift over a shift*).
 *
 * `agencyClock.ts` has the estimator and the pure arithmetic; `useRepaintTick` has
 * the 250ms repaint and the `visibilitychange` recompute. This is the piece that
 * joins them, and it exists so that **no component has to hold the offset and the
 * present in its head at the same time.**
 *
 * ── Why it hands back bound helpers rather than a number ─────────────────────
 * The rule "no component may call `Date.now()` directly" is unenforceable as
 * written — it is a habit, and habits lapse under deadline. What is enforceable is
 * making the corrected form the *convenient* one: a component that wants a
 * remaining time calls `clock.remainingUntil(endsAt)` and cannot forget to pass
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
   * Client-clock ms, re-read on every repaint. Exposed for comparisons that are
   * genuinely against local time (a datetime picker's value is in the agent's own
   * clock, not the server's) — **not** as a substitute for the helpers below.
   */
  now: number;
  /** A server instant in client ms, or null if absent/unparseable. */
  corrected: (instant: string | number | null | undefined) => number | null;
  /** Ms since a server anchor, floored at zero. The talk timer and break elapsed. */
  since: (anchor: string | number | null | undefined) => number | null;
  /** Ms until a server deadline, **clamped at zero**. The wrap-up countdown. */
  until: (deadline: string | number | null | undefined) => number | null;
}

/**
 * @param offsetMs  from `useAgencyStation().clockOffsetMs`.
 * @param enabled   gate the interval when nothing on screen is counting. It gates
 *                  the *timer*, never the render — a hook that stopped returning a
 *                  value would change the DOM shape and could itself cost focus.
 */
export function useServerClock(offsetMs: number, enabled = true): ServerClock {
  // The tick's value is deliberately unused: it is a render trigger, and reading
  // it as a time would be the accumulator this whole module exists to avoid.
  useRepaintTick(enabled);

  const now = Date.now();

  return {
    offsetMs,
    now,
    corrected: (instant) => correctedInstant(instant, offsetMs),
    since: (anchor) => elapsedSince(anchor, offsetMs, now),
    until: (deadline) => remainingUntil(deadline, offsetMs, now),
  };
}
