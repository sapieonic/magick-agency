import { useEffect, useState } from 'react';
import { AGENCY_DIAL_ACTIVITY_TIMING } from '../types/agency';
import type { AgencyDialActivity } from '../types/agency';

/**
 * How long "Dialling a customer…" stays up after a hidden dial ends unanswered: the contract's
 * `AGENCY_DIAL_ACTIVITY_TIMING.GAP_HOLD_MS`, which the agent app's `dialGapHold` is held to.
 *
 * The server sends the next dial's `dial_activity` about 0.3–2 s after the last one ended, so
 * without a hold the screen (and the rail, the station's status region, `aria-live="polite"`)
 * would flick to "Waiting for a call" and back between every pair of dials. Client-side only:
 * the server sends no frame for this.
 *
 * **It bridges a gap to the next dial, and only that.** When the agent's `queue` states nothing
 * due (a `strict` or `preferred` campaign whose last due contact just rang out: the server sends
 * `dial_activity{ringing: false}`, then `agent_state{available}`, then, from the next pacing
 * tick, `queue{due: false}`), no next dial is coming, so the hold ends there and "Nothing due
 * now" shows. A dial actually ringing still outranks the queue.
 *
 * **Accepted trade-off.** The hold covers the usual gap, not every gap. When the next dial comes
 * later than this (slow pacing, a concurrency or rate cap holding it back), the rail falls back
 * to "Waiting for a call" and a screen reader hears it, then "Dialling a customer…" again when
 * the next dial rings: one pair of announcements per dial at most, each of them true. A longer
 * hold would claim a dial that is not happening. The count line ("No answer from the last N
 * numbers") is deliberately not live, so it never adds to them.
 */
export const DIAL_GAP_HOLD_MS: number = AGENCY_DIAL_ACTIVITY_TIMING.GAP_HOLD_MS;

/** What the idle slot and the rail show for the hidden dials, or `null` for today's copy. */
export interface DialActivityDisplay {
  /** A hidden dial is ringing, or one ended under {@link DIAL_GAP_HOLD_MS} ago. */
  dialling: boolean;
  /** Hidden dials in a row that ended unanswered (the line under the headline when above 0). */
  unansweredInARow: number;
}

/**
 * The hidden dials as the station's idle slot shows them: `dial_activity` with the gap between
 * one dial and the next smoothed over.
 *
 * `eligible` is the slot's own condition — the agent is `available`, the campaign is dialling,
 * no attempt (or inbound call) is on screen and the socket is open. Outside it nothing is shown
 * and any hold is dropped at once, as it is when a `reserved` clears the activity or the next
 * dial starts ringing.
 *
 * `nothingDue`: the agent's queue states nothing due (`queue.due === false`). It ends a hold and
 * keeps one from starting, because then no next dial is coming; it never hides a dial that is
 * ringing.
 *
 * The hold starts in render, not in an effect: a hold set after commit would let one frame of
 * "Waiting for a call" reach the screen and the rail's live region between two dials, which is
 * the flicker this exists to remove. The effect only ends it.
 */
export function useDialActivityDisplay(
  activity: AgencyDialActivity | null,
  eligible: boolean,
  nothingDue: boolean,
): DialActivityDisplay | null {
  const shown = eligible && activity !== null;
  // Where a hold may run: the slot is shown and a next dial may yet come.
  const holdable = shown && !nothingDue;
  const [phase, setPhase] = useState<'ringing' | 'held' | 'quiet'>('quiet');

  // Ringing → not ringing with the agent still waiting, the activity still stated and nothing
  // saying no dial is due: the gap before the next dial, held. Any other change (a `reserved`,
  // leaving `available`, the campaign stopping, the queue stating nothing due) ends a hold
  // rather than starting one.
  let current = phase;
  if (shown && activity.ringing) current = 'ringing';
  else if (phase === 'ringing') current = holdable ? 'held' : 'quiet';
  else if (phase === 'held' && !holdable) current = 'quiet';
  if (current !== phase) setPhase(current);

  useEffect(() => {
    if (phase !== 'held') return;
    const timer = setTimeout(() => setPhase('quiet'), DIAL_GAP_HOLD_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!shown) return null;
  const dialling = current !== 'quiet';
  if (!dialling && activity.unanswered_in_a_row === 0) return null;
  return { dialling, unansweredInARow: activity.unanswered_in_a_row };
}
