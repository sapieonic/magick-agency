import { correctedInstant, remainingUntil, formatDuration } from './agencyClock';
import type { AgencyWrapupHold, AgencyWrapupState } from '../types/agency';

/**
 * The wrap-up countdown (a lossless round trip).
 *
 * Pure, so the drift properties can be asserted against a fake clock that jumps
 * rather than by watching a bar. Everything here derives from the **absolute
 * `ends_at`** the wrap-up frame carries; nothing is reconstructed from a
 * duration and nothing accumulates.
 */

/**
 * Captured **once**, when the wrap-up frame arrives, and held for the life of
 * that wrap-up.
 *
 * The `totalMs` field is the reason this type exists. With an absolute deadline
 * the console is not handed a span, and the obvious move — recomputing
 * `total = deadline − now` on every repaint — produces a bar that never moves:
 * both terms shrink together, so it sits at 100% and then snaps to zero. That
 * reads as a frozen UI, it is easy to ship, and it survives casual review
 * because the digits beside it are counting down correctly the whole time.
 *
 * Nor may the span fall back to `bootstrap.wrapup_seconds`. If the two disagree,
 * `ends_at` is authoritative, and a bar scaled to the other value will not reach
 * zero when the digits do.
 */
export interface WrapupAnchor {
  attemptId: string;
  /** Deadline in **client** ms (already offset-corrected), or null if none. */
  deadlineMs: number | null;
  /** Span the bar is scaled against, captured at open. Null when there is no deadline. */
  totalMs: number | null;
  requiresDisposition: boolean;
  /**
   * Why the window is held. Set at entry for a timerless wrap-up.
   *
   * Typed as the hold union, which carries the server's
   * `supervisor_hold` as well as `'disposition_required'`.
   */
  heldReason: AgencyWrapupHold | null;
  /**
   * From the **frame**, never the campaign config. A timerless wrap-up reports
   * `false` even where the campaign sets auto-return true.
   */
  autoReturn: boolean;
}

/**
 * Builds the anchor from the frame. Call this **once per wrap-up**, on the frame.
 *
 * `ends_at: null` is legitimate and has **three** sources — auto-return off, a
 * timer that has lapsed into a hold, and the timerless `wrapup_seconds = 0`
 * case. In all three it means "no deadline; ends when the agent acts", never
 * "expired". It yields a null deadline and a null span, which renders as no bar
 * and no digits — not as a zero countdown, which would tell the agent they are
 * out of time when they are not.
 */
export function openWrapup(
  wrapup: AgencyWrapupState,
  offsetMs: number,
  now: number,
): WrapupAnchor {
  const deadlineMs = correctedInstant(wrapup.ends_at, offsetMs);
  return {
    attemptId: wrapup.attempt_id,
    deadlineMs,
    // Clamped at zero-or-null: a deadline already in the past when the frame
    // lands (a slow frame on a short window) has no span to animate, and a
    // negative span would invert the bar.
    totalMs: deadlineMs === null ? null : Math.max(0, deadlineMs - now) || null,
    requiresDisposition: wrapup.requires_disposition,
    heldReason: wrapup.held_reason ?? null,
    autoReturn: wrapup.auto_return,
  };
}

/**
 * Which wrap-up panel to render.
 *
 * - `counting` — a real deadline is running. Bar, digits, the lot.
 * - `held` — **no deadline; ends when you act.** One panel with one meaning for
 *   *all* sources of `ends_at: null`, deliberately **not** branched per source:
 *   the agent's next action is identical in every case, and three phrasings
 *   would be three chances to get one wrong.
 */
export type WrapupPanel = 'counting' | 'held';

export interface WrapupView {
  panel: WrapupPanel;
  /** Null ⇒ render no digits. Never a guessed value. */
  remainingMs: number | null;
  /** `m:ss`, or null when there are no digits to show. */
  label: string | null;
  /**
   * 0…1 when a bar should render, **null ⇒ render no bar element at all — not an
   * empty track.**
   *
   * A track that will never move again is a progress indicator for a process with
   * no progress, which is worse than absent: it reads as a countdown that has
   * stalled, so the agent waits for it instead of acting. The `held` panel
   * therefore has no bar geometry to preserve.
   *
   * Note the deliberate asymmetry with a countdown that has *reached* zero: there
   * the track stays (fraction `0`, not null), because a bar that actually ran
   * down to nothing is a true statement about a real timer.
   */
  fraction: number | null;
  /**
   * True while the window is open and waiting on the agent rather than on a
   * clock. The countdown does **not** count negative and never shows an overrun
   * readout.
   */
  holding: boolean;
}

/**
 * Recomputes the view from the anchor and the corrected present.
 *
 * **Called on every repaint, and derives everything from scratch.** The repaint
 * interval is a trigger, not a time source: nothing here reads a previous value,
 * so there is no accumulator to drift. This is what makes "does not drift over a
 * shift" a property of the design rather than a hope.
 */
export function wrapupView(
  anchor: WrapupAnchor,
  now: number,
  dispositionSubmitted: boolean,
): WrapupView {
  if (anchor.deadlineMs === null) {
    // The held panel. No deadline, so no digits and — by design — **no bar
    // and no empty track**.
    //
    // `holding` is true whenever the server named a reason at entry. That covers the
    // timerless `wrapup_seconds = 0` case, where no countdown could ever lapse
    // into a hold, so the reason has to arrive with the frame or the agent faces
    // a panel with no deadline, no timer, and nothing explaining why it is open.
    return {
      panel: 'held',
      remainingMs: null,
      label: null,
      fraction: null,
      holding: supervisorHeld(anchor) || (anchor.heldReason !== null && !dispositionSubmitted),
    };
  }

  const remainingMs = remainingUntil(anchor.deadlineMs, 0, now) ?? 0;
  const holding =
    supervisorHeld(anchor) ||
    (!dispositionSubmitted &&
      (anchor.heldReason !== null || (remainingMs === 0 && anchor.requiresDisposition)));

  return {
    // Still `counting` once it reaches zero: a timer that ran down is a different
    // thing from one that never existed, and the bar it drained keeps its track.
    panel: 'counting',
    remainingMs,
    label: formatDuration(remainingMs),
    fraction: anchor.totalMs && anchor.totalMs > 0 ? Math.min(1, remainingMs / anchor.totalMs) : 0,
    holding,
  };
}

/**
 * Whether there is a wrap-up at all.
 *
 * **A frame carrying `ends_at: null` and no frame are different states and must
 * not share a code path.** An earlier version of the spec said they were
 * indistinguishable and should be treated identically; that is now explicitly
 * false, and the distinction is structural here rather than a flag:
 *
 * - **A frame with `null`** produces a `WrapupAnchor` and the `held` panel — a
 *   real wrap-up that ends when the agent acts.
 * - **No frame** produces no anchor at all (`null`), and there is no wrap-up: the
 *   agent went straight back to the pool. The console must not render a pending
 *   wrap-up off a `released` that will never be followed by a wrap-up frame.
 *
 * Conflating them means either showing a wrap-up panel to an agent who is already
 * `available` and about to be reserved, or hiding a genuinely held window behind
 * a "waiting for the deadline" state that will never resolve.
 */
export function hasWrapup(anchor: WrapupAnchor | null): anchor is WrapupAnchor {
  return anchor !== null;
}

/**
 * The two countdown announcements, at 10s and 3s only (capped so the assertive region is not a metronome).
 *
 * Returns the threshold crossed on this repaint, or null. Crossing is computed
 * from the previous and current remaining values rather than from equality,
 * because a 250ms repaint will never land exactly on 10000ms.
 */
export function announcementThreshold(
  previousRemainingMs: number | null,
  remainingMs: number | null,
): 10 | 3 | null {
  if (previousRemainingMs === null || remainingMs === null) return null;
  for (const seconds of [10, 3] as const) {
    const boundary = seconds * 1000;
    if (previousRemainingMs > boundary && remainingMs <= boundary) return seconds;
  }
  return null;
}

/**
 * For the server's `supervisor_hold`.
 * Unlike `disposition_required`, a supervisor's hold is NOT the agent's to end:
 * submitting the disposition does not release it, so the panel keeps saying why
 * the agent is still out of the pool until the server sends the next wrap-up or state
 * frame. Treating it like the disposition hold would clear the reason the moment
 * the agent saved, and leave them on an unexplained open window — the "the app
 * has hung" reading the server's contract warns about.
 */
function supervisorHeld(anchor: WrapupAnchor): boolean {
  return anchor.heldReason === 'supervisor_hold';
}
